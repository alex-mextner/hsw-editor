/** Replaces `fetch` for a test without casts; `restoreFetch` puts Bun's own back. */
const realFetch = globalThis.fetch;

export type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

/** Like the real `fetch`, a throwing handler yields a rejected promise, never a synchronous throw. */
export function installFetch(handler: FetchHandler): void {
  globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve().then(() => handler(String(input), init)),
    { preconnect: realFetch.preconnect },
  );
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

/** Lets stubbed requests (which settle on microtasks) run before a test looks at what they received. */
export async function settleRequests(): Promise<void> {
  for (let hop = 0; hop < 10; hop++) await Promise.resolve();
}
