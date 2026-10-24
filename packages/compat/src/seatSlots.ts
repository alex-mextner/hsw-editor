/**
 * The slot a tool is seated in, shared by the editor's physics worker plan and the daemon's seat proposals so both
 * pick the same slot, window and upright rule: which slot a tool takes in a holder on a wall, how far either side of the
 * slot centre a seated tool may settle, and whether a holder can be seated into at all.
 */
import type { Pose, Wall, WallItem } from '@hsw-editor/core';
import { compatibility } from './compatibility.ts';
import { type MountSlot, mountSlots } from './slots.ts';
import { type Compatibility, type HolderSpec, matchedEntry, type ToolInterface } from './types.ts';

/** Half the slot pitch, capped: a tool is lowered at most this far either side of the slot centre (mm). */
const MAX_SLOT_HALF_WIDTH_MM = 14;

/** Seating lowers a tool straight down in the holder's own frame: only an upright holder is seated. */
export function isUpright(pose: Pose): boolean {
  const turn = ((pose.rotZ % 360) + 360) % 360;
  return Math.abs(pose.rotX) < 0.5 && Math.abs(pose.rotY) < 0.5 && (turn < 0.5 || turn > 359.5);
}

/** Lateral search window of a seat around the slot centre: half the slot pitch of a holder of `slots` slots, capped (mm). */
export function slotHalfWidthMm(element: Pick<HolderSpec, 'bboxMm'>, slots: number): number {
  const width = element.bboxMm.max.x - element.bboxMm.min.x;
  return Math.min(width / Math.max(1, slots) / 2, MAX_SLOT_HALF_WIDTH_MM);
}

/** Slots a holder element offers for a compatibility result. */
export function slotsOf(
  element: HolderSpec,
  compat: Compatibility,
): { slots: MountSlot[]; count: number } {
  const slots = mountSlots(element, matchedEntry(element, compat));
  return { slots, count: slots.length };
}

/** A slot of a holder that is on the wall. */
export interface WallSlot<E extends HolderSpec = HolderSpec> {
  readonly holderItem: WallItem;
  readonly element: E;
  readonly compat: Compatibility;
  readonly slot: MountSlot;
}

/**
 * The slot `toolItem` takes (or would take) in `holderItem`: `wanted` when given, else the first slot nobody else uses.
 * Null when the holder does not take the tool or has no such slot.
 */
export function wallSlot<E extends HolderSpec>(
  wall: Wall,
  toolItem: WallItem,
  holderItem: WallItem,
  element: E,
  tool: ToolInterface,
  wanted?: number,
): WallSlot<E> | null {
  const others = wall.items.filter(
    (item) => item.kind === 'tool' && item.parentId === holderItem.id && item.id !== toolItem.id,
  );
  const compat = compatibility(tool, element, { occupied: others.length });
  if (!compat.ok) return null;
  const taken = new Set(others.flatMap((other) => (other.slot === undefined ? [] : [other.slot])));
  const { slots } = slotsOf(element, compat);
  const slot =
    wanted === undefined
      ? slots.find((s) => !taken.has(s.index))
      : slots.find((s) => s.index === wanted);
  return slot === undefined ? null : { holderItem, element, compat, slot };
}
