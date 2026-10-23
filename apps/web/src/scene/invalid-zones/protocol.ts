/** Messages between the render thread and the invalid-zone worker. All payloads are structured-cloneable. */
import type { Aabb, Board } from '@hsw-editor/core';
import type { EngineItem, SolveResult } from './engine.ts';

/** Where the geometry behind a solid key comes from. */
export type SolidSource =
  /** A bank GLB the worker fetches and flattens (`url` must be absolute: a worker resolves relative urls against its own script); `fallbackBox` stands in when it cannot be loaded. */
  | { readonly kind: 'glb'; readonly url: string; readonly fallbackBox: Aabb }
  /** Stand-in box in the item frame (tools without a bank model). */
  | { readonly kind: 'box'; readonly box: Aabb };

export type ToWorker =
  | { readonly type: 'define'; readonly key: string; readonly source: SolidSource }
  | {
      readonly type: 'solve';
      readonly seq: number;
      readonly board: Board;
      readonly items: readonly EngineItem[];
    };

export type FromWorker =
  | { readonly type: 'result'; readonly seq: number; readonly result: SolveResult }
  /** The solve of scene `seq` failed: it will never be answered. */
  | { readonly type: 'error'; readonly seq: number; readonly message: string }
  /** The worker cannot solve at all (the WASM failed to load). */
  | { readonly type: 'fatal'; readonly message: string }
  /** Something worth logging that does not affect any solve (a GLB failed to load; its box stands in). */
  | { readonly type: 'notice'; readonly message: string };
