import { type DrawBackendId, DrawError } from '@hsw-editor/draw';
import { abortableSleep, jitter } from './timing.ts';
import { type GuardConfig, type GuardStore, gate, recordSend } from './guard.ts';

/**
 * Called right before every prompt that spends quota: enforces the persisted block/cap, waits out
 * the human-pace gap (plus jitter), then records the send. Throws the matching DrawError when blocked.
 */
export async function paceSend(
  store: GuardStore,
  id: DrawBackendId,
  config: GuardConfig,
  signal: AbortSignal,
  clock: () => number = Date.now,
): Promise<void> {
  const decision = gate(await store.get(id), config, clock(), 1);
  if (decision.kind === 'blocked') {
    throw new DrawError(decision.code, decision.message, {
      retryable: decision.code === 'quota_exhausted',
      ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
    });
  }
  if (decision.waitMs > 0) {
    await abortableSleep(
      decision.waitMs + (config.minIntervalMs > 0 ? jitter(500, 4000) : 0),
      signal,
    );
  }
  await store.update(id, (g) => recordSend(g, clock()));
}
