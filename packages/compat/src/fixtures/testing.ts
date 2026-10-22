/**
 * Test data. `bank-seed-holders.json` is a verbatim projection (id, category, fitsTool, bboxMm) of every
 * element of the bank seed index (`packages/bank/seed/index.json`, contentHash
 * 4062241946c749c2fd6175c62674491fd1f66fa1c91e67144b3a89d5d9d9ce22); regenerate it with
 * `bun packages/compat/scripts/project-seed.ts <path to index.json>`. The tool interfaces are
 * measured-style stand-ins for the generated models of the tool library (same shape as its holding
 * interface).
 */
import {
  applyOp,
  createEmptyWall,
  type Op,
  OpSchema,
  type Wall,
  type WallItem,
  WallItemSchema,
} from '@hsw-editor/core';
import type { AttachContext } from '../attach.ts';
import type { HolderSpec, ToolInterface } from '../types.ts';
import seed from './bank-seed-holders.json';

export const BANK_HOLDERS: readonly HolderSpec[] = seed;

const holderById = new Map(BANK_HOLDERS.map((spec) => [spec.id, spec]));

export function bankHolder(id: string): HolderSpec {
  const spec = holderById.get(id);
  if (spec === undefined) throw new Error(`bank seed has no element ${id}`);
  return spec;
}

function tool(
  toolClass: string,
  lengthMm: number,
  dims: Record<string, number>,
  hang: ToolInterface['hang'] = null,
  width = 20,
  thickness = 20,
): ToolInterface {
  return {
    toolClass,
    lengthMm,
    hang,
    maxSection: { w: width, t: thickness, r: Math.hypot(width, thickness) / 2 },
    dims,
  };
}

/** One representative per bank tool class used by the tests. */
export const TOOLS: Readonly<Record<string, ToolInterface>> = {
  screwdriver: tool('screwdriver', 210, { shaftDiameter: 6, handleDiameter: 28 }, null, 28, 28),
  'screwdriver-thick': tool(
    'screwdriver',
    260,
    { shaftDiameter: 8.3, handleDiameter: 34 },
    null,
    34,
    34,
  ),
  'screwdriver-micro': tool(
    'screwdriver',
    150,
    { shaftDiameter: 3, handleDiameter: 14 },
    null,
    14,
    14,
  ),
  'tape-measure': tool('tape-measure', 75, {}, null, 75, 60),
  hammer: tool('hammer', 330, { handleWidth: 19, headWidth: 120 }, null, 120, 30),
  wrench: tool('wrench', 200, { headWidth: 30 }, null, 35, 12),
  pliers: tool('pliers', 180, { jawThickness: 8 }, null, 60, 20),
  caliper: tool('caliper', 190, { beamWidth: 16 }, null, 40, 12),
  saw: tool('saw', 450, {}, { point: [0, 40, 0], kind: 'hole', diameterMm: 14 }, 60, 3),
  cable: tool('cable', 300, {}, { point: [0, 300, 0], kind: 'loop' }, 20, 20),
};

export function toolInterfaceOf(item: WallItem): ToolInterface | undefined {
  return item.bankId === undefined ? undefined : TOOLS[item.bankId.replace(/^tool-/, '')];
}

export function holder(id: string, bankId: string, col: number, row: number, rotZ = 0): WallItem {
  return WallItemSchema.parse({ id, kind: 'holder', bankId, cell: { col, row }, pose: { rotZ } });
}

/** `key` indexes `TOOLS`; the item's class comes from the tool interface, like a generated model's would. */
export function toolItem(id: string, key: string, extra: Partial<WallItem> = {}): WallItem {
  return WallItemSchema.parse({
    id,
    kind: 'tool',
    bankId: `tool-${key}`,
    toolClass: TOOLS[key]?.toolClass,
    pose: { x: 0, y: 0, z: 0 },
    ...extra,
  });
}

export function wallWith(items: readonly WallItem[]): Wall {
  const ops: Op[] = items.map((item) => ({ type: 'addItem', item }));
  return applyOp(createEmptyWall('w', 'Test'), OpSchema.parse({ type: 'batch', ops })).wall;
}

export function contextFor(wall: Wall): AttachContext {
  return {
    wall,
    holderSpec: (item) => (item.bankId === undefined ? undefined : holderById.get(item.bankId)),
    toolInterface: toolInterfaceOf,
  };
}

/** Content of a wall without `rev` (the inverse restores content; rev only moves forward). */
export function contentOf(wall: Wall): Omit<Wall, 'rev'> {
  const { rev: _rev, ...rest } = wall;
  return rest;
}
