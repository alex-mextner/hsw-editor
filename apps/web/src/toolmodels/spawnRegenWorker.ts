import type { RegenPort } from './regen.ts';

/** The one place the worker URL appears: Vite only bundles `new Worker(new URL(..., import.meta.url))` written inline. */
export function spawnRegenWorker(): RegenPort {
  return new Worker(new URL('./regenWorker.ts', import.meta.url), { type: 'module' });
}
