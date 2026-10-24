/**
 * Per-backend usage guard: a small pure state machine (quota block, rolling daily cap, minimum
 * gap between sends, login/challenge flags) plus its on-disk persistence. Quota limits are
 * persisted so a server restart or another process never hammers a rate-limited account.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DRAW_BACKEND_IDS, type DrawBackendId, DrawError } from '@hsw-editor/draw';
import { type OwnerLock, acquireOwnerLock } from './owner-lock.ts';
import { SerialQueue } from '../serial-queue.ts';

export const DAY_MS = 86_400_000;
export const DEFAULT_QUOTA_BLOCK_MS = 3_600_000;
/** After login_required, re-check cheaply no sooner than this (a status probe clears it earlier). */
export const LOGIN_RECHECK_MS = 120_000;

export interface BackendGuard {
  /** Epoch ms of each prompt sent in the last 24 h. */
  readonly sends: readonly number[];
  /** Epoch ms until which the provider said "no more"; 0 when not blocked. */
  readonly blockedUntil: number;
  readonly blockReason: string;
  /** Epoch ms of the last login_required observation; 0 when logged in/unknown-good. */
  readonly loginRequiredAt: number;
  /** Epoch ms of the last captcha/human-verification wall; 0 when none. Only a human clears it. */
  readonly challengeAt: number;
  readonly lastOkAt: number;
}

export const EMPTY_GUARD: BackendGuard = {
  sends: [],
  blockedUntil: 0,
  blockReason: '',
  loginRequiredAt: 0,
  challengeAt: 0,
  lastOkAt: 0,
};

export interface GuardConfig {
  /** Minimum gap between two sends (human pacing). */
  readonly minIntervalMs: number;
  /** Hard cap of sends per rolling 24 h. */
  readonly dailyCap: number;
}

export type GateDecision =
  | { readonly kind: 'go'; readonly waitMs: number }
  | {
      readonly kind: 'blocked';
      readonly code: 'quota_exhausted' | 'login_required' | 'challenge';
      readonly message: string;
      readonly retryAfterMs?: number;
    };

function recentSends(guard: BackendGuard, now: number): number[] {
  return guard.sends.filter((t) => now - t < DAY_MS);
}

/** Decide whether `count` more sends may start now (and how long to wait first). */
export function gate(
  guard: BackendGuard,
  config: GuardConfig,
  now: number,
  count: number,
): GateDecision {
  if (guard.challengeAt > 0) {
    return {
      kind: 'blocked',
      code: 'challenge',
      message: 'human verification is pending; complete it in the dedicated browser first',
    };
  }
  if (guard.blockedUntil > now) {
    return {
      kind: 'blocked',
      code: 'quota_exhausted',
      message: guard.blockReason || 'quota block recorded earlier; not sending',
      retryAfterMs: guard.blockedUntil - now,
    };
  }
  if (guard.loginRequiredAt > 0 && now - guard.loginRequiredAt < LOGIN_RECHECK_MS) {
    return {
      kind: 'blocked',
      code: 'login_required',
      message: 'login required (recorded moments ago); log in, then re-check the status',
      retryAfterMs: LOGIN_RECHECK_MS - (now - guard.loginRequiredAt),
    };
  }
  const sends = recentSends(guard, now);
  if (sends.length + count > config.dailyCap) {
    const oldest = sends[0] ?? now;
    return {
      kind: 'blocked',
      code: 'quota_exhausted',
      message: `local daily cap ${config.dailyCap} would be exceeded`,
      retryAfterMs: Math.max(60_000, oldest + DAY_MS - now),
    };
  }
  const last = sends.at(-1) ?? 0;
  return { kind: 'go', waitMs: Math.max(0, last + config.minIntervalMs - now) };
}

export const recordSend = (g: BackendGuard, now: number): BackendGuard => ({
  ...g,
  sends: [...recentSends(g, now), now],
});

export const recordQuota = (
  g: BackendGuard,
  now: number,
  reason: string,
  retryAfterMs: number | undefined,
): BackendGuard => ({
  ...g,
  blockedUntil: now + Math.max(60_000, retryAfterMs ?? DEFAULT_QUOTA_BLOCK_MS),
  blockReason: reason.slice(0, 300),
});

export const recordLoginRequired = (g: BackendGuard, now: number): BackendGuard => ({
  ...g,
  loginRequiredAt: now,
});

export const recordChallenge = (g: BackendGuard, now: number): BackendGuard => ({
  ...g,
  challengeAt: now,
});

/** A positive probe/run proves the account is logged in and not behind a wall. */
export const recordHealthy = (g: BackendGuard, now: number): BackendGuard => ({
  ...g,
  loginRequiredAt: 0,
  challengeAt: 0,
  lastOkAt: now,
});

/** Map a draw failure onto the guard (the only place failure classes change persisted state). */
export function applyFailure(g: BackendGuard, error: DrawError, now: number): BackendGuard {
  switch (error.code) {
    case 'quota_exhausted':
      return recordQuota(g, now, error.message, error.extra.retryAfterMs);
    case 'login_required':
      return recordLoginRequired(g, now);
    case 'challenge':
      return recordChallenge(g, now);
    default:
      return g;
  }
}

export type GuardBook = Readonly<Record<DrawBackendId, BackendGuard>>;

export const EMPTY_BOOK: GuardBook = {
  'draw-cli': EMPTY_GUARD,
  omp: EMPTY_GUARD,
  'chatgpt-browser': EMPTY_GUARD,
  manual: EMPTY_GUARD,
};

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

function parseGuard(raw: unknown): BackendGuard {
  if (typeof raw !== 'object' || raw === null) return EMPTY_GUARD;
  const r = raw as Record<string, unknown>;
  return {
    sends: Array.isArray(r['sends'])
      ? r['sends'].filter((v): v is number => typeof v === 'number')
      : [],
    blockedUntil: num(r['blockedUntil']),
    blockReason: typeof r['blockReason'] === 'string' ? r['blockReason'] : '',
    loginRequiredAt: num(r['loginRequiredAt']),
    challengeAt: num(r['challengeAt']),
    lastOkAt: num(r['lastOkAt']),
  };
}

/** File-backed guard book. Every update re-reads the file so concurrent processes see each other. */
export class GuardStore {
  /** Serialises updates in this process; the lock file serialises them across processes. */
  private readonly queue = new SerialQueue();

  constructor(private readonly file: string) {}

  async load(): Promise<GuardBook> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, 'utf8'));
    } catch {
      return EMPTY_BOOK;
    }
    const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    const entries = DRAW_BACKEND_IDS.map((id) => [id, parseGuard(record[id])] as const);
    return Object.fromEntries(entries) as GuardBook; // keys are exactly DRAW_BACKEND_IDS
  }

  update(id: DrawBackendId, change: (g: BackendGuard) => BackendGuard): Promise<BackendGuard> {
    return this.queue.run(() => this.updateLocked(id, change));
  }

  private async updateLocked(
    id: DrawBackendId,
    change: (g: BackendGuard) => BackendGuard,
  ): Promise<BackendGuard> {
    const lock = await this.acquireFileLock();
    try {
      return await this.writeUpdate(id, change);
    } finally {
      await lock.release();
    }
  }

  private async acquireFileLock(): Promise<OwnerLock> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await acquireOwnerLock(`${this.file}.lock`, 'draw guard file');
      } catch (error) {
        if (attempt >= 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async writeUpdate(
    id: DrawBackendId,
    change: (g: BackendGuard) => BackendGuard,
  ): Promise<BackendGuard> {
    const book = await this.load();
    const next = change(book[id]);
    await mkdir(dirname(this.file), { recursive: true });
    const partial = `${this.file}.${process.pid}.part`;
    await writeFile(partial, JSON.stringify({ ...book, [id]: next }, null, 2), { mode: 0o600 });
    await rename(partial, this.file);
    return next;
  }

  async get(id: DrawBackendId): Promise<BackendGuard> {
    return (await this.load())[id];
  }
}
