/**
 * The model reference and tool item every way of putting a tool on the wall creates (a Tools panel click or drag, a
 * preset, the agent's `wall_add_tool`), so a tool is the same item whoever adds it. Not yet placed on a holder: the
 * hang (`planAddHung`) overwrites the pose.
 */
import { type LeafOp, type ModelRef, newId, type WallItem } from '@hsw-editor/core';

/** Bounding box of a tool in its frame (mm): x width, y length, z thickness. */
export interface ToolBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** What a Tool Library entry adds to the preset: measured class dimensions and the user tool it is a copy of. */
export interface ToolDraftExtras {
  /** Named dimension overrides (`shaftDiameter`, ...) the compatibility maths compares against mounts. */
  readonly params?: Readonly<Record<string, number>>;
  /** Id of the user's library tool; recorded as the model's source so the tool can be traced back. */
  readonly customToolId?: string;
  /** Id of the generator class (`screwdriver`, `pliers-combination`) the tool was added from; it draws the tool on the wall. */
  readonly generatorClass?: string;
  /** Turn about the tool's origin, degrees (default 0: tip up). */
  readonly rotZ?: number;
}

export interface ToolDraft {
  readonly item: WallItem;
  readonly model: ModelRef;
  /** `addModelRef` then `addItem`. */
  readonly ops: readonly LeafOp[];
}

/** `source.by` of the model reference: the library tool, the generator class or a plain preset. */
function modelSourceBy(extras: ToolDraftExtras): string {
  if (extras.customToolId !== undefined) return `tool:${extras.customToolId}`;
  return extras.generatorClass === undefined ? 'preset' : `gen:${extras.generatorClass}`;
}

/** Ops that add a tool of `toolClassId` (box `dims`) at (x, y) hovering in front of the wall. */
export function toolDraftOps(
  toolClassId: string,
  label: string,
  position: { readonly x: number; readonly y: number },
  dims: ToolBox,
  extras: ToolDraftExtras = {},
): ToolDraft {
  const model: ModelRef = {
    id: newId('m'),
    label,
    status: 'chosen',
    source: {
      type: 'library',
      by: modelSourceBy(extras),
    },
    dimensionsMm: dims,
    toolClass: toolClassId,
  };
  const item: WallItem = {
    id: newId('i'),
    kind: 'tool',
    modelRefId: model.id,
    toolClass: toolClassId,
    label,
    pose: { x: position.x, y: position.y, z: 40, rotX: 0, rotY: 0, rotZ: extras.rotZ ?? 0 },
    params: { ...extras.params },
    source: { type: 'manual' },
    locked: false,
  };
  return {
    item,
    model,
    ops: [
      { type: 'addModelRef', model },
      { type: 'addItem', item },
    ],
  };
}
