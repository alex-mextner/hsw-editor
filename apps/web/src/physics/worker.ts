/**
 * Web Worker entry: owns the manifold WASM and the physics, so seating and removal probes never block the render
 * thread. All logic lives in `WorkerCore`; this file only wires it to the worker global and to Vite's asset url.
 */
import { readGlbSolid, readToolBody } from '@hsw-editor/physics/glb';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { loadManifold } from '@/scene/invalid-zones/manifold.ts';
import type { FromWorker, ToWorker } from './protocol.ts';
import { WorkerCore } from './workerCore.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

/** A model that does not arrive in this time is treated as failed (and fetched again on the next run). */
const FETCH_TIMEOUT_MS = 30_000;

async function download(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.arrayBuffer();
}

const core = new WorkerCore({
  wasm: loadManifold(wasmUrl),
  post: (message) => scope.postMessage(message),
  fetchSolid: async (url) => readGlbSolid(await download(url)),
  fetchTool: async (url, id) => readToolBody(id, await download(url)),
});

scope.onmessage = (event) => core.handle(event.data);
