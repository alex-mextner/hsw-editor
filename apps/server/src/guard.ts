/**
 * Loopback-only guard. The daemon binds 127.0.0.1, but a browser on the same machine can still be pointed
 * at it by a hostile page: DNS rebinding (foreign Host) or a cross-site form POST (foreign Origin).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface GuardVerdict {
  readonly code: 'forbidden_host' | 'forbidden_origin';
  readonly message: string;
}

export function checkRequestOrigin(
  request: Request,
  allowedOrigins: readonly string[],
): GuardVerdict | null {
  const url = new URL(request.url);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return { code: 'forbidden_host', message: `host ${url.host} is not a loopback address` };
  }
  const origin = request.headers.get('origin');
  if (origin === null) return null; // CLI, agents and same-origin GETs carry no Origin
  if (origin === url.origin || allowedOrigins.includes(origin)) return null;
  return { code: 'forbidden_origin', message: `origin ${origin} is not allowed` };
}
