/**
 * The work of the model worker, free of worker globals so it is testable under bun: generate a class with the values
 * that reach a wanted box, export both LODs as GLB. The worker script only posts what this returns.
 */
import {
  boundsCentre,
  boundsDims,
  buildWallToolModel,
  exportGlb,
  holdingSummary,
  type HoldingSummary,
  type ToolDims,
} from '@hsw-editor/tools';

export interface RegenRequest {
  /** Cache key of the caller (entry + wanted box); echoed back. */
  readonly key: string;
  readonly classId: string;
  /** Resolved class values of the default build the wanted box is solved from. */
  readonly base: Readonly<Record<string, number | string>>;
  readonly target: Partial<ToolDims>;
}

export interface RegenResult {
  readonly key: string;
  /** `paramHash` of the resolved values: the identity of the model, equal for equal values. */
  readonly hash: string;
  readonly reached: boolean;
  readonly dimsMm: ToolDims;
  readonly centreMm: ToolDims;
  readonly holding: HoldingSummary;
  readonly lod0: Uint8Array;
  readonly lod1: Uint8Array;
}

export function regenerate(request: RegenRequest): RegenResult {
  const built = buildWallToolModel(request.classId, request.base, request.target);
  return {
    key: request.key,
    hash: built.hash,
    reached: built.reached,
    dimsMm: boundsDims(built.lod0.bounds),
    centreMm: boundsCentre(built.lod0.bounds),
    holding: holdingSummary(built.lod0),
    lod0: exportGlb(built.lod0),
    lod1: exportGlb(built.lod1),
  };
}
