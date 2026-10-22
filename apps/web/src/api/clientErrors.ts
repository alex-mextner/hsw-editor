import { errorMessage } from '@/bank/loadErrors.ts';

/**
 * Fire-and-forget client error log: `POST /api/client-errors` (JSONL on the server, 204 on success).
 * Reporting must never become a second failure: identical errors are throttled, the request is not
 * awaited by callers, and every failure of the request itself is swallowed.
 */

export type ClientErrorKind = 'asset-load' | 'render' | 'unhandled' | 'user-report';

export type ClientErrorDetail = Readonly<Record<string, string | number | boolean>>;

export interface ClientErrorEntry {
  readonly kind: ClientErrorKind;
  readonly message: string;
  readonly ts: string;
  readonly url?: string;
  readonly bankId?: string;
  readonly status?: number;
  readonly stack?: string;
  readonly page?: string;
  readonly userAgent?: string;
  readonly detail?: ClientErrorDetail;
}

/** What callers supply; `ts`, `page` and `userAgent` are filled in. */
export type ClientErrorInput = Omit<ClientErrorEntry, 'ts' | 'page' | 'userAgent'>;

export const CLIENT_ERRORS_ROUTE = '/api/client-errors';
/** The server answers 413 above 16 KiB of body; everything is cut so the JSON stays well below. */
const MAX_MESSAGE_CHARS = 1500;
const MAX_STACK_CHARS = 4000;
const MAX_SHORT_TEXT_CHARS = 500;
const MAX_DETAIL_VALUE_CHARS = 1500;
const MAX_DETAIL_KEYS = 20;
/** Budget for the serialized body in bytes; checked after clipping because characters are not bytes. */
const MAX_BODY_BYTES = 12 * 1024;
export const THROTTLE_WINDOW_MS = 10_000;

export interface ClientErrorLoggerDeps {
  readonly send: (entry: ClientErrorEntry) => Promise<unknown>;
  readonly now: () => number;
  readonly page: () => string | undefined;
  readonly userAgent: () => string | undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function clipDetail(detail: ClientErrorDetail): ClientErrorDetail {
  return Object.fromEntries(
    Object.entries(detail)
      .slice(0, MAX_DETAIL_KEYS)
      .map(([key, value]) => [
        clip(key, 80),
        typeof value === 'string' ? clip(value, MAX_DETAIL_VALUE_CHARS) : value,
      ]),
  );
}

/** True while `at` is less than a window behind `now`; a clock that jumped backwards counts as expired, never as throttled. */
function withinWindow(now: number, at: number): boolean {
  return now >= at && now - at < THROTTLE_WINDOW_MS;
}

function bodyBytes(entry: ClientErrorEntry): number {
  return new TextEncoder().encode(JSON.stringify(entry)).length;
}

/** Drops the bulkiest optional fields, in order, until the body fits (multi-byte text and escapes can outgrow character limits). */
function fitBody(entry: ClientErrorEntry): ClientErrorEntry {
  if (bodyBytes(entry) <= MAX_BODY_BYTES) return entry;
  const { detail: _detail, ...withoutDetail } = entry;
  if (bodyBytes(withoutDetail) <= MAX_BODY_BYTES) return withoutDetail;
  const { stack: _stack, ...withoutStack } = withoutDetail;
  if (bodyBytes(withoutStack) <= MAX_BODY_BYTES) return withoutStack;
  return { ...withoutStack, message: clip(withoutStack.message, 300) };
}

/** Builds the logger around injectable I/O, so throttling and swallowing are testable without a network. */
export function createClientErrorLogger(deps: ClientErrorLoggerDeps) {
  const lastSent = new Map<string, number>();

  /** The wire entry: text clipped to fit the server limit, ts/page/userAgent filled in. */
  function build(input: ClientErrorInput): ClientErrorEntry {
    const page = deps.page();
    const userAgent = deps.userAgent();
    return fitBody({
      ...input,
      message: clip(input.message, MAX_MESSAGE_CHARS),
      ts: new Date(deps.now()).toISOString(),
      ...(input.url === undefined ? {} : { url: clip(input.url, MAX_SHORT_TEXT_CHARS) }),
      ...(input.bankId === undefined ? {} : { bankId: clip(input.bankId, MAX_SHORT_TEXT_CHARS) }),
      ...(input.stack === undefined ? {} : { stack: clip(input.stack, MAX_STACK_CHARS) }),
      ...(input.detail === undefined ? {} : { detail: clipDetail(input.detail) }),
      ...(page === undefined ? {} : { page: clip(page, MAX_SHORT_TEXT_CHARS) }),
      ...(userAgent === undefined ? {} : { userAgent: clip(userAgent, MAX_SHORT_TEXT_CHARS) }),
    });
  }

  return {
    /** Forgets what was sent, so the throttle starts afresh (tests). */
    reset(): void {
      lastSent.clear();
    },
    /** Entries remembered for throttling (tests); bounded by what can arrive within one window. */
    remembered(): number {
      return lastSent.size;
    },
    /** Sends unless an identical (message + url) error went out in the last 10 s. */
    log(input: ClientErrorInput): boolean {
      const now = deps.now();
      const key = `${clip(input.message, MAX_MESSAGE_CHARS)}\u0000${clip(input.url ?? '', MAX_SHORT_TEXT_CHARS)}`;
      const previous = lastSent.get(key);
      if (previous !== undefined && withinWindow(now, previous)) return false;
      lastSent.set(key, now);
      // Entries older than the window can never throttle anything again.
      for (const [other, at] of lastSent) if (!withinWindow(now, at)) lastSent.delete(other);
      try {
        deps.send(build(input)).catch(() => undefined);
      } catch {
        // A synchronous failure (no fetch at all) is as harmless as a rejected request.
      }
      return true;
    },
    /** Awaitable and unthrottled, for explicit user reports; null when the request failed. */
    async submit(input: ClientErrorInput): Promise<ClientErrorEntry | null> {
      const entry = build(input);
      try {
        await deps.send(entry);
        return entry;
      } catch {
        return null;
      }
    },
  };
}

async function postEntry(entry: ClientErrorEntry): Promise<void> {
  const response = await fetch(CLIENT_ERRORS_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

const logger = createClientErrorLogger({
  send: postEntry,
  now: () => Date.now(),
  page: () => globalThis.location?.href,
  userAgent: () => globalThis.navigator?.userAgent,
});

/** Records an error on the server; returns false when it was dropped as a repeat. Never throws. */
export function logClientError(input: ClientErrorInput): boolean {
  return logger.log(input);
}

/** Forgets what was already sent, so the 10 s throttle starts afresh (tests). */
export function resetClientErrorThrottle(): void {
  logger.reset();
}

/** Sends a user-initiated report and tells whether the server took it; the entry is returned for display. */
export function sendClientError(input: ClientErrorInput): Promise<ClientErrorEntry | null> {
  return logger.submit(input);
}

/** Entry for a thrown value: message and stack when it is an Error. */
export function errorEntry(
  kind: ClientErrorKind,
  error: unknown,
  extra: Omit<ClientErrorInput, 'kind' | 'message' | 'stack'> = {},
): ClientErrorInput {
  if (error instanceof Error) {
    return {
      kind,
      message: error.message || error.name,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...extra,
    };
  }
  return { kind, message: errorMessage(error), ...extra };
}

let uninstall: (() => void) | null = null;

/**
 * Logs uncaught errors and unhandled rejections of the page. The listeners observe only: the browser
 * keeps its default handling (console), and nothing here rethrows. Calling it twice installs once.
 * Returns the function that removes the listeners.
 */
export function installGlobalErrorLogging(): () => void {
  // A second caller gets the same teardown, so whoever stops logging really stops it.
  if (uninstall) return uninstall;
  const onError = (event: ErrorEvent) => {
    logClientError(
      errorEntry('unhandled', event.error ?? event.message, {
        ...(event.filename ? { url: event.filename } : {}),
      }),
    );
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    logClientError(errorEntry('unhandled', event.reason));
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);
  uninstall = () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    uninstall = null;
  };
  return uninstall;
}
