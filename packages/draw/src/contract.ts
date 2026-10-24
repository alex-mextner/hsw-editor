/**
 * DrawBackend contract v1: the single interface behind the server's in-process backends, the
 * `hsw-editor draw run` CLI (one JSON document on stdin, one on stdout) and the draw-cli
 * `chatgpt-browser` backend. Pure TypeScript, no runtime dependencies.
 */

export const DRAW_BACKEND_IDS = ['draw-cli', 'omp', 'chatgpt-browser', 'manual'] as const;
export type DrawBackendId = (typeof DRAW_BACKEND_IDS)[number];

export const DRAW_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
export type DrawSize = (typeof DRAW_SIZES)[number];

export const DRAW_REF_ROLES = ['subject', 'style', 'view'] as const;
export type DrawRefRole = (typeof DRAW_REF_ROLES)[number];

export const MAX_PROMPT_CHARS = 8000;
export const MAX_REFS = 5;
export const MAX_N = 4;
export const DEFAULT_TIMEOUT_MS = 300_000;

export interface DrawRef {
  /** Absolute path to a local png/jpeg/webp. */
  readonly path: string;
  /** How the backend words the reference ("Image 1 is a subject image"). */
  readonly role?: DrawRefRole;
}

export interface DrawRequest {
  readonly version: 1;
  readonly prompt: string;
  readonly refs: readonly DrawRef[];
  /** Candidates wanted; backends run them sequentially, never in parallel. */
  readonly n: number;
  readonly size: DrawSize;
  /** Absolute directory written by the backend (created when missing). */
  readonly outDir: string;
  readonly timeoutMs?: number;
  /** Opaque caller correlation id (wall/object/view). */
  readonly tag?: string;
}

export type DrawMime = 'image/png' | 'image/jpeg' | 'image/webp';

export interface DrawImage {
  readonly path: string;
  readonly mime: DrawMime;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

export interface DrawSuccess {
  readonly ok: true;
  readonly backend: DrawBackendId;
  readonly tag?: string;
  readonly images: readonly DrawImage[];
  readonly meta: {
    readonly elapsedMs: number;
    readonly model?: string;
    readonly conversationUrl?: string;
  };
}

/** Stable failure classes; the editor maps each to one UI action. Exit codes are the CLI contract. */
export const DRAW_ERROR_EXIT_CODES = {
  invalid_request: 2,
  login_required: 3,
  quota_exhausted: 4,
  challenge: 5,
  timeout: 6,
  backend_unavailable: 7,
  refused: 8,
  manual_pending: 10,
} as const;
export type DrawErrorCode = keyof typeof DRAW_ERROR_EXIT_CODES;

export type DrawErrorDetail = Readonly<Record<string, string | number | boolean>>;

export interface DrawFailure {
  readonly ok: false;
  readonly backend: DrawBackendId;
  readonly tag?: string;
  readonly error: {
    readonly code: DrawErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    /** quota_exhausted: when the limit resets, if the provider said. */
    readonly retryAfterMs?: number;
    /** manual_pending: directory with prompt.txt, the refs and inbox/. */
    readonly jobDir?: string;
    /** Non-secret diagnostics (selector that missed, screenshot path). */
    readonly detail?: DrawErrorDetail;
  };
}

export type DrawResult = DrawSuccess | DrawFailure;

export interface DrawBackend {
  readonly id: DrawBackendId;
  draw(req: DrawRequest, signal: AbortSignal): Promise<DrawResult>;
}

export interface DrawErrorExtra {
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly jobDir?: string;
  readonly detail?: DrawErrorDetail;
}

export class DrawError extends Error {
  readonly code: DrawErrorCode;
  readonly extra: DrawErrorExtra;
  constructor(code: DrawErrorCode, message: string, extra: DrawErrorExtra = {}) {
    super(message);
    this.name = 'DrawError';
    this.code = code;
    this.extra = extra;
  }
}

export function toFailure(
  backend: DrawBackendId,
  tag: string | undefined,
  error: DrawError,
): DrawFailure {
  const { extra } = error;
  return {
    ok: false,
    backend,
    ...(tag === undefined ? {} : { tag }),
    error: {
      code: error.code,
      message: error.message,
      retryable: extra.retryable ?? (error.code === 'timeout' || error.code === 'quota_exhausted'),
      ...(extra.retryAfterMs === undefined ? {} : { retryAfterMs: extra.retryAfterMs }),
      ...(extra.jobDir === undefined ? {} : { jobDir: extra.jobDir }),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && list.some((item) => item === value);

/** Validate untrusted JSON into a DrawRequest, or throw DrawError('invalid_request'). */
export function parseDrawRequest(raw: unknown): DrawRequest {
  const bad = (message: string): never => {
    throw new DrawError('invalid_request', message, { retryable: false });
  };
  if (!isRecord(raw)) return bad('request must be a JSON object');
  if (raw['version'] !== 1) return bad('version must be 1');
  const prompt = raw['prompt'];
  if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_CHARS) {
    return bad(`prompt: non-empty string of at most ${MAX_PROMPT_CHARS} chars`);
  }
  const refsRaw = raw['refs'] ?? [];
  if (!Array.isArray(refsRaw) || refsRaw.length > MAX_REFS) {
    return bad(`refs: array of at most ${MAX_REFS}`);
  }
  const refs = refsRaw.map((ref: unknown, index): DrawRef => {
    if (!isRecord(ref)) return bad(`refs[${index}] must be an object`);
    const path = ref['path'];
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
      return bad(`refs[${index}].path must be an absolute path`);
    }
    const role = ref['role'];
    if (role === undefined) return { path };
    if (!isOneOf(DRAW_REF_ROLES, role)) return bad(`refs[${index}].role invalid`);
    return { path, role };
  });
  const n = raw['n'] ?? 1;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_N) {
    return bad(`n: integer 1..${MAX_N}`);
  }
  const size = raw['size'] ?? '1024x1024';
  if (!isOneOf(DRAW_SIZES, size)) return bad(`size: one of ${DRAW_SIZES.join(', ')}`);
  const outDir = raw['outDir'];
  if (typeof outDir !== 'string' || !outDir.startsWith('/') || outDir.includes('\0')) {
    return bad('outDir must be an absolute path');
  }
  const timeoutMs = raw['timeoutMs'];
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !(timeoutMs >= 5000 && timeoutMs <= 1_800_000))
  ) {
    return bad('timeoutMs: 5000..1800000');
  }
  const tag = raw['tag'];
  if (tag !== undefined && (typeof tag !== 'string' || tag.length > 128)) {
    return bad('tag: string of at most 128 chars');
  }
  return {
    version: 1,
    prompt,
    refs,
    n,
    size,
    outDir,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(tag === undefined ? {} : { tag }),
  };
}

export function parseBackendId(value: unknown): DrawBackendId {
  if (isOneOf(DRAW_BACKEND_IDS, value)) return value;
  throw new DrawError('invalid_request', `backend must be one of ${DRAW_BACKEND_IDS.join('|')}`, {
    retryable: false,
  });
}

/** What the UI shows per backend; `steps` are literal shell commands (not translated). */
export const DRAW_AVAILABILITY = [
  'ready',
  'login_required',
  'quota_exhausted',
  'challenge',
  'unavailable',
  'manual',
] as const;
export type DrawAvailability = (typeof DRAW_AVAILABILITY)[number];

export interface DrawBackendStatus {
  readonly id: DrawBackendId;
  readonly state: DrawAvailability;
  readonly message: string;
  /** Literal one-time commands the user must run when state is login_required/unavailable. */
  readonly steps: readonly string[];
  readonly retryAfterMs?: number;
  /** True only when the state came from a live check in this process or a recorded successful run. */
  readonly verified: boolean;
  readonly sendsLast24h: number;
  readonly dailyCap: number;
}

export const DRAW_BACKEND_CHOICES = ['auto', ...DRAW_BACKEND_IDS] as const;
export type DrawBackendChoice = (typeof DRAW_BACKEND_CHOICES)[number];

export interface DrawSettings {
  /** `auto` tries draw-cli, omp, chatgpt-browser, then manual (falling through only on login/unavailable). */
  readonly backend: DrawBackendChoice;
}

export const DEFAULT_DRAW_SETTINGS: DrawSettings = { backend: 'auto' };

export function parseDrawSettings(raw: unknown): DrawSettings {
  if (isRecord(raw)) {
    const backend = raw['backend'];
    if (isOneOf(DRAW_BACKEND_CHOICES, backend)) return { backend };
  }
  throw new DrawError(
    'invalid_request',
    `settings: { backend: ${DRAW_BACKEND_CHOICES.join('|')} }`,
    {
      retryable: false,
    },
  );
}
