/** Runs `fn` after `ms`; the returned function cancels it. Injected into the state machines so tests control time. */
export type Schedule = (fn: () => void, ms: number) => () => void;

export const defaultSchedule: Schedule = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

/** 1 s, 2 s, 4 s ... capped at 30 s, with up to 20% jitter so many tabs do not probe in lockstep. */
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 30_000;

export function backoffDelay(failures: number, random: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(exp * (1 + 0.2 * random));
}
