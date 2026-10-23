import { PhysicsClient } from './client.ts';

let shared: PhysicsClient | null = null;

/**
 * The one physics worker of the page, started on first use. The worker url must appear inline in
 * `new Worker(new URL(...))`: that is the form Vite bundles.
 */
export function physicsClient(): PhysicsClient {
  shared ??= new PhysicsClient(
    () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    (message) => console.warn(`[physics] ${message}`),
  );
  return shared;
}
