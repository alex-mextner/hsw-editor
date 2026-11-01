/**
 * Physics of a stored wall for agents and scripts: builds the same input the editor builds (holders and board parts
 * from the bank GLBs, tools from the generators and the tool library, poses from the items), runs
 * `analyseWallPhysics` with manifold-3d and returns plain JSON with an English sentence per problem.
 * The wall store is read, never written.
 */
import {
  analyseWallPhysics,
  placementOfPose,
  SolidBody,
  type HangReport,
  type PhysicsProblem,
  type RemovalReport,
  type ToolPhysics,
  protrudeLimitMm,
  type WallHolder,
  type WallTool,
} from '@hsw-editor/physics';
import type { LeafOp, Wall, WallItem } from '@hsw-editor/core';
import type { WallStore } from '../store/wall-store.ts';
import { PhysicsAssets, loadManifold, type SkipReason } from './assets.ts';
import { describeProblemEn } from './describe.ts';
import { createSeatPlanner, NO_SEAT_TEXT, type NoSeatReason, type Seat } from './seat.ts';

export type SkipCode = SkipReason | 'no_holder' | 'holder_missing';

export interface SkippedTool {
  readonly toolId: string;
  readonly reason: SkipCode;
}

export interface ProblemView extends PhysicsProblem {
  /** One English sentence. */
  readonly text: string;
}

/** The part of a `HangReport` a reader needs; the rest pose is reduced to what moves (tilt and position). */
export interface HangView extends Omit<HangReport, 'rest'> {
  readonly rest: { readonly tiltDeg: number; readonly position: readonly number[] } | null;
}

export interface ToolPhysicsView {
  readonly toolId: string;
  readonly label: string | null;
  readonly holderId: string;
  readonly status: HangReport['status'];
  readonly score: number;
  readonly rating: number;
  readonly problems: readonly ProblemView[];
  readonly hang: HangView;
  readonly removal: RemovalReport | null;
}

export interface WallPhysicsView {
  readonly wallId: string;
  readonly rev: number;
  readonly tools: readonly ToolPhysicsView[];
  /** Tools with at least one problem. */
  readonly flagged: number;
  /** Tool items that were not judged, and why. */
  readonly skipped: readonly SkippedTool[];
}

/** `GET /api/walls/:id/items/:itemId/seat`: where one hung tool rests in its holder, or why it has no seat. Never written. */
export interface SeatProposalView {
  readonly wallId: string;
  readonly rev: number;
  readonly toolId: string;
  readonly seat: Seat | null;
  readonly reason: { readonly code: NoSeatReason; readonly text: string } | null;
}

/** `GET /api/walls/:id/seat`: the seat of every hung tool as the editor's Seat tools pass finds it. Never written. */
export interface WallSeatView {
  readonly wallId: string;
  readonly rev: number;
  /** Tools that move, with the pose they move to. */
  readonly seats: readonly Seat[];
  readonly kept: readonly {
    readonly toolId: string;
    readonly reason: NoSeatReason;
    readonly text: string;
  }[];
  /** Tools that already rest where the physics puts them. */
  readonly unchanged: readonly string[];
  /** Hung without a slot number: left to the user. */
  readonly unslotted: readonly string[];
  /** Rotate and move per tool in `seats`: apply as one batch labelled `seat all`. */
  readonly ops: readonly LeafOp[];
}

export class ItemNotFoundError extends Error {
  constructor(readonly itemId: string) {
    super(`no item ${itemId} on this wall`);
  }
}

export class NotAToolError extends Error {
  constructor(
    readonly itemId: string,
    readonly kind: string,
  ) {
    super(`item ${itemId} is a ${kind}, not a tool`);
  }
}

export interface PhysicsService {
  /** The whole wall, or with `toolId` only that tool (the others still stand in its way). */
  analyseWall(wallId: string, options?: { toolId?: string }): Promise<WallPhysicsView>;
  /** Where the hung tool `toolId` rests in its own slot of its holder. Reads, never writes. */
  proposeSeat(wallId: string, toolId: string): Promise<SeatProposalView>;
  /** Where every hung tool rests. Reads, never writes. */
  proposeSeatAll(wallId: string): Promise<WallSeatView>;
}

function viewOf(item: WallItem | undefined, physics: ToolPhysics): ToolPhysicsView {
  const { rest, ...hang } = physics.hang;
  return {
    toolId: physics.toolId,
    label: item?.label ?? null,
    holderId: physics.holderId,
    status: physics.hang.status,
    score: physics.hang.score,
    rating: physics.rating,
    problems: physics.problems.map((problem) => ({ ...problem, text: describeProblemEn(problem) })),
    hang: {
      ...hang,
      rest: rest === null ? null : { tiltDeg: rest.tiltDeg, position: rest.placement.position },
    },
    removal: physics.removal,
  };
}

export function createPhysicsService(options: { store: WallStore; home: string }): PhysicsService {
  const assets = new PhysicsAssets(options.home);
  const planner = createSeatPlanner(assets);
  /** One analysis per (wall, rev, tool) at a time: an agent that asks twice shares the answer. */
  const inFlight = new Map<string, Promise<WallPhysicsView>>();

  async function run(wall: Wall, toolId: string | undefined): Promise<WallPhysicsView> {
    const items = new Map(wall.items.map((item) => [item.id, item]));
    const solids = await assets.wallSolids(wall);
    const holders: WallHolder[] = solids.holders.map((h) => ({ id: h.item.id, body: h.body }));
    const { boardParts } = solids;
    const holderIds = new Set(holders.map((h) => h.id));
    const bankIdOfHolder = new Map(solids.holders.map((h) => [h.item.id, h.element.id]));

    const skipped: SkippedTool[] = [];
    const tools: WallTool[] = [];
    const candidates = wall.items.filter((item) => item.kind === 'tool');
    for (const item of candidates) {
      if (item.parentId === undefined) {
        skipped.push({ toolId: item.id, reason: 'no_holder' });
        continue;
      }
      if (!holderIds.has(item.parentId)) {
        skipped.push({ toolId: item.id, reason: 'holder_missing' });
        continue;
      }
      const built = await assets.toolBody(item, wall);
      if ('skip' in built) {
        skipped.push({ toolId: item.id, reason: built.skip });
        continue;
      }
      const limit = protrudeLimitMm(bankIdOfHolder.get(item.parentId) ?? '');
      tools.push({
        id: item.id,
        body: built.body,
        placement: placementOfPose(item.pose),
        holderId: item.parentId,
        protrudeLimitMm: limit,
      });
    }

    // Judging one tool: the others are obstacles at their own poses, exactly what `analyseWallPhysics` makes of them.
    const judged = toolId === undefined ? tools : tools.filter((t) => t.id === toolId);
    const neighbours =
      toolId === undefined
        ? boardParts
        : [
            ...boardParts,
            ...tools
              .filter((t) => t.id !== toolId)
              .map(
                (t) => new SolidBody(t.id, t.body.mesh, t.placement.rotation, t.placement.position),
              ),
          ];
    const report = analyseWallPhysics({
      tools: judged,
      holders,
      others: neighbours,
      wasm: await loadManifold(),
    });
    const views = report.tools.map((physics) => viewOf(items.get(physics.toolId), physics));
    return {
      wallId: wall.id,
      rev: wall.rev,
      tools: views,
      flagged: views.filter((view) => view.problems.length > 0).length,
      skipped: toolId === undefined ? skipped : skipped.filter((s) => s.toolId === toolId),
    };
  }

  return {
    async proposeSeat(wallId, toolId) {
      const { wall } = await options.store.get(wallId);
      const asked = wall.items.find((item) => item.id === toolId);
      if (asked === undefined) throw new ItemNotFoundError(toolId);
      if (asked.kind !== 'tool') throw new NotAToolError(asked.id, asked.kind);
      const attempt = await planner.seatOne(wall, toolId);
      return {
        wallId: wall.id,
        rev: wall.rev,
        toolId,
        seat: attempt.seat,
        reason:
          attempt.seat === null
            ? { code: attempt.reason, text: NO_SEAT_TEXT[attempt.reason] }
            : null,
      };
    },

    async proposeSeatAll(wallId) {
      const { wall } = await options.store.get(wallId);
      const plan = await planner.seatAll(wall);
      return {
        wallId: wall.id,
        rev: wall.rev,
        seats: plan.seats,
        kept: plan.kept.map((k) => ({ ...k, text: NO_SEAT_TEXT[k.reason] })),
        unchanged: plan.unchanged,
        unslotted: plan.unslotted,
        ops: plan.ops,
      };
    },

    async analyseWall(wallId, { toolId } = {}) {
      const { wall } = await options.store.get(wallId);
      const asked =
        toolId === undefined ? undefined : wall.items.find((item) => item.id === toolId);
      if (toolId !== undefined && asked === undefined) throw new ItemNotFoundError(toolId);
      if (asked !== undefined && asked.kind !== 'tool')
        throw new NotAToolError(asked.id, asked.kind);
      const key = `${wall.id}|${wall.rev}|${toolId ?? ''}`;
      let pending = inFlight.get(key);
      if (pending === undefined) {
        pending = run(wall, toolId).finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      return pending;
    },
  };
}
