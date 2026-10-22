/**
 * Hanging tools on a wall: which holders accept a tool, where a dropped tool snaps, and invertible op
 * batches for hang, re-hang, holder move/rotate (tools travel with their holder) and holder removal (tools
 * are detached first). Pure: the caller supplies the bank/tool lookups and applies the returned ops.
 */
import {
  applyOp,
  type BatchOp,
  type LeafOp,
  OpError,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { compatibility } from './compatibility.ts';
import {
  apply,
  eulerToMatrix,
  type Mat3,
  matrixToEuler,
  multiply,
  roundTo,
  transpose,
  type Vec3,
} from './rotation.ts';
import {
  type MountSlot,
  mountSlots,
  placeTool,
  slotWorldPosition,
  type ToolPlacement,
  slotCount,
} from './slots.ts';
import {
  type Compatibility,
  compareIds,
  type HolderSpec,
  matchedEntry,
  type Reason,
  type ToolInterface,
} from './types.ts';

export interface AttachContext {
  wall: Wall;
  /** Bank element behind a holder item (by `bankId` / `variantId`); undefined when unknown. */
  holderSpec(item: WallItem): HolderSpec | undefined;
  /** Holding interface of a tool item (generated model or recognised object); undefined when unknown. */
  toolInterface(item: WallItem): ToolInterface | undefined;
}

export interface MountTarget {
  holderId: string;
  slot: number;
  compat: Compatibility;
  placement: ToolPlacement;
  /** Distance from the drop point to the slot anchor in the wall plane. */
  distanceMm: number;
}

export interface FreeSlot {
  slot: MountSlot;
  /** Wall-space anchor. */
  world: Vec3;
}

export interface HolderEvaluation {
  holderId: string;
  compat: Compatibility;
  /** Slots nobody else occupies (the tool's own slot counts as free); empty when the holder is full or incompatible. */
  freeSlots: FreeSlot[];
}

export type DropResolution =
  | { kind: 'attach'; target: MountTarget }
  | { kind: 'refuse'; holderId: string; compat: Compatibility; distanceMm: number }
  | { kind: 'free' };

export interface DropOptions {
  /** Largest drop-point to slot distance that still snaps. */
  radiusMm?: number;
  /** A drop inside an incompatible holder is refused unless a compatible slot is nearer than this. */
  overrideMm?: number;
}

export const DEFAULT_SNAP_RADIUS_MM = 120;
export const DEFAULT_OVERRIDE_MM = 40;

interface HolderEntry {
  item: WallItem;
  spec: HolderSpec;
  /** Tools hanging on it, in wall order. */
  occupants: WallItem[];
}

/** One O(items) pass: every holder with a known spec, with its hanging tools. */
function holderIndex(ctx: AttachContext): HolderEntry[] {
  const byId = new Map<string, HolderEntry>();
  for (const item of ctx.wall.items) {
    if (item.kind !== 'holder') continue;
    const spec = ctx.holderSpec(item);
    if (spec !== undefined) byId.set(item.id, { item, spec, occupants: [] });
  }
  for (const item of ctx.wall.items) {
    if (item.kind === 'tool' && item.parentId !== undefined)
      byId.get(item.parentId)?.occupants.push(item);
  }
  return [...byId.values()];
}

/** Tools hanging on `holderId`, in wall order. */
export function hungTools(wall: Wall, holderId: string): WallItem[] {
  return wall.items.filter((item) => item.kind === 'tool' && item.parentId === holderId);
}

/** Tools that are not hanging anywhere (no holder, or the holder no longer exists): the UI flags them. */
export function unmountedTools(wall: Wall): WallItem[] {
  const holderIds = new Set(wall.items.filter((item) => item.kind === 'holder').map((i) => i.id));
  return wall.items.filter(
    (item) =>
      item.kind === 'tool' && (item.parentId === undefined || !holderIds.has(item.parentId)),
  );
}

function evaluateHolder(
  toolItem: WallItem,
  tool: ToolInterface,
  holder: HolderEntry,
  rotation: Mat3,
): HolderEvaluation {
  const others = holder.occupants.filter((other) => other.id !== toolItem.id);
  const compat = compatibility(tool, holder.spec, { occupied: others.length });
  if (!compat.ok) return { holderId: holder.item.id, compat, freeSlots: [] };
  const entry = matchedEntry(holder.spec, compat);
  const taken = new Set(others.flatMap((other) => (other.slot === undefined ? [] : [other.slot])));
  const freeSlots = mountSlots(holder.spec, entry)
    .filter((slot) => !taken.has(slot.index))
    .map((slot) => ({ slot, world: slotWorldPosition(slot, holder.item.pose, rotation) }));
  return { holderId: holder.item.id, compat, freeSlots };
}

/** Compatibility and free slots of every holder on the wall for one tool: what the UI highlights while dragging. */
export function evaluateHolders(ctx: AttachContext, toolItem: WallItem): HolderEvaluation[] {
  const tool = ctx.toolInterface(toolItem);
  if (tool === undefined) return [];
  return holderIndex(ctx).map((holder) =>
    evaluateHolder(toolItem, tool, holder, eulerToMatrix(holder.item.pose)),
  );
}

/** Distance from a wall point to the holder's footprint rectangle (0 inside); `rotation` is the holder's. */
function distanceToHolder(
  at: { x: number; y: number },
  item: WallItem,
  spec: HolderSpec,
  rotation: Mat3,
): number {
  const local = apply(transpose(rotation), [at.x - item.pose.x, at.y - item.pose.y, 0]);
  const { min, max } = spec.bboxMm;
  const dx = Math.max(min.x - local[0], 0, local[0] - max.x);
  const dy = Math.max(min.y - local[1], 0, local[1] - max.y);
  return Math.hypot(dx, dy);
}

interface Candidate {
  holder: HolderEntry;
  slot: MountSlot;
  compat: Compatibility;
  /** Rounded to 0.01 mm so float noise never decides a tie. */
  distanceMm: number;
  /** The drop point lies inside this holder's footprint: such holders outrank every other one. */
  inside: boolean;
}

interface Refusal {
  holderId: string;
  compat: Compatibility;
  distanceMm: number;
}

/** Strict order: nearest, then best fit, then holder id, then slot index; the result never depends on input order. */
function ranksBefore(a: Candidate, b: Candidate): boolean {
  return (
    (Number(b.inside) - Number(a.inside) ||
      a.distanceMm - b.distanceMm ||
      b.compat.score - a.compat.score ||
      compareIds(a.holder.item.id, b.holder.item.id) ||
      a.slot.index - b.slot.index) < 0
  );
}

/** The refusal worth reporting: the nearest incompatible holder, ties broken by holder id. */
function refusesBefore(a: Refusal, b: Refusal): boolean {
  return (a.distanceMm - b.distanceMm || compareIds(a.holderId, b.holderId)) < 0;
}

/**
 * Where a tool dropped at `at` (wall plane, mm) ends up: the nearest free slot of a compatible holder within
 * the snap radius; a refusal (with the reasons) when the drop is on an incompatible holder or only incompatible
 * holders are near; otherwise it stays free. Ties break on score, holder id, slot index, so the result depends
 * only on the inputs. Holders whose footprint is farther than the radius are skipped outright: every slot
 * anchor lies inside its holder's bounds.
 */
export function resolveDrop(
  ctx: AttachContext,
  toolItem: WallItem,
  at: { x: number; y: number },
  options: DropOptions = {},
): DropResolution {
  const tool = ctx.toolInterface(toolItem);
  if (tool === undefined) return { kind: 'free' };
  const radius = options.radiusMm ?? DEFAULT_SNAP_RADIUS_MM;
  const override = options.overrideMm ?? DEFAULT_OVERRIDE_MM;
  let best: Candidate | null = null;
  let refusal: Refusal | null = null;
  for (const holder of holderIndex(ctx)) {
    const rotation = eulerToMatrix(holder.item.pose);
    const reachMm = roundTo(distanceToHolder(at, holder.item, holder.spec, rotation), 2);
    if (reachMm > radius) continue;
    const evaluation = evaluateHolder(toolItem, tool, holder, rotation);
    if (!evaluation.compat.ok) {
      const candidate: Refusal = {
        holderId: holder.item.id,
        compat: evaluation.compat,
        distanceMm: reachMm,
      };
      if (refusal === null || refusesBefore(candidate, refusal)) refusal = candidate;
      continue;
    }
    for (const free of evaluation.freeSlots) {
      const distanceMm = roundTo(Math.hypot(free.world[0] - at.x, free.world[1] - at.y), 2);
      // Dropped inside a compatible holder's footprint: its nearest slot counts however far it is (tall holders).
      if (distanceMm > radius && reachMm > 0) continue;
      const candidate: Candidate = {
        holder,
        slot: free.slot,
        compat: evaluation.compat,
        distanceMm,
        inside: reachMm === 0,
      };
      if (best === null || ranksBefore(candidate, best)) best = candidate;
    }
  }
  // Dropped inside an incompatible holder: refuse, unless a compatible slot is within `overrideMm` of the drop.
  if (
    refusal !== null &&
    refusal.distanceMm === 0 &&
    (best === null || (!best.inside && best.distanceMm >= override))
  ) {
    return { kind: 'refuse', ...refusal };
  }
  if (best !== null) {
    // Placement maths only for the winner: it is the one thing the caller consumes.
    const target: MountTarget = {
      holderId: best.holder.item.id,
      slot: best.slot.index,
      compat: best.compat,
      placement: placeTool(tool, best.holder.spec, best.slot, best.holder.item.pose),
      distanceMm: best.distanceMm,
    };
    return { kind: 'attach', target };
  }
  if (refusal !== null) return { kind: 'refuse', ...refusal };
  return { kind: 'free' };
}

function hangOps(toolId: string, target: MountTarget): LeafOp[] {
  const { pose } = target.placement;
  return [
    { type: 'attachItem', id: toolId, parentId: target.holderId, slot: target.slot },
    { type: 'rotateItem', id: toolId, rotX: pose.rotX, rotY: pose.rotY, rotZ: pose.rotZ },
    { type: 'moveItem', id: toolId, to: { x: pose.x, y: pose.y, z: pose.z } },
  ];
}

/** Hangs (or re-hangs) a tool already on the wall: attach + orient + move as one undo step. */
export function planHang(toolItem: WallItem, target: MountTarget): BatchOp {
  return { type: 'batch', label: 'hang', ops: hangOps(toolItem.id, target) };
}

/** Adds a new tool already hanging on its mount. */
export function planAddHung(draft: WallItem, target: MountTarget): BatchOp {
  if (draft.kind !== 'tool') {
    throw new OpError(
      'invalid_op',
      `${draft.id}: only tools hang on holders (kind is ${draft.kind})`,
    );
  }
  const { pose } = target.placement;
  // A cell anchor would make the reducer overwrite the slot position with the cell centre.
  const { cell: _cell, ...free } = draft;
  const item: WallItem = {
    ...free,
    parentId: target.holderId,
    slot: target.slot,
    pose: { ...draft.pose, ...pose },
  };
  return { type: 'batch', label: 'add and hang', ops: [{ type: 'addItem', item }] };
}

/** Takes a tool off its holder, leaving it where it hangs (the UI then flags it as unmounted). */
export function planDetach(toolItem: WallItem): BatchOp {
  return {
    type: 'batch',
    label: 'detach',
    ops: [{ type: 'attachItem', id: toolItem.id, parentId: null }],
  };
}

export interface AutoAttachResult {
  resolution: DropResolution;
  /** Hang batch when the drop snapped; null otherwise (a refusal or a free drop changes nothing here). */
  op: BatchOp | null;
}

/** Resolves a drop and, when it snaps, builds the batch that hangs the tool (existing item) in one go. */
export function autoAttach(
  ctx: AttachContext,
  toolItem: WallItem,
  at: { x: number; y: number },
  options: DropOptions = {},
): AutoAttachResult {
  const resolution = resolveDrop(ctx, toolItem, at, options);
  return {
    resolution,
    op: resolution.kind === 'attach' ? planHang(toolItem, resolution.target) : null,
  };
}

function carriedTools(wall: Wall, holderId: string): WallItem[] {
  const tools = hungTools(wall, holderId);
  const locked = tools.find((tool) => tool.locked);
  if (locked !== undefined) {
    throw new OpError(
      'item_locked',
      `tool ${locked.id} hangs on ${holderId} and is locked; unlock it first`,
    );
  }
  return tools;
}

function holderOf(wall: Wall, holderId: string): WallItem {
  const holder = wall.items.find((item) => item.id === holderId);
  if (holder === undefined) throw new OpError('item_not_found', `item ${holderId} does not exist`);
  return holder;
}

/** Moves a holder; every tool hanging on it moves by the same amount. One undo step. */
export function planMoveHolder(
  wall: Wall,
  holderId: string,
  to: Extract<LeafOp, { type: 'moveItem' }>['to'],
): BatchOp {
  const before = holderOf(wall, holderId);
  const tools = carriedTools(wall, holderId);
  const moveHolder: LeafOp = { type: 'moveItem', id: holderId, to };
  // Throwaway apply on purpose: the reducer is the single source of truth for how `to` is normalised
  // (cell centres, angle wrap) and it surfaces item_locked for the holder itself.
  const applied = applyOp(wall, moveHolder);
  // Nothing moved: leave the tools alone too (re-emitting their poses would drop cells and bump rev).
  if (!applied.changed) return { type: 'batch', label: 'move holder', ops: [moveHolder] };
  const after = holderOf(applied.wall, holderId);
  const dx = after.pose.x - before.pose.x;
  const dy = after.pose.y - before.pose.y;
  const dz = after.pose.z - before.pose.z;
  const carried: LeafOp[] = tools.map((tool) => ({
    type: 'moveItem',
    id: tool.id,
    to: {
      x: roundTo(tool.pose.x + dx),
      y: roundTo(tool.pose.y + dy),
      z: roundTo(tool.pose.z + dz),
    },
  }));
  return { type: 'batch', label: 'move holder', ops: [moveHolder, ...carried] };
}

/** Rotates a holder about its origin; hanging tools orbit with it and turn by the same rotation. */
export function planRotateHolder(wall: Wall, holderId: string, rotZ: number): BatchOp {
  const before = holderOf(wall, holderId);
  const tools = carriedTools(wall, holderId);
  const rotateHolder: LeafOp = { type: 'rotateItem', id: holderId, rotZ };
  // Throwaway apply on purpose (see planMoveHolder).
  const applied = applyOp(wall, rotateHolder);
  if (!applied.changed) return { type: 'batch', label: 'rotate holder', ops: [rotateHolder] };
  const after = holderOf(applied.wall, holderId);
  const delta = multiply(eulerToMatrix(after.pose), transpose(eulerToMatrix(before.pose)));
  const carried = tools.flatMap((tool): LeafOp[] => {
    const offset = apply(delta, [
      tool.pose.x - before.pose.x,
      tool.pose.y - before.pose.y,
      tool.pose.z - before.pose.z,
    ]);
    const euler = matrixToEuler(multiply(delta, eulerToMatrix(tool.pose)));
    return [
      { type: 'rotateItem', id: tool.id, rotX: euler.rotX, rotY: euler.rotY, rotZ: euler.rotZ },
      {
        type: 'moveItem',
        id: tool.id,
        to: {
          x: roundTo(before.pose.x + offset[0]),
          y: roundTo(before.pose.y + offset[1]),
          z: roundTo(before.pose.z + offset[2]),
        },
      },
    ];
  });
  return { type: 'batch', label: 'rotate holder', ops: [rotateHolder, ...carried] };
}

export interface RemoveHolderPlan {
  op: BatchOp;
  /** Tools that lose their mount: the UI flags them as unmounted. */
  detached: string[];
}

/** Removes a holder after detaching its tools (they stay on the wall, flagged). One undo step. */
export function planRemoveHolder(wall: Wall, holderId: string): RemoveHolderPlan {
  holderOf(wall, holderId);
  const tools = carriedTools(wall, holderId);
  const ops: LeafOp[] = [
    ...tools.map((tool): LeafOp => ({ type: 'attachItem', id: tool.id, parentId: null })),
    { type: 'removeItem', id: holderId },
  ];
  return {
    op: { type: 'batch', label: 'remove holder', ops },
    detached: tools.map((tool) => tool.id),
  };
}

export interface HangAudit {
  toolId: string;
  holderId: string;
  compat: Compatibility;
}

/** Every hung tool whose mount no longer suits it (e.g. after a variant swap or a hand edit). */
export function auditHangs(ctx: AttachContext): HangAudit[] {
  const out: HangAudit[] = [];
  for (const holder of holderIndex(ctx)) {
    for (const [position, toolItem] of holder.occupants.entries()) {
      const tool = ctx.toolInterface(toolItem);
      if (tool === undefined) continue;
      const compat = compatibility(tool, holder.spec, { occupied: position });
      if (!compat.ok) {
        out.push({ toolId: toolItem.id, holderId: holder.item.id, compat });
        continue;
      }
      const entry = matchedEntry(holder.spec, compat);
      const slots = slotCount(entry);
      if (toolItem.slot !== undefined && toolItem.slot >= slots) {
        const reason: Reason = {
          code: 'slot_out_of_range',
          params: { slot: toolItem.slot, slots },
        };
        out.push({
          toolId: toolItem.id,
          holderId: holder.item.id,
          compat: { ...compat, ok: false, score: 0, reasons: [...compat.reasons, reason] },
        });
      }
    }
  }
  return out;
}
