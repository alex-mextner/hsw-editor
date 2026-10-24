/**
 * A hung tool whose size changed no longer sits where it was placed: the grip point is measured from the butt, so a longer
 * shaft moves the tool in its holder. After the dimension edit, once the rebuilt model is known, the tool is placed again in
 * the slot it occupies as one more undo step. The physics seats it (`seatTool`: the rebuilt model lowered into the real
 * holder mesh, so a longer shaft goes deeper into its hole instead of floating above it); without a seat (physics checks off,
 * a rotated holder, a tool the holder cannot take in the physics' eyes) the compatibility maths of a drop place it. A tool
 * that no longer fits stays where it is: the compatibility panel says why.
 */
import { evaluateHolders, planHang, resolveDrop } from '@hsw-editor/compat';
import { samePose, seatOps } from '@hsw-editor/physics';
import { paramsKey } from '@/bank/models.ts';
import { livePostStepDeps, untilToolModelSettled } from '@/physics/context.ts';
import {
  seatToolInHolder,
  stillHung,
  warnSeatFailed,
  type PostStepDeps,
  type SeatOutcome,
} from '@/physics/seat.ts';
import { attachContext } from './attach.ts';

/** What the editor provides: the physics post-step inputs, and the wait for the rebuilt model. */
export interface RehangDeps {
  readonly post: PostStepDeps;
  /** Resolves true when the model of the tool is no longer being rebuilt, false when that took too long. */
  readonly settled: (itemId: string) => Promise<boolean>;
}

/**
 * `seated`: moved to the physics' resting pose. `replaced`: moved by the compatibility maths (no seat). `unchanged`:
 * already where it belongs, no undo step. `skipped`: not hung, locked, edited or moved meanwhile, no longer fits,
 * or the rebuild did not finish.
 */
export type RehangStatus = 'seated' | 'replaced' | 'unchanged' | 'skipped';

export async function rehangWith(deps: RehangDeps, itemId: string): Promise<RehangStatus> {
  const { post } = deps;
  const firstWall = post.wall();
  const first = firstWall?.items.find((candidate) => candidate.id === itemId);
  if (first?.kind !== 'tool' || first.parentId === undefined || first.slot === undefined) {
    return 'skipped';
  }
  const editedFor = paramsKey(first.params);
  if (!(await deps.settled(itemId))) return 'skipped';
  const wall = post.wall();
  const ctx = wall === null ? null : post.context(wall);
  const item = wall?.items.find((candidate) => candidate.id === itemId);
  if (
    wall === null ||
    wall.id !== firstWall?.id ||
    ctx === null ||
    item?.parentId === undefined ||
    item.locked
  ) {
    return 'skipped';
  }
  // The edit was undone (or edited again) while the model was building: the tool is not this edit's to move. Compared by value:
  // every acknowledgement and echo of the server hands out new, equal objects.
  if (paramsKey(item.params) !== editedFor) return 'skipped';
  // The tool must still be the one the edit was made on: it may have been moved or hung elsewhere while the model was building.
  const { parentId, slot, pose: before } = item;
  if (item.parentId !== first.parentId || item.slot !== first.slot) return 'skipped';
  const attach = attachContext(wall, ctx.bank);
  const own = evaluateHolders(attach, item)
    .find((evaluation) => evaluation.holderId === parentId)
    ?.freeSlots.find((free) => free.slot.index === slot);
  if (!own) return 'skipped';
  const resolution = resolveDrop(attach, item, { x: own.world[0], y: own.world[1] });
  if (
    resolution.kind !== 'attach' ||
    resolution.target.holderId !== parentId ||
    resolution.target.slot !== slot
  ) {
    return 'skipped';
  }

  let seat: SeatOutcome | null = null;
  if (post.enabled()) {
    try {
      seat = await seatToolInHolder(itemId, parentId, post, slot);
    } catch (error) {
      warnSeatFailed(itemId, error);
    }
    // The worker took a moment: the user may have moved or edited the tool meanwhile.
    const liveWall = post.wall();
    const live = liveWall?.items.find((candidate) => candidate.id === itemId);
    if (
      liveWall?.id !== wall.id ||
      liveWall.rev !== wall.rev ||
      !stillHung(live, { parentId, slot, pose: before }) ||
      paramsKey(live?.params ?? {}) !== editedFor
    ) {
      return 'skipped';
    }
  }

  const pose = seat?.pose ?? resolution.target.placement.pose;
  // Nothing moves (a library tool is never rebuilt, a failed rebuild keeps the default): no undo step for nothing.
  if (samePose(pose, before)) return 'unchanged';
  const ops = seat === null ? [planHang(item, resolution.target)] : [seatOps(itemId, pose)];
  if (!post.submit(ops, 'rehang')) return 'skipped';
  return seat === null ? 'replaced' : 'seated';
}

/** Places the hung tool `itemId` again in its own slot; false when it is not hung, no longer fits or is locked. */
export async function rehangResizedTool(itemId: string): Promise<boolean> {
  const status = await rehangWith(
    { post: livePostStepDeps(), settled: untilToolModelSettled },
    itemId,
  );
  return status === 'seated' || status === 'replaced';
}
