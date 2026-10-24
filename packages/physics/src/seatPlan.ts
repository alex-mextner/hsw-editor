/**
 * Seat planning shared by the editor (physics worker) and the daemon: what a slot of a holder asks of the seat search
 * (`seatSlotInput`), the ops that move a tool to its seat (`seatOps`) and the pass over a whole wall (`planSeatAll`),
 * so an agent-built wall is seated exactly like one the user seats with the Seat tools command.
 */
import {
  compatibility,
  type Compatibility,
  eulerToMatrix,
  type HolderSpec,
  isUpright,
  matchedEntry,
  type MountSlot,
  prefersTipDown,
  slotHalfWidthMm,
  slotWorldPosition,
  type ToolInterface,
} from '@hsw-editor/compat';
import {
  applyOp,
  type BatchOp,
  type LeafOp,
  type Pose,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { defaultLoadCapacityG } from './load.ts';
import type { HolderCandidate } from './rank.ts';

/** What a holder's slot carries for a tool: the bank's number for the matched entry, else the category default. */
export function loadLimitG(tool: ToolInterface | undefined, holder: HolderSpec): number {
  const compat = tool === undefined ? null : compatibility(tool, holder);
  const entry = compat === null ? null : matchedEntry(holder, compat);
  return entry?.maxLoadG ?? defaultLoadCapacityG(holder.category);
}

/** A seat search for one slot: everything of a `HolderCandidate` except the bodies. */
export type SeatSlotInput = Omit<HolderCandidate, 'holderId' | 'holder' | 'neighbours'>;

/** The slot of a holder standing at `holderPose` as a seat search sees it; null when the holder is not upright (it keeps the compat pose). */
export function seatSlotInput(
  holderPose: Pose,
  element: HolderSpec,
  slot: MountSlot,
  slotCount: number,
  compat: Pick<Compatibility, 'score'>,
  tool: ToolInterface,
): SeatSlotInput | null {
  if (!isUpright(holderPose)) return null;
  return {
    anchor: slotWorldPosition(slot, holderPose, eulerToMatrix(holderPose)),
    halfWidthMm: slotHalfWidthMm(element, slotCount),
    tipDown: prefersTipDown(tool),
    compatScore: compat.score,
    maxLoadG: loadLimitG(tool, element),
  };
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

/** A tool item known to hang on a holder in a numbered slot. */
export type HungItem = WallItem & { parentId: string; slot: number };

/**
 * Seats one hung tool in its own slot. `wall` is the wall as this tool should see it (tools still waiting their turn are left
 * out so they do not block its slot). Null when no seat exists (no model, rotated holder, the holder does not take it).
 */
export type SeatOne = (tool: HungItem, wall: Wall) => Promise<Pose | null>;

/** What `planSeatAll` found: the ops to apply and what became of every hung tool. */
export interface SeatAllPlan {
  /** Rotate and move per tool that ends up somewhere else; empty when nothing moves. */
  readonly ops: readonly LeafOp[];
  readonly seated: readonly string[];
  /** Already rest where the physics puts them. */
  readonly unchanged: readonly string[];
  /** No seat exists: the pose stays and the physics check flags it. */
  readonly kept: readonly string[];
  /** Hung without a slot number: which slot they take is anybody's guess, so they are left to the user. */
  readonly unslotted: readonly string[];
}

/**
 * Seats every tool that hangs on a holder, one after the other (each against the poses the earlier ones already have).
 * This is how a wall built before physics existed, or by an agent from compatibility poses, ends up with its tools inside
 * their holders. `onError` hears a seat that threw (it counts as no seat); the plan itself never throws.
 */
export async function planSeatAll(
  start: Wall,
  seatOne: SeatOne,
  onError?: (toolId: string, error: unknown) => void,
): Promise<SeatAllPlan> {
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
  const view = (current: string): Wall => ({
    ...local,
    items: local.items.filter((i) => i.id === current || !waiting.has(i.id)),
  });
  const attempt = async (item: WallItem, parentId: string, slot: number): Promise<Pose | null> => {
    try {
      return await seatOne({ ...item, parentId, slot }, view(item.id));
    } catch (error) {
      onError?.(item.id, error);
      return null;
    }
  };
  for (const item of start.items) {
    if (item.kind !== 'tool' || item.parentId === undefined || item.locked) continue;
    if (item.slot === undefined) {
      unslotted.push(item.id);
      continue;
    }
    waiting.delete(item.id);
    const pose = await attempt(item, item.parentId, item.slot);
    if (pose === null) {
      kept.push(item.id);
    } else if (samePose(pose, item.pose)) {
      unchanged.push(item.id);
    } else {
      local = applyOp(local, seatOps(item.id, pose)).wall;
      seated.push(item.id);
    }
  }
  // Tools that did not move (or could not be seated) were hidden from the ones seated before them: now that every pose
  // is known, each seated tool looks once more at all of them and settles again if one is in its way.
  if (seated.length > 0 && (unchanged.length > 0 || kept.length > 0)) {
    for (const id of seated) {
      const item = local.items.find((candidate) => candidate.id === id);
      if (item === undefined || item.parentId === undefined || item.slot === undefined) continue;
      const again = await attempt(item, item.parentId, item.slot);
      if (again === null || samePose(again, item.pose)) continue;
      local = applyOp(local, seatOps(id, again)).wall;
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
  return { ops, seated: moved, unchanged, kept, unslotted };
}
