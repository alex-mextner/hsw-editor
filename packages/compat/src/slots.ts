/**
 * Where on a holder a tool hangs and how it is oriented. The bank publishes what a holder accepts
 * (`fitsTool`) but not the hole or hook positions, so slot anchors are derived from the element category
 * and bounds with three mount styles that cover the bank's holders:
 *
 * - `top-holes`: holes or slots in the top face (screwdriver rails, cups, racks, forks). The tool stands
 *   vertically in the wall plane, inserted from above.
 * - `hook`: a bar or peg sticking out of the wall. The tool hangs on its hang point, flat in the wall plane.
 * - `tray`: a cradle or tray (tape, measuring tools, drills, boxes). The tool rests on the tray floor,
 *   upright and leaning against the back plate.
 *
 * Orientation follows from the tool's holding interface: hung tools put their hang point on top, standing
 * tools go in tip first or butt first depending on the class. Everything stays in the wall plane, so a pose
 * is `rotZ` plus a position; holder rotation turns anchors and tools together.
 */
import type { Pose } from '@hsw-editor/core';
import {
  apply,
  roundTo,
  eulerToMatrix,
  type Mat3,
  matrixToEuler,
  multiply,
  rotationZ,
  type Vec3,
} from './rotation.ts';
import type { HolderSpec, MountEntry, ToolInterface } from './types.ts';

export type MountStyle = 'top-holes' | 'hook' | 'tray';

const TOP_HOLE_CATEGORIES: readonly string[] = [
  'holders/screwdrivers',
  'holders/hex-keys',
  'holders/pliers',
  'holders/wrenches',
  'holders/hammers',
  'holders/cutting',
  'holders/clamps',
  'holders/other',
  'holders/small-parts',
  'bins/cups',
];

export function mountStyleOf(holder: Pick<HolderSpec, 'category'>): MountStyle {
  if (holder.category.startsWith('hooks') || holder.category === 'accessories/cables')
    return 'hook';
  if (TOP_HOLE_CATEGORIES.includes(holder.category)) return 'top-holes';
  return 'tray';
}

export interface MountSlot {
  /** 0-based; the value stored as `WallItem.slot`. */
  index: number;
  /** Where the tool's reference point goes, in the holder frame (anchor cell centre, z from the wall). */
  anchor: Vec3;
}

/** Back plate and tray floor thickness assumed when resting a tool in a tray (mm). */
const TRAY_PLATE_MM = 4;
/** Share of the hook bar length at which a hung tool sits. */
const HOOK_BAR_FRACTION = 0.6;

export function slotCount(entry: MountEntry | null): number {
  return Math.max(1, Math.floor(entry?.capacity ?? 1));
}

function slotAnchor(style: MountStyle, x: number, bbox: HolderSpec['bboxMm']): Vec3 {
  const { min, max } = bbox;
  switch (style) {
    case 'top-holes':
      return [x, max.y, roundTo((min.z + max.z) / 2)];
    case 'hook':
      return [x, 0, roundTo(min.z + HOOK_BAR_FRACTION * (max.z - min.z))];
    case 'tray':
      return [x, roundTo(min.y + TRAY_PLATE_MM), TRAY_PLATE_MM];
  }
}

/** Slots of a holder for the entry that matched, left to right (hooks and trays have `capacity` slots too). */
export function mountSlots(holder: HolderSpec, entry: MountEntry | null): MountSlot[] {
  const { min, max } = holder.bboxMm;
  const style = mountStyleOf(holder);
  const count = slotCount(entry);
  const width = max.x - min.x;
  const slots: MountSlot[] = [];
  for (let index = 0; index < count; index++) {
    const x = roundTo(min.x + ((index + 0.5) * width) / count);
    slots.push({ index, anchor: slotAnchor(style, x, holder.bboxMm) });
  }
  return slots;
}

/** Classes that go into a hole tip first (blade down); everything else stands butt first. */
const TIP_DOWN_CLASSES: ReadonlySet<string> = new Set([
  'screwdriver',
  'hex-key',
  'pliers',
  'snips',
  'scissors',
  'knife',
  'file',
]);
const MAX_INSERT_MM = 60;
const INSERT_FRACTION = 0.35;

/** The tool goes into a slot or hole working end (tip) first: its class, or a coarser class it also fits, is a tip-down one. */
export function prefersTipDown(tool: Pick<ToolInterface, 'toolClass' | 'broader'>): boolean {
  return (
    TIP_DOWN_CLASSES.has(tool.toolClass) ||
    (tool.broader ?? []).some((id) => TIP_DOWN_CLASSES.has(id))
  );
}

export interface ToolPlacement {
  /** Tool pose in wall space (degrees, mm); only `rotZ` is non-zero for the in-plane styles. */
  pose: Pose;
  /** Direction the working end points, in wall space: `up`, `down`. */
  workingEnd: 'up' | 'down';
}

interface Grip {
  /** Tool-frame point that sits on the slot anchor. */
  point: Vec3;
  workingEnd: 'up' | 'down';
}

function gripOf(style: MountStyle, tool: ToolInterface, holder: HolderSpec): Grip {
  const length = tool.lengthMm;
  if (style === 'hook') {
    const hang = tool.hang?.point ?? [0, length, 0];
    // Hang point in the upper half of the tool: working end up, butt hangs down; otherwise the reverse.
    return { point: hang, workingEnd: hang[1] > length / 2 ? 'up' : 'down' };
  }
  if (style === 'tray') return { point: [0, 0, -tool.maxSection.t / 2], workingEnd: 'up' };
  const pocket = holder.bboxMm.max.y - holder.bboxMm.min.y;
  const depth = Math.min(MAX_INSERT_MM, INSERT_FRACTION * length, 0.8 * pocket);
  const tipDown = prefersTipDown(tool);
  return tipDown
    ? { point: [0, length - depth, 0], workingEnd: 'down' }
    : { point: [0, depth, 0], workingEnd: 'up' };
}

/**
 * Pose of `tool` hanging in `slot` of a holder placed at `holderPose`. The tool origin is solved so that the
 * grip point lands on the (rotated) slot anchor; the tool is turned about Z so the working end points where
 * the grip says, plus the holder's own rotation.
 */
export function placeTool(
  tool: ToolInterface,
  holder: HolderSpec,
  slot: MountSlot,
  holderPose: Pose,
): ToolPlacement {
  const style = mountStyleOf(holder);
  const grip = gripOf(style, tool, holder);
  const holderRotation: Mat3 = eulerToMatrix(holderPose);
  const toolRotation = multiply(holderRotation, rotationZ(grip.workingEnd === 'up' ? 0 : 180));
  const anchorWorld = apply(holderRotation, slot.anchor);
  const gripWorld = apply(toolRotation, grip.point);
  const euler = matrixToEuler(toolRotation);
  return {
    pose: {
      x: roundTo(holderPose.x + anchorWorld[0] - gripWorld[0]),
      y: roundTo(holderPose.y + anchorWorld[1] - gripWorld[1]),
      z: roundTo(holderPose.z + anchorWorld[2] - gripWorld[2]),
      ...euler,
    },
    workingEnd: grip.workingEnd,
  };
}

/**
 * Wall-space position of a slot anchor (what a drop point is compared against). Pass the holder's rotation
 * when positioning several slots of one holder so the matrix is built once.
 */
export function slotWorldPosition(
  slot: MountSlot,
  holderPose: Pose,
  rotation: Mat3 = eulerToMatrix(holderPose),
): Vec3 {
  const rotated = apply(rotation, slot.anchor);
  return [holderPose.x + rotated[0], holderPose.y + rotated[1], holderPose.z + rotated[2]];
}
