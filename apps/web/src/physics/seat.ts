/**
 * Seat on hang. Hanging a tool is instant and uses the compatibility maths (`placeTool`: one point of the tool on the
 * slot anchor); that pose can float above the holder or sink into it. A moment later the physics lowers the tool into
 * the real holder mesh (`seatTool`, in the worker, 0.1-1 s) and one more undo step moves the tool to where it rests.
 * The pointer is never blocked: the drag/drop preview stays on `placeTool`.
 */
import type { BatchOp, Op, Pose, Wall } from '@hsw-editor/core';
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
  const hung = deps.wall()?.items.find((item) => item.id === toolId);
  if (hung?.parentId === undefined || hung.locked) return 'skipped';
  const { parentId, pose: hungPose, slot } = hung;
  let seat: SeatOutcome | null;
  try {
    seat = await seatToolInHolder(toolId, parentId, deps, slot);
  } catch (error) {
    console.warn(
      `[physics] seat failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
  if (seat === null || samePose(seat.pose, hungPose)) return 'kept';
  const live = deps.wall()?.items.find((item) => item.id === toolId);
  // The user may have moved the tool on, or hung it elsewhere, while the worker was busy.
  if (
    live === undefined ||
    live.parentId !== parentId ||
    live.slot !== slot ||
    live.locked ||
    !samePose(live.pose, hungPose)
  )
    return 'stale';
  return deps.submit([seatOps(toolId, seat.pose)], 'seat') ? 'seated' : 'stale';
}
