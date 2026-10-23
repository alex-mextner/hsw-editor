/**
 * Seat on hang. Hanging a tool is instant and uses the compatibility maths (`placeTool`: one point of the tool on the
 * slot anchor); that pose can float above the holder or sink into it. A moment later the physics lowers the tool into
 * the real holder mesh (`seatTool`, in the worker, 0.1-1 s) and one more undo step moves the tool to where it rests.
 * The pointer is never blocked: the drag/drop preview stays on `placeTool`.
 */
import {
  applyOp,
  type BatchOp,
  type LeafOp,
  type Op,
  type Pose,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import type { HangReport } from '@hsw-editor/physics';
import { type AssetContext, planWallRank, wallSlot } from './assets.ts';
import type { PhysicsRanker } from './client.ts';

/** What the post-steps need from the editor; `livePostStepDeps` binds them to the stores, tests pass fakes. */
export interface PostStepDeps {
  readonly wall: () => Wall | null;
  readonly context: (wall: Wall) => AssetContext | null;
  readonly ranker: () => PhysicsRanker;
  /** Submits one undo step; false when it was refused (locked, stale, no wall). */
  readonly submit: (ops: readonly Op[], label: string) => boolean;
  /** The settings toggle "physics checks". */
  readonly enabled: () => boolean;
  /**
   * Resolves true once the model of the tool is no longer being rebuilt (a tool resized a moment ago is judged on the size it
   * has now, not skipped), false when that took too long. Absent: models are never pending.
   */
  readonly settled?: (toolId: string) => Promise<boolean>;
}

export interface SeatOutcome {
  readonly pose: Pose;
  readonly report: HangReport;
  readonly slot: number;
}

/**
 * Where `toolItemId` rests when seated in `holderId` (slot `slot`, else the tool's own slot, else the first free one).
 * Null when nothing can be said: no model, holder not upright, no seat exists.
 */
export async function seatToolInHolder(
  toolItemId: string,
  holderId: string,
  deps: PostStepDeps,
  slot?: number,
): Promise<SeatOutcome | null> {
  const wall = deps.wall();
  const ctx = wall === null ? null : deps.context(wall);
  if (wall === null || ctx === null) return null;
  const toolItem = wall.items.find((item) => item.id === toolItemId && item.kind === 'tool');
  const holderItem = wall.items.find((item) => item.id === holderId && item.kind === 'holder');
  const element = holderItem?.bankId === undefined ? undefined : ctx.bank.get(holderItem.bankId);
  const tool = toolItem === undefined ? undefined : ctx.toolInterface(toolItem);
  if (
    toolItem === undefined ||
    holderItem === undefined ||
    element === undefined ||
    tool === undefined
  )
    return null;
  const target = wallSlot(wall, toolItem, holderItem, element, tool, slot ?? toolItem.slot);
  if (target === null) return null;
  const plan = planWallRank(wall, ctx, toolItem, [target], false);
  if (plan === null) return null;
  const [best] = await deps.ranker().rank(plan.request, plan.sources);
  return best === undefined
    ? null
    : { pose: best.seat.pose, report: best.seat.report, slot: target.slot.index };
}

/** The undo step that puts a tool on its seated pose (rotate, then move; the slot stays). */
export function seatOps(toolId: string, pose: Pose): BatchOp {
  return {
    type: 'batch',
    label: 'seat',
    ops: [
      { type: 'rotateItem', id: toolId, rotX: pose.rotX, rotY: pose.rotY, rotZ: pose.rotZ },
      { type: 'moveItem', id: toolId, to: { x: pose.x, y: pose.y, z: pose.z } },
    ],
  };
}

/** A seat is never fatal: the compatibility pose stays and the check flags it. */
export function warnSeatFailed(toolId: string, error: unknown): void {
  console.warn(
    `[physics] seat of ${toolId} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const SAME_POSE_MM = 0.01;

export function samePose(a: Pose, b: Pose): boolean {
  return (
    Math.abs(a.x - b.x) < SAME_POSE_MM &&
    Math.abs(a.y - b.y) < SAME_POSE_MM &&
    Math.abs(a.z - b.z) < SAME_POSE_MM &&
    Math.abs(a.rotX - b.rotX) < SAME_POSE_MM &&
    Math.abs(a.rotY - b.rotY) < SAME_POSE_MM &&
    Math.abs(a.rotZ - b.rotZ) < SAME_POSE_MM
  );
}

/**
 * Is `live` still the tool that was hung `expected` when a worker answer was asked for: not locked, on the same holder and
 * slot, at the same pose? (The user may have moved it on, or hung it elsewhere, while the worker was busy.)
 */
export function stillHung(
  live: WallItem | undefined,
  expected: { readonly parentId: string; readonly slot: number | undefined; readonly pose: Pose },
): boolean {
  return (
    live !== undefined &&
    !live.locked &&
    live.parentId === expected.parentId &&
    live.slot === expected.slot &&
    samePose(live.pose, expected.pose)
  );
}

/**
 * `seated`: the tool moved to its resting pose; `kept`: no seat exists (or it is where the tool already is), the
 * compatibility pose stays and the check flags it; `stale`: the wall changed meanwhile (the user moved the tool on,
 * another hang landed), nothing is touched; `off`: physics checks are switched off.
 */
export type SeatStatus = 'seated' | 'kept' | 'stale' | 'off' | 'skipped' | 'failed';

/**
 * Post-step of every hang that chose its holder (add-holder-for-tool, a click on a suggested holder): seats the tool
 * in the holder it hangs on now. Never throws: a failed worker only means the compatibility pose stays.
 */
export async function seatAfterHang(toolId: string, deps: PostStepDeps): Promise<SeatStatus> {
  if (!deps.enabled()) return 'off';
  const first = deps.wall()?.items.find((item) => item.id === toolId);
  if (first?.parentId === undefined || first.locked) return 'skipped';
  if (deps.settled !== undefined) {
    // The model of a tool resized a moment ago is still being rebuilt: wait for it, then seat the tool only if it is still
    // hung exactly as it was (the user may have moved it on, or switched the physics off, meanwhile).
    const built = await deps.settled(toolId);
    if (!deps.enabled()) return 'off';
    const live = deps.wall()?.items.find((item) => item.id === toolId);
    if (!stillHung(live, { parentId: first.parentId, slot: first.slot, pose: first.pose })) {
      return 'stale';
    }
    if (!built) return 'kept';
  }
  const hung = deps.wall()?.items.find((item) => item.id === toolId);
  if (hung?.parentId === undefined || hung.locked) return 'skipped';
  const { parentId, pose: hungPose, slot } = hung;
  let seat: SeatOutcome | null;
  try {
    seat = await seatToolInHolder(toolId, parentId, deps, slot);
  } catch (error) {
    warnSeatFailed(toolId, error);
    return 'failed';
  }
  if (seat === null || samePose(seat.pose, hungPose)) return 'kept';
  // The user may have moved the tool on, or hung it elsewhere, while the worker was busy.
  const live = deps.wall()?.items.find((item) => item.id === toolId);
  if (!stillHung(live, { parentId, slot, pose: hungPose })) return 'stale';
  return deps.submit([seatOps(toolId, seat.pose)], 'seat') ? 'seated' : 'stale';
}

/** What `seatAllTools` did: tools moved, tools that already rest where the physics puts them, tools without a seat. */
export interface SeatAllOutcome {
  readonly seated: readonly string[];
  readonly unchanged: readonly string[];
  /** No seat exists (no model, no free slot, rotated holder, the holder does not take it): the pose stays and the check flags it. */
  readonly kept: readonly string[];
  /** Hung without a slot number: which slot they take is anybody's guess, so they are left to the user. */
  readonly unslotted: readonly string[];
  /** The ops were not applied: the wall changed while the worker was busy, or the submit was refused. */
  readonly stale: boolean;
}

/**
 * Seats every tool that hangs on a holder, one after the other (each against the poses the earlier ones already have)
 * and applies all moves as ONE undo step labelled `seat all`. This is how a wall built before physics existed, or by an agent
 * from compatibility poses, ends up with its tools inside their holders. Never throws.
 */
export async function seatAllTools(deps: PostStepDeps): Promise<SeatAllOutcome> {
  const start = deps.wall();
  const empty: SeatAllOutcome = {
    seated: [],
    unchanged: [],
    kept: [],
    unslotted: [],
    stale: false,
  };
  if (start === null || !deps.enabled()) return empty;
  let local = start;
  const seated: string[] = [];
  const unchanged: string[] = [];
  const kept: string[] = [];
  const unslotted: string[] = [];
  // A tool is seated among the holders and the tools already dealt with. Tools still waiting hang at the poses the wall
  // was built with (often sunk into their holders), which would only block the slots the physics is about to use.
  // Tools that will not move are real obstacles from the start, not ones that are still waiting: locked ones and ones
  // without a slot number (their slot is anybody's guess, they are left to the user).
  const fixed = (i: WallItem): boolean => i.locked || i.slot === undefined;
  const waiting = new Set(
    start.items
      .filter((i) => i.kind === 'tool' && i.parentId !== undefined && !fixed(i))
      .map((i) => i.id),
  );
  const view = (current: string): PostStepDeps => ({
    ...deps,
    wall: () => ({
      ...local,
      items: local.items.filter((i) => i.id === current || !waiting.has(i.id)),
    }),
  });
  for (const item of start.items) {
    if (item.kind !== 'tool' || item.parentId === undefined || item.locked) continue;
    if (item.slot === undefined) {
      unslotted.push(item.id);
      continue;
    }
    waiting.delete(item.id);
    let seat: SeatOutcome | null = null;
    try {
      seat = await seatToolInHolder(item.id, item.parentId, view(item.id), item.slot);
    } catch (error) {
      warnSeatFailed(item.id, error);
    }
    if (seat === null) {
      kept.push(item.id);
    } else if (samePose(seat.pose, item.pose)) {
      unchanged.push(item.id);
    } else {
      local = applyOp(local, seatOps(item.id, seat.pose)).wall;
      seated.push(item.id);
    }
  }
  // Tools that did not move (or could not be seated) were hidden from the ones seated before them: now that every pose
  // is known, each seated tool looks once more at all of them and settles again if one is in its way.
  if (seated.length > 0 && (unchanged.length > 0 || kept.length > 0)) {
    for (const id of seated) {
      const item = local.items.find((candidate) => candidate.id === id);
      if (item === undefined || item.parentId === undefined || item.slot === undefined) continue;
      let again: SeatOutcome | null = null;
      try {
        again = await seatToolInHolder(id, item.parentId, view(id), item.slot);
      } catch (error) {
        warnSeatFailed(id, error);
      }
      if (again === null || samePose(again.pose, item.pose)) continue;
      local = applyOp(local, seatOps(id, again.pose)).wall;
    }
  }
  // What is applied is the difference between where each tool started and where the passes left it: a tool the second
  // pass put back where it began is no move at all.
  const moved = seated.filter((id) => {
    const from = start.items.find((candidate) => candidate.id === id)?.pose;
    const to = local.items.find((candidate) => candidate.id === id)?.pose;
    return from !== undefined && to !== undefined && !samePose(from, to);
  });
  const ops: LeafOp[] = moved.flatMap((id) => {
    const to = local.items.find((candidate) => candidate.id === id)?.pose;
    return to === undefined ? [] : seatOps(id, to).ops;
  });
  if (ops.length === 0) return { seated: moved, unchanged, kept, unslotted, stale: false };
  // Anything that touched the wall meanwhile (the user kept editing) makes these poses stale: apply none of them.
  const now = deps.wall();
  if (now?.id !== start.id || now.rev !== start.rev) {
    return { seated: [], unchanged, kept, unslotted, stale: true };
  }
  // Switched off while the worker was busy: the setting means no seating at all.
  if (!deps.enabled()) return { seated: [], unchanged, kept, unslotted, stale: false };
  const applied = deps.submit([{ type: 'batch', label: 'seat all', ops }], 'seat all');
  return applied
    ? { seated: moved, unchanged, kept, unslotted, stale: false }
    : { seated: [], unchanged, kept, unslotted, stale: true };
}
