/**
 * The showcase wall: real holders of the bank with generated tools hanging in them, placed by the same compatibility
 * maths a drag-and-drop uses (`@hsw-editor/compat`), from the tool models' own holding interface. It is the demo build's
 * wall, the proof wall of the tool rendering and a fixture of its tests; nothing here knows about React or three.js.
 */
import {
  type HolderSpec,
  evaluateHolders,
  planAddHung,
  resolveDrop,
  type AttachContext,
} from '@hsw-editor/compat';
import {
  applyOp,
  createEmptyWall,
  type ModelRef,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import type { ToolAssetEntry, ToolAssetIndex } from '@hsw-editor/tools/contract';
import type { ShowcaseHolder } from './showcaseLayout.ts';
import { toolInterfaceFromHolding } from '@/toolmodels/holdingInterface.ts';

export interface ShowcaseResult {
  readonly wall: Wall;
  /** Tools that could not be hung (the holder is full or refuses them): listed so a test fails loudly instead of hiding a hole. */
  readonly unhung: readonly string[];
}

function entryOfClass(index: ToolAssetIndex, classId: string): ToolAssetEntry {
  const entry = index.entries.find((candidate) => candidate.id === `class:${classId}`);
  if (!entry) throw new Error(`showcase: the tool asset index has no class ${classId}`);
  return entry;
}

/** Builds the wall: holders first, then every tool hung in the first free slot of its holder. */
export function buildShowcaseWall(
  wallId: string,
  name: string,
  layout: readonly ShowcaseHolder[],
  specs: ReadonlyMap<string, HolderSpec>,
  tools: ToolAssetIndex,
): ShowcaseResult {
  let wall = createEmptyWall(wallId, name);
  for (const holder of layout) {
    wall = applyOp(wall, {
      type: 'addItem',
      item: {
        id: holder.id,
        kind: 'holder',
        bankId: holder.bankId,
        cell: holder.cell,
        pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: holder.rotZ ?? 0 },
        params: {},
        source: { type: 'manual' },
        locked: false,
      },
    }).wall;
  }
  const unhung: string[] = [];
  for (const holder of layout) {
    for (const [index, spec] of holder.tools.entries()) {
      const entry = entryOfClass(tools, spec.classId);
      const toolClass = entry.bankClass ?? spec.classId;
      const itemId = `${holder.id}-t${index}`;
      const model: ModelRef = {
        id: `m-${itemId}`,
        label: spec.classId,
        status: 'chosen',
        source: { type: 'library', by: `gen:${spec.classId}` },
        toolClass,
        dimensionsMm: entry.dimsMm,
      };
      const item: WallItem = {
        id: itemId,
        kind: 'tool',
        modelRefId: model.id,
        toolClass,
        label: spec.classId,
        pose: { x: 0, y: 0, z: 40, rotX: 0, rotY: 0, rotZ: 0 },
        params: { ...spec.params },
        source: { type: 'manual' },
        locked: false,
      };
      const withModel = applyOp(wall, { type: 'addModelRef', model }).wall;
      const ctx: AttachContext = {
        wall: withModel,
        holderSpec: (candidate) =>
          candidate.bankId === undefined ? undefined : specs.get(candidate.bankId),
        toolInterface: (candidate) =>
          candidate.id === item.id
            ? toolInterfaceFromHolding(toolClass, entry.holding, item.params)
            : undefined,
      };
      const free = evaluateHolders(ctx, item).find(
        (evaluation) => evaluation.holderId === holder.id,
      )?.freeSlots[0];
      const target =
        free === undefined ? null : resolveDrop(ctx, item, { x: free.world[0], y: free.world[1] });
      if (target?.kind !== 'attach' || target.target.holderId !== holder.id) {
        // No item to hang: no model reference either.
        unhung.push(`${itemId} (${spec.classId}) on ${holder.bankId}`);
        continue;
      }
      wall = applyOp(withModel, planAddHung(item, target.target)).wall;
    }
  }
  return { wall, unhung };
}
