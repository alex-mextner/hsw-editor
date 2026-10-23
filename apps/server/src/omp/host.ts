/**
 * Owns every omp session of the daemon: lookup by wall id, the global child cap, version probing,
 * and shutdown (graceful on request, best-effort kill from the process `exit` hook).
 */
import type { OmpSessionStatus } from '@hsw-editor/omp-protocol';
import type { OmpConfig } from './config.ts';
import { childEnv } from './config.ts';
import { OmpSession, type OmpClientPort, type SessionTimings } from './session.ts';
import type { ToolFactory } from './tool-types.ts';

/** Mirrors `ID_PATTERN` of packages/core: wall ids become directory names. */
const WALL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isValidWallId(id: string): boolean {
  return WALL_ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

export class OmpCapacityError extends Error {}

export interface OmpHostOptions {
  readonly config: OmpConfig;
  readonly createTools: ToolFactory;
  readonly timings?: SessionTimings;
  readonly log?: (message: string) => void;
}

export class OmpHost {
  readonly config: OmpConfig;
  readonly #options: OmpHostOptions;
  readonly #sessions = new Map<string, OmpSession>();
  #version: Promise<string | undefined> | null = null;
  #exitHook: (() => void) | null = null;

  constructor(options: OmpHostOptions) {
    this.#options = options;
    this.config = options.config;
  }

  /** `omp --version` once; undefined when omp cannot be run (the session then fails with a clear error). */
  ompVersion(): Promise<string | undefined> {
    this.#version ??= this.#probeVersion();
    return this.#version;
  }

  async #probeVersion(): Promise<string | undefined> {
    const [bin, ...prefix] = this.config.command;
    if (bin === undefined) return undefined;
    try {
      const proc = Bun.spawn([bin, ...prefix, '--version'], {
        env: childEnv(this.config),
        stdout: 'pipe',
        stderr: 'ignore',
      });
      const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      const text = await new Response(proc.stdout).text();
      clearTimeout(timer);
      const match = /(\d+\.\d+\.\d+)/.exec(text);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  session(wallId: string): OmpSession | undefined {
    return this.#sessions.get(wallId);
  }

  statuses(): OmpSessionStatus[] {
    return [...this.#sessions.values()].map((session) => session.status());
  }

  /** Attach a page to the wall's session, creating it (and starting its child) on demand. */
  async attach(wallId: string, port: OmpClientPort): Promise<OmpSession> {
    if (!isValidWallId(wallId)) throw new Error('invalid wall id');
    let session = this.#sessions.get(wallId);
    if (session === undefined) {
      await this.#ensureCapacity();
      session = new OmpSession({
        wallId,
        config: this.config,
        createTools: this.#options.createTools,
        ompVersion: () => this.ompVersion(),
        onDispose: (id) => this.#sessions.delete(id),
        ...(this.#options.timings ? { timings: this.#options.timings } : {}),
        ...(this.#options.log ? { log: this.#options.log } : {}),
      });
      this.#sessions.set(wallId, session);
    } else if (!session.hasChild && session.phase !== 'failed') {
      await this.#ensureCapacity();
    }
    session.attach(port);
    return session;
  }

  /** Stop the least recently useful child that nobody is watching, or refuse. */
  async #ensureCapacity(): Promise<void> {
    const live = [...this.#sessions.values()].filter((session) => session.hasChild);
    if (live.length < this.config.maxChildren) return;
    const evictable = live.find((session) => session.clientCount === 0 && !session.busy);
    if (evictable === undefined) {
      throw new OmpCapacityError(
        `at most ${this.config.maxChildren} omp sessions can run at once; close another wall's agent first`,
      );
    }
    await evictable.stop('evicted');
  }

  /** Graceful: close every child's stdin and wait for exit. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map((session) => session.stop('shutdown')));
    this.removeExitHook();
  }

  /** Last-resort: children must not outlive the daemon, whatever path ends the process. */
  installExitHook(): void {
    if (this.#exitHook !== null) return;
    this.#exitHook = () => {
      for (const session of this.#sessions.values()) session.killNow();
    };
    process.on('exit', this.#exitHook);
  }

  removeExitHook(): void {
    if (this.#exitHook !== null) process.off('exit', this.#exitHook);
    this.#exitHook = null;
  }
}
