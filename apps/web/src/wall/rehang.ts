/**
 * A hung tool whose size changed no longer sits where it was placed: the grip point is measured from the butt, so a longer
 * shaft moves the tool in its holder. After the dimension edit, once the rebuilt model is known, the tool is placed again in
 * the slot it occupies (same maths as a drop) as one more undo step. A tool that no longer fits stays where it is: the
 * compatibility panel says why.
 */
import { evaluateHolders, planHang, resolveDrop } from '@hsw-editor/compat';
import { bankStore } from '@/bank/client.ts';
import { paramsKey } from '@/bank/models.ts';
import { toolModelVersion } from '@/toolmodels/regen.ts';
import { resolveToolModel } from '@/toolmodels/resolve.ts';
import { attachContext } from './attach.ts';
import { currentWall } from './actions.ts';
import { submitOps } from './session.ts';

/** How long a rebuild is waited for; a slower one leaves the tool where it is. */
const MODEL_WAIT_MS = 8000;

function modelSettled(itemId: string): boolean {
  const wall = currentWall();
  const item = wall?.items.find((candidate) => candidate.id === itemId);
  if (!wall || !item) return true;
  const source = resolveToolModel(item, wall);
  return source === null || !source.pending;
}

function untilSettled(itemId: string): Promise<boolean> {
  if (modelSettled(itemId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(settled);
    };
    const unsubscribe = toolModelVersion.subscribe(() => {
      if (modelSettled(itemId)) finish(true);
    });
    const timer = setTimeout(() => finish(false), MODEL_WAIT_MS);
  });
}

/** Places the hung tool `itemId` again in its own slot; false when it is not hung, no longer fits or is locked. */
export async function rehangResizedTool(itemId: string): Promise<boolean> {
  const first = currentWall()?.items.find((candidate) => candidate.id === itemId);
  if (first?.kind !== 'tool' || first.parentId === undefined || first.slot === undefined) {
    return false;
  }
  const editedFor = paramsKey(first.params);
  if (!(await untilSettled(itemId))) return false;
  const wall = currentWall();
  const bank = bankStore.get();
  const item = wall?.items.find((candidate) => candidate.id === itemId);
  if (!wall || bank.status !== 'ready' || item?.parentId === undefined || item.locked) {
    return false;
  }
  // The edit was undone (or edited again) while the model was building: the tool is not this edit's to move. Compared by value:
  // every acknowledgement and echo of the server hands out new, equal objects.
  if (paramsKey(item.params) !== editedFor) return false;
  const { parentId, slot } = item;
  const ctx = attachContext(wall, bank.byId);
  const own = evaluateHolders(ctx, item)
    .find((evaluation) => evaluation.holderId === parentId)
    ?.freeSlots.find((free) => free.slot.index === slot);
  if (!own) return false;
  const resolution = resolveDrop(ctx, item, { x: own.world[0], y: own.world[1] });
  if (
    resolution.kind !== 'attach' ||
    resolution.target.holderId !== parentId ||
    resolution.target.slot !== slot
  ) {
    return false;
  }
  // Nothing moves (a library tool is never rebuilt, a failed rebuild keeps the default): no undo step for nothing.
  const { pose } = resolution.target.placement;
  const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
  if (
    same(pose.x, item.pose.x) &&
    same(pose.y, item.pose.y) &&
    same(pose.z, item.pose.z) &&
    same(pose.rotX, item.pose.rotX) &&
    same(pose.rotY, item.pose.rotY) &&
    same(pose.rotZ, item.pose.rotZ)
  ) {
    return false;
  }
  return submitOps([planHang(item, resolution.target)], 'rehang').ok;
}
