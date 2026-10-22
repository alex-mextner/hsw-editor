/**
 * Classifies the errors the GLB / texture loaders throw, and spaces automatic retries. Pure: no React,
 * no three.js, so the formats below are pinned by unit tests instead of a WebGL context.
 *
 * Formats seen in the wild (see ticket #51):
 *   R3F useLoader:      `Could not load <url>: <inner message>`
 *   three FileLoader:   `fetch for "<url>" responded with <status>: <statusText>`
 *   browser fetch:      `Failed to fetch` / `NetworkError when attempting to fetch resource.` / `Load failed`
 */

export type LoadErrorKind = 'asset-missing' | 'network' | 'decode' | 'unknown';

export interface ClassifiedLoadError {
  readonly kind: LoadErrorKind;
  readonly url?: string;
  readonly status?: number;
}

const FETCH_RESPONDED = /fetch for "([^"]+)" responded with (\d{3})\b/;
const COULD_NOT_LOAD = /^Could not load (\S+?):(?:\s|$)/;
const NETWORK_MESSAGE =
  /failed to fetch|networkerror|network request failed|load failed|err_internet|err_connection|err_network/i;
const DECODE_MESSAGE =
  /gltfloader|unexpected token|unexpected end of json|invalid typed array|couldn't load texture|failed to load texture|unsupported asset|json\.parse|is not valid json|invalid (glb|magic)|extension.*required|meshopt|draco|decoder/i;

/** Message of anything that can be thrown: Error, string, Event-like or `{ message }`. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  try {
    return String(error);
  } catch {
    // e.g. an object without a prototype: there is no string form, but the log must not throw.
    return Object.prototype.toString.call(error);
  }
}

function kindForStatus(status: number): LoadErrorKind {
  // 5xx, 408 and 429 are transient server trouble; every other 4xx means "that file is not there (for us)".
  if (status >= 500 || status === 429 || status === 408) return 'network';
  return 'asset-missing';
}

export function classifyLoadError(error: unknown): ClassifiedLoadError {
  const message = errorMessage(error);
  const responded = FETCH_RESPONDED.exec(message);
  if (responded?.[1] && responded[2]) {
    const status = Number(responded[2]);
    return { kind: kindForStatus(status), url: responded[1], status };
  }
  const wrapped = COULD_NOT_LOAD.exec(message);
  const url = wrapped?.[1];
  const withUrl = (kind: LoadErrorKind): ClassifiedLoadError =>
    url === undefined ? { kind } : { kind, url };
  if (NETWORK_MESSAGE.test(message)) return withUrl('network');
  if (DECODE_MESSAGE.test(message)) return withUrl('decode');
  // A texture/image load failure surfaces as a bare Event ("undefined" after R3F's wrapping): the
  // browser gives no status, but the loader did name the URL, so it is at least an asset problem.
  return withUrl('unknown');
}

/** True for the errors a load can plausibly recover from by trying again later. */
export function isRetryable(kind: LoadErrorKind): boolean {
  return kind === 'asset-missing' || kind === 'network' || kind === 'unknown';
}

const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
/** Automatic attempts before only a manual retry is left: one per backoff step. */
export const MAX_AUTO_ATTEMPTS = BACKOFF_STEPS_MS.length;
const JITTER_RATIO = 0.2;

/**
 * Delay before the automatic attempt with 0-based `attemptIndex`: 1s, 2s, 4s, 8s, 16s, then 30s, each
 * stretched by up to 20 % so a page full of failed models does not hit the server in lockstep.
 * `jitter` returns a value in [0, 1) (injectable for tests); `null` once the automatic attempts are used up.
 */
export function backoffDelayMs(
  attemptIndex: number,
  jitter: () => number = Math.random,
): number | null {
  if (!Number.isInteger(attemptIndex) || attemptIndex < 0) return null;
  const base = BACKOFF_STEPS_MS[attemptIndex];
  return base === undefined ? null : Math.round(base * (1 + JITTER_RATIO * jitter()));
}
