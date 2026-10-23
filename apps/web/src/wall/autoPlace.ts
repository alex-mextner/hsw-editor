/**
 * Where a tool added without a drop point (the Tools panel's +, the `tools.add` command) goes. It follows the
 * rules of a drop: the nearest free mount of a compatible holder takes the tool (the same compat maths as
 * `planToolDrag`, with no snap radius, so a holder anywhere on the board counts); with none, the tool lies free on the
 * nearest spot of the board that no other item covers. Reads the sizes the scene draws (`itemBounds`); the caller supplies the wall and the bank and
 * applies the returned ops.
 */
import {
  evaluateHolders,
  mountTargetFor,
  planAddHung,
  toolDraftOps,
  type MountTarget,
} from '@hsw-editor/compat';
import {
  applyOp,
  boardSizeMm,
  isSolid,
  itemWorldAabb,
  OpError,
  type Aabb,
  type LeafOp,
  type Op,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import type { ToolDragPayload } from '@/scene/toolDrop.ts';
import { boundsAabb, itemBounds } from '@/scene/itemBounds.ts';
import type { Vec2 } from '@/state/editor.ts';
import { attachContext } from './attach.ts';
import type { BankLookup } from './edits.ts';
import { presetDims } from './toolPresets.ts';

/**
 * - `hung`: on a free mount of a compatible holder.
 * - `free`: no holder takes the tool; it lies on a clear spot of the board.
 * - `no-room`: no holder takes it and the board has no clear spot big enough.
 * - `refused`: the wall refused the draft tool (a model reference that cannot be added) or it has no size to place.
 */
export type ToolAddPlan =
  | { readonly kind: 'hung' | 'free'; readonly itemId: string; readonly ops: readonly Op[] }
  | { readonly kind: 'no-room' }
  | { readonly kind: 'refused' };

/** Axis-aligned rectangle in the wall plane (the x/y of an `Aabb`: nothing here depends on height). */
interface Rect {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Footprint of a solid: the rectangle it covers in the wall plane and the world z range it fills. */
interface Footprint {
  readonly rect: Rect;
  readonly zMinMm: number;
  readonly zMaxMm: number;
}

/** A solid item of the wall with its footprint. */
interface Occupant extends Footprint {
  readonly item: WallItem;
}

/** Clear space kept between a free tool and its neighbours and the board edge. */
const CLEARANCE_MM = 5;
/** Search lattice of free spots: a tool sits on the nearest lattice point of the reference that is clear. */
const SCAN_STEP_MM = 10;
/** A hung tool may touch a neighbour; only a real overlap (deeper than this) rules a mount out. */
const TOUCH_MM = 1;

function rectOf(box: Aabb): Rect {
  return { minX: box.min.x, minY: box.min.y, maxX: box.max.x, maxY: box.max.y };
}

/** Whether `a` meets `b` grown by `marginMm` on every side (a negative margin shrinks `b`: only a deeper overlap counts). */
function meets(a: Rect, b: Rect, marginMm: number): boolean {
  return (
    a.minX < b.maxX + marginMm &&
    b.minX < a.maxX + marginMm &&
    a.minY < b.maxY + marginMm &&
    b.minY < a.maxY + marginMm
  );
}

/** Footprint of a world box. */
function footprintOfBox(box: Aabb): Footprint {
  return { rect: rectOf(box), zMinMm: box.min.z, zMaxMm: box.max.z };
}

/**
 * Footprint of an item, as big as the scene draws it (a holder at its parametric variant's size, one whose element
 * left the bank index as its placeholder); null for items with nothing solid to cover (photo references).
 */
function footprintOf(item: WallItem, wall: Wall, bank: BankLookup): Footprint | null {
  if (!isSolid(item)) return null;
  const bounds = itemBounds(item, wall, bank);
  return bounds === null ? null : footprintOfBox(itemWorldAabb(boundsAabb(bounds), item.pose));
}

/** Every solid item of the wall except the draft, with its footprint. */
function occupantsOf(wall: Wall, bank: BankLookup, draft: WallItem): Occupant[] {
  const occupants: Occupant[] = [];
  for (const item of wall.items) {
    if (item.id === draft.id) continue;
    const footprint = footprintOf(item, wall, bank);
    if (footprint !== null) occupants.push({ item, ...footprint });
  }
  return occupants;
}

/**
 * Whether an occupant can be in the way of the tool whose world box is `tool`: any item overlapping it in the wall plane
 * is, except board hardware (`board-part`: panels and plates the holders are mounted on) the tool stands clear of in z.
 */
function inTheWay(occupant: Occupant, tool: Footprint): boolean {
  return (
    occupant.item.kind !== 'board-part' ||
    (occupant.zMaxMm > tool.zMinMm && occupant.zMinMm < tool.zMaxMm)
  );
}

/**
 * The nearest free mount (to `reference`) of a compatible holder whose hung tool would not overlap another item.
 * Ties break on fit score, holder id, slot, so the result depends only on the inputs.
 */
function hangTarget(
  wall: Wall,
  bank: BankLookup,
  draft: WallItem,
  local: Aabb,
  reference: Vec2,
): MountTarget | null {
  const ctx = attachContext(wall, bank);
  const candidates = evaluateHolders(ctx, draft)
    .flatMap((evaluation) =>
      evaluation.freeSlots.map((free) => ({
        holderId: evaluation.holderId,
        slot: free.slot.index,
        score: evaluation.compat.score,
        distanceMm: Math.hypot(free.world[0] - reference.x, free.world[1] - reference.y),
      })),
    )
    .sort(
      (a, b) =>
        a.distanceMm - b.distanceMm ||
        b.score - a.score ||
        a.holderId.localeCompare(b.holderId) ||
        a.slot - b.slot,
    );
  if (candidates.length === 0) return null;
  const occupants = occupantsOf(wall, bank, draft);
  for (const candidate of candidates) {
    const target = mountTargetFor(ctx, draft, candidate.holderId, candidate.slot);
    if (target === null) continue;
    const hung = footprintOfBox(itemWorldAabb(local, { ...draft.pose, ...target.placement.pose }));
    // The tool interpenetrates its own holder and sits beside the tools of that holder by construction.
    const clear = !occupants.some(
      (occupant) =>
        occupant.item.id !== target.holderId &&
        !(occupant.item.kind === 'tool' && occupant.item.parentId === target.holderId) &&
        inTheWay(occupant, hung) &&
        meets(hung.rect, occupant.rect, -TOUCH_MM),
    );
    if (clear) return target;
  }
  return null;
}

/** Lattice values from `lo` to `hi` in `SCAN_STEP_MM` steps; `hi` itself is always included so a tool can sit flush with the far edge. */
function latticeAxis(lo: number, hi: number): number[] {
  const values: number[] = [];
  for (let value = lo; value < hi; value += SCAN_STEP_MM) values.push(value);
  values.push(hi);
  return values;
}

/** The clear lattice spot nearest to `reference` for the tool's butt, or null when the board has none. */
function freeSpot(
  wall: Wall,
  bank: BankLookup,
  draft: WallItem,
  local: Aabb,
  reference: Vec2,
): Vec2 | null {
  const { width, height } = boardSizeMm(wall.board);
  const footprint = footprintOfBox(itemWorldAabb(local, { ...draft.pose, x: 0, y: 0 }));
  const box = footprint.rect;
  const obstacles = occupantsOf(wall, bank, draft)
    .filter((occupant) => inTheWay(occupant, footprint))
    .map(({ rect }) => rect);
  const loX = CLEARANCE_MM - box.minX;
  const hiX = width - CLEARANCE_MM - box.maxX;
  const loY = CLEARANCE_MM - box.minY;
  const hiY = height - CLEARANCE_MM - box.maxY;
  if (hiX < loX || hiY < loY) return null;
  const centreX = (box.minX + box.maxX) / 2;
  const centreY = (box.minY + box.maxY) / 2;
  const ys = latticeAxis(loY, hiY);
  // One pass, keeping the nearest clear spot (ties: smaller x, then smaller y): the obstacle test only runs for spots
  // that would beat the best so far, and no lattice is ever materialised (boards can be metres across).
  let best: Vec2 | null = null;
  let bestDistance = Infinity;
  for (const x of latticeAxis(loX, hiX)) {
    for (const y of ys) {
      const distance = Math.hypot(x + centreX - reference.x, y + centreY - reference.y);
      if (distance >= bestDistance) continue;
      const at: Rect = {
        minX: x + box.minX,
        maxX: x + box.maxX,
        minY: y + box.minY,
        maxY: y + box.maxY,
      };
      if (obstacles.some((rect) => meets(at, rect, CLEARANCE_MM))) continue;
      best = { x, y };
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Plans adding a library tool: on the nearest free compatible holder mount when there is one, else on the clear spot
 * nearest to `reference` (a wall point, mm; it may lie off the board). The ops include the model reference.
 */
export function planToolAdd(
  wall: Wall,
  bank: BankLookup,
  payload: ToolDragPayload,
  reference: Vec2,
): ToolAddPlan {
  const { item, ops } = toolDraftOps(
    payload.toolClass,
    payload.label,
    reference,
    payload.dimsMm ?? presetDims(payload.toolClass),
    {
      ...(payload.params ? { params: payload.params } : {}),
      ...(payload.customToolId === undefined ? {} : { customToolId: payload.customToolId }),
      ...(payload.generatorClass === undefined ? {} : { generatorClass: payload.generatorClass }),
    },
  );
  const setup: readonly LeafOp[] = ops.filter((op) => op.type === 'addModelRef');
  let virtual: Wall;
  try {
    // The tool's model reference and the tool itself exist only in this throwaway wall.
    virtual = applyOp(wall, { type: 'batch', ops: [...setup, { type: 'addItem', item }] }).wall;
  } catch (error) {
    if (error instanceof OpError) return { kind: 'refused' };
    throw error;
  }
  const bounds = itemBounds(item, virtual, bank);
  if (bounds === null) return { kind: 'refused' };
  const local = boundsAabb(bounds);
  const target = hangTarget(virtual, bank, item, local, reference);
  if (target !== null) {
    return { kind: 'hung', itemId: item.id, ops: [...setup, planAddHung(item, target)] };
  }
  const spot = freeSpot(virtual, bank, item, local, reference);
  if (spot === null) return { kind: 'no-room' };
  const placed: WallItem = { ...item, pose: { ...item.pose, x: spot.x, y: spot.y } };
  return { kind: 'free', itemId: item.id, ops: [...setup, { type: 'addItem', item: placed }] };
}
