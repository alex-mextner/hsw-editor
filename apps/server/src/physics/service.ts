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
  type WallHolder,
  type WallTool,
} from '@hsw-editor/physics';
import type { Wall, WallItem } from '@hsw-editor/core';
import type { WallStore } from '../store/wall-store.ts';
import { PhysicsAssets, loadManifold, type SkipReason } from './assets.ts';
import { describeProblemEn } from './describe.ts';

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
  /** One analysis per (wall, rev, tool) at a time: an agent that asks twice shares the answer. */
  const inFlight = new Map<string, Promise<WallPhysicsView>>();

  async function run(wall: Wall, toolId: string | undefined): Promise<WallPhysicsView> {
    const items = new Map(wall.items.map((item) => [item.id, item]));
    const holders: WallHolder[] = [];
    const boardParts: SolidBody[] = [];
    await Promise.all(
      wall.items.map(async (item) => {
        if ((item.kind !== 'holder' && item.kind !== 'board-part') || item.bankId === undefined)
          return;
        const loaded = await assets.elementSolid(item.bankId, item.params);
        if (loaded === null) return;
        const placement = placementOfPose(item.pose);
        const body = new SolidBody(item.id, loaded.solid, placement.rotation, placement.position);
        if (item.kind === 'holder') holders.push({ id: item.id, body });
        else boardParts.push(body);
      }),
    );
    // Deterministic obstacle order whatever order the decodes finished in.
    holders.sort((a, b) => (a.id < b.id ? -1 : 1));
    const holderIds = new Set(holders.map((h) => h.id));

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
      tools.push({
        id: item.id,
        body: built.body,
        placement: placementOfPose(item.pose),
        holderId: item.parentId,
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
