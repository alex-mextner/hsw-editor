/**
 * Web Worker entry: owns the manifold WASM and the engine, so exact booleans never block the render thread.
 * All logic lives in `WorkerCore`; this file only wires it to the worker global and to Vite's asset url.
 */
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { InvalidZoneEngine } from './engine.ts';
import { readGlbSolid } from './glb.ts';
import { loadManifold } from './manifold.ts';
import type { FromWorker, ToWorker } from './protocol.ts';
import { WorkerCore } from './workerCore.ts';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  postMessage(message: FromWorker): void;
};

const core = new WorkerCore({
  engine: loadManifold(wasmUrl).then((wasm) => new InvalidZoneEngine(wasm)),
  post: (message) => scope.postMessage(message),
  fetchSolid: async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return readGlbSolid(await response.arrayBuffer());
  },
  schedule: (task, delayMs) => setTimeout(task, delayMs),
});

scope.onmessage = (event) => core.handle(event.data);
