/** Messages between the render thread and the physics worker. All payloads are structured-cloneable. */
import type { Pose } from '@hsw-editor/core';
import type { HangReport, RankedSeat, WallPhysicsReport } from '@hsw-editor/physics';

/**
 * Where the geometry behind a body key comes from. `url` is absolute: a worker resolves relative urls against its
 * own script.
 */
export type BodySource =
  /** A bank GLB (holder, shelf, board part): a posed solid obstacle. */
  | { readonly kind: 'solid'; readonly url: string }
  /** A generated tool GLB carrying its mass and centre of gravity (`extras.physics`). */
  | { readonly kind: 'tool'; readonly url: string };

/** One posed body of the scene: the geometry is `bodyKey`, defined once with `define`. */
export interface PlacedBody {
  /** Wall item id (or a synthetic id for a virtual holder). */
  readonly id: string;
  readonly bodyKey: string;
  readonly pose: Pose;
}

export interface PlacedTool extends PlacedBody {
  /** Holder item id the tool hangs on; null = not hung (an obstacle only). */
  readonly holderId: string | null;
  readonly maxLoadG?: number | undefined;
  readonly protrudeLimitMm?: number | undefined;
}

/** The whole wall as the physics sees it: holders, tools and the other solids (shelves, board parts). */
export interface PhysicsScene {
  readonly holders: readonly PlacedBody[];
  readonly tools: readonly PlacedTool[];
  readonly others: readonly PlacedBody[];
}

/** A holder a tool may be seated in. */
export interface SeatCandidate {
  readonly holder: PlacedBody;
  /** Wall-frame slot position: x centre of the slot, z centre of the holder. */
  readonly anchor: readonly [number, number, number];
  readonly halfWidthMm: number;
  readonly tipDown: boolean;
  /** Fit score of `compatibility()`; folded into the rank. */
  readonly compatScore: number;
  readonly maxLoadG?: number | undefined;
  readonly protrudeLimitMm?: number | undefined;
}

/** `tool` is seated in every candidate; `neighbours` (holders, other tools, shelves; never the tool itself) are the obstacles. */
export interface RankRequest {
  readonly tool: { readonly id: string; readonly bodyKey: string };
  readonly candidates: readonly SeatCandidate[];
  readonly neighbours: readonly PlacedBody[];
  /** Also measure how easily the tool comes off again (slower). */
  readonly removal: boolean;
}

/** A tool let go with no mount: `tool` is the released body at its release pose, `neighbours` everything it can touch (never the tool itself). */
export interface FallRequest {
  readonly tool: PlacedBody;
  readonly neighbours: readonly PlacedBody[];
  readonly floorYMm: number;
  readonly floorDepthMm: number;
}

/** What the worker decided for a `FallRequest`; `rest` is the pose the tool comes to rest in. */
export type FellPlan =
  | { readonly falls: false; readonly report: HangReport }
  | {
      readonly falls: true;
      readonly report: HangReport;
      readonly rest: Pose;
      readonly dropMm: number;
      /** Id of the item it lands on; null when it reaches the floor. */
      readonly landedOn: string | null;
    };

export type ToWorker =
  | { readonly type: 'define'; readonly key: string; readonly source: BodySource }
  | { readonly type: 'solve'; readonly seq: number; readonly scene: PhysicsScene }
  | { readonly type: 'rank'; readonly seq: number; readonly request: RankRequest }
  | { readonly type: 'fall'; readonly seq: number; readonly request: FallRequest };

/** Why a body is missing from an answer. */
export type MissingBody = {
  readonly key: string;
  /** The download failed (offline, server error): worth another try on the next run. A model that loaded but cannot be used (no mass data) is permanent. */
  readonly retry: boolean;
};

export type FromWorker =
  | {
      readonly type: 'result';
      readonly seq: number;
      readonly report: WallPhysicsReport;
      /** Tools left out because their model (or their holder's) could not be used. */
      readonly skipped: readonly string[];
      readonly missing: readonly MissingBody[];
    }
  | {
      readonly type: 'ranked';
      readonly seq: number;
      readonly seats: readonly RankedSeat[];
      readonly missing: readonly MissingBody[];
    }
  | {
      readonly type: 'fell';
      readonly seq: number;
      /** Null when the tool's model is missing or unusable (nothing can be said). */
      readonly plan: FellPlan | null;
      readonly missing: readonly MissingBody[];
    }
  /** Job `seq` failed: it will never be answered. */
  | { readonly type: 'error'; readonly seq: number; readonly message: string }
  /** The worker cannot run at all (the WASM failed to load). */
  | { readonly type: 'fatal'; readonly message: string }
  /** Something worth logging that does not affect any answer (a GLB failed to load). */
  | { readonly type: 'notice'; readonly message: string };
