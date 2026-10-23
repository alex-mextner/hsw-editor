/** Web-side glue for `@hsw-editor/compat`: how the bank and the wall answer its holder and tool lookups. */
import {
  BLOCKING_REASONS,
  type HolderSpec,
  type AttachContext,
  type DropResolution,
  evaluateHolders,
  planMoveHolder,
  resolveDrop,
} from '@hsw-editor/compat';
import type { GridCell, LeafOp, Wall, WallItem } from '@hsw-editor/core';
import type { AttachHolderState, AttachPreview, Vec2 } from '@/state/editor.ts';
import { toolClassOfItem, toolInterfaceOf } from './toolInterface.ts';
import { resolveToolModel } from '@/toolmodels/resolve.ts';
import { presetDims, toolDims, type Dims3 } from './toolPresets.ts';

export function attachContext(wall: Wall, bank: ReadonlyMap<string, HolderSpec>): AttachContext {
  return {
    wall,
    holderSpec: (item) => (item.bankId === undefined ? undefined : bank.get(item.bankId)),
    toolInterface: (item) => toolInterfaceOf(item, wall),
  };
}

const FALLBACK_BOX: Dims3 = { x: 40, y: 150, z: 30 };

/** Box the scene draws for a tool (its params and model win over the class preset). */
export function toolBox(tool: WallItem, wall: Wall): Dims3 {
  const model = resolveToolModel(tool, wall);
  if (model) return model.dimsMm;
  const toolClass = toolClassOfItem(tool, wall);
  return toolDims(tool, wall) ?? (toolClass === undefined ? FALLBACK_BOX : presetDims(toolClass));
}

/** Where a tool's box sits in the tool frame: origin on the principal axis at the butt, +Y towards the tip. */
export function toolBoxCentre(box: Dims3): Dims3 {
  return { x: 0, y: box.y / 2, z: 0 };
}

/** Centre of the box `toolBox` returns: the generated model's own centre, else the stand-in box's. */
export function toolBoxCentreOf(tool: WallItem, wall: Wall): Dims3 {
  return resolveToolModel(tool, wall)?.centreMm ?? toolBoxCentre(toolBox(tool, wall));
}

/** Where a dragged item ends up: a lattice cell (snapped) or the exact point (free). */
export interface DraggedPose {
  readonly x: number;
  readonly y: number;
  readonly cell: GridCell | undefined;
}

/**
 * Ops that put every item of `poses` where it was dragged. A holder goes through `planMoveHolder`, which
 * carries its hanging tools; those tools are then skipped here. A tool moved on its own is taken off its
 * holder first. Throws `OpError` when a holder carries a locked tool.
 */
export function moveItemsOps(wall: Wall, poses: ReadonlyMap<string, DraggedPose>): LeafOp[] {
  const byId = new Map(wall.items.map((item) => [item.id, item]));
  const ops: LeafOp[] = [];
  for (const [id, pose] of poses) {
    const item = byId.get(id);
    const to = pose.cell ? { cell: pose.cell } : { x: pose.x, y: pose.y };
    if (item?.kind === 'holder') {
      ops.push(...planMoveHolder(wall, id, to).ops);
      continue;
    }
    if (item?.parentId !== undefined && byId.get(item.parentId)?.kind === 'holder') {
      if (poses.has(item.parentId)) continue;
      ops.push({ type: 'attachItem', id, parentId: null });
    }
    ops.push({ type: 'moveItem', id, to });
  }
  return ops;
}

export interface ToolDragPlan {
  readonly resolution: DropResolution;
  readonly preview: AttachPreview;
}

/**
 * What dropping `tool` at the wall point `point` would do, plus everything the viewport shows for it: which
 * mounts glow, the ghost at the snapped pose and the reasons of a refusal. `free` (Alt) skips the snapping
 * and the highlighting altogether.
 */
export function planToolDrag(
  wall: Wall,
  bank: ReadonlyMap<string, HolderSpec>,
  tool: WallItem,
  point: Vec2,
  cursor: Vec2,
  free: boolean,
): ToolDragPlan {
  const ctx = attachContext(wall, bank);
  const holders = new Map<string, AttachHolderState>();
  if (free) {
    return {
      resolution: { kind: 'free' },
      preview: { holders, target: null, ghost: null, refusal: null, cursor },
    };
  }
  for (const evaluation of evaluateHolders(ctx, tool)) {
    holders.set(evaluation.holderId, {
      ok: evaluation.compat.ok,
      slots: evaluation.compat.ok
        ? evaluation.freeSlots.map((free) => ({
            slot: free.slot.index,
            x: free.world[0],
            y: free.world[1],
          }))
        : [],
    });
  }
  const resolution = resolveDrop(ctx, tool, point);
  const box = toolBox(tool, wall);
  const dimsMm = { x: box.x, y: box.y, z: box.z };
  const centreMm = toolBoxCentreOf(tool, wall);
  const toolClass = toolClassOfItem(tool, wall) ?? '';
  switch (resolution.kind) {
    case 'attach':
      return {
        resolution,
        preview: {
          holders,
          target: { holderId: resolution.target.holderId, slot: resolution.target.slot },
          ghost: { pose: resolution.target.placement.pose, dimsMm, centreMm, valid: true },
          refusal: null,
          cursor,
        },
      };
    case 'refuse':
      // Only a pointer inside the unsuitable holder is refused; beside it the tool simply lies free.
      if (resolution.distanceMm > 0) {
        return {
          resolution: { kind: 'free' },
          preview: { holders, target: null, ghost: null, refusal: null, cursor },
        };
      }
      return {
        resolution,
        preview: {
          holders,
          target: null,
          ghost: null,
          refusal: {
            holderId: resolution.holderId,
            toolClass,
            reasons: resolution.compat.reasons.filter((reason) =>
              BLOCKING_REASONS.has(reason.code),
            ),
          },
          cursor,
        },
      };
    case 'free':
      return {
        resolution,
        preview: { holders, target: null, ghost: null, refusal: null, cursor },
      };
  }
}
