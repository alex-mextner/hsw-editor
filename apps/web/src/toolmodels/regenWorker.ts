/// <reference lib="webworker" />
/** Dedicated worker: builds tool models off the render thread. Protocol in `regen.ts`. */
import { regenerate } from './regenCore.ts';
import type { FromRegenWorker, ToRegenWorker } from './regen.ts';

const scope = globalThis as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<ToRegenWorker>) => {
  const request = event.data;
  try {
    const result = regenerate(request);
    const reply: FromRegenWorker = { type: 'built', result };
    scope.postMessage(reply, [result.lod0.buffer, result.lod1.buffer]);
  } catch (error) {
    const reply: FromRegenWorker = {
      type: 'failed',
      key: request.key,
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(reply);
  }
};
