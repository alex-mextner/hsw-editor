import type { WorkerPort } from './client.ts';

/** The one place the worker URL appears: Vite only bundles `new Worker(new URL(..., import.meta.url))` written inline. */
export function spawnInvalidZoneWorker(): WorkerPort {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
}
