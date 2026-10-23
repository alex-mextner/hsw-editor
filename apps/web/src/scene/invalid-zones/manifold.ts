/** Lazy loader of the manifold-3d WASM (exact mesh booleans). Works in a Web Worker, the main thread and bun. */
import Module, { type ManifoldToplevel } from 'manifold-3d';

export type { ManifoldToplevel };

/** `wasmUrl`: where the bundler put `manifold.wasm` (Vite `?url`); omitted under bun/node, which find it in node_modules. */
export async function loadManifold(wasmUrl?: string): Promise<ManifoldToplevel> {
  const wasm = await Module(wasmUrl === undefined ? undefined : { locateFile: () => wasmUrl });
  wasm.setup();
  return wasm;
}
