/**
 * Tool presets for the wall-from-scratch flow: a tool class (bank vocabulary) with typical dimensions.
 * A preset becomes a `tool` item backed by a file-less ModelRef, drawn as a proportional box until a
 * better reference model is found; the user then edits the dimensions and picks a holder for it.
 */
import type { Wall, WallItem } from '@hsw-editor/core';
import { defaultDimsOfTool } from '@/toolmodels/resolve.ts';
import { paramsDraftFor } from '@/widgets/draft.ts';

export interface Dims3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Typical bounding box (width, length, thickness) in mm per tool class; unknown classes get a generic box. */
const PRESET_DIMS: Readonly<Record<string, Dims3>> = {
  screwdriver: { x: 28, y: 210, z: 28 },
  pliers: { x: 75, y: 180, z: 25 },
  snips: { x: 70, y: 170, z: 25 },
  wrench: { x: 35, y: 200, z: 12 },
  'hex-key': { x: 60, y: 90, z: 6 },
  drill: { x: 80, y: 230, z: 210 },
  caliper: { x: 40, y: 190, z: 16 },
  'tape-measure': { x: 75, y: 75, z: 40 },
  'tape-roll': { x: 100, y: 100, z: 50 },
  hammer: { x: 55, y: 300, z: 30 },
  scissors: { x: 75, y: 200, z: 15 },
  knife: { x: 25, y: 160, z: 20 },
  clamp: { x: 60, y: 150, z: 35 },
  'bit-set': { x: 80, y: 95, z: 25 },
  multimeter: { x: 90, y: 180, z: 40 },
  file: { x: 30, y: 250, z: 10 },
  saw: { x: 60, y: 450, z: 12 },
  brush: { x: 40, y: 220, z: 20 },
  pen: { x: 14, y: 150, z: 14 },
  ruler: { x: 30, y: 300, z: 3 },
  spool: { x: 80, y: 80, z: 60 },
  cable: { x: 90, y: 90, z: 30 },
  'usb-stick': { x: 20, y: 60, z: 10 },
  'sd-card': { x: 24, y: 32, z: 2 },
  'spray-can': { x: 65, y: 65, z: 200 },
  toothbrush: { x: 20, y: 190, z: 15 },
  screws: { x: 60, y: 60, z: 30 },
  // Finer classes: the default generated model's bounding box.
  chisel: { x: 30, y: 225, z: 30 },
  punch: { x: 9, y: 125, z: 9 },
  hacksaw: { x: 174, y: 424, z: 28 },
  level: { x: 62, y: 600, z: 27 },
  square: { x: 100, y: 300, z: 24 },
  'long-nose-pliers': { x: 56, y: 200, z: 15 },
  'locking-pliers': { x: 57, y: 250, z: 17 },
  'water-pump-pliers': { x: 75, y: 250, z: 17 },
  crimper: { x: 55, y: 180, z: 17 },
  'hex-key-set': { x: 77, y: 92, z: 34 },
};

const GENERIC: Dims3 = { x: 40, y: 150, z: 30 };

export function presetDims(toolClassId: string): Dims3 {
  return PRESET_DIMS[toolClassId] ?? GENERIC;
}

/** Names of the item params that override a tool's reference dimensions (mm). */
export const TOOL_PARAM_KEYS = {
  width: 'width',
  length: 'length',
  thickness: 'thickness',
} as const;

/** Reference dimensions of a tool (its model's size); the user's overrides are not applied. */
export function toolBaseDims(item: WallItem, wall: Wall): Dims3 | null {
  // A tool drawn by a generated model is as big as that model; a preset's rough box is only a stand-in. A size measured on a
  // photo (vision) stays what the photo said.
  if (item.source.type !== 'vision') {
    const generated = defaultDimsOfTool(item, wall);
    if (generated) return generated;
  }
  const model = item.modelRefId
    ? wall.models.find((candidate) => candidate.id === item.modelRefId)
    : undefined;
  return model?.dimensionsMm ?? null;
}

/**
 * Bounding box of a tool item: the user's `params` (or the dimension widget's draft) always win over
 * the dimensions of its reference model (fitted/preset), per axis. Null when there are no dimensions.
 */
export function toolDims(item: WallItem, wall: Wall): Dims3 | null {
  const base = toolBaseDims(item, wall);
  const params = paramsDraftFor(item.id) ?? item.params;
  const x = params[TOOL_PARAM_KEYS.width] ?? base?.x;
  const y = params[TOOL_PARAM_KEYS.length] ?? base?.y;
  const z = params[TOOL_PARAM_KEYS.thickness] ?? base?.z;
  return x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : null;
}
