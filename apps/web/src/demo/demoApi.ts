/** The wall API of the demo build: one bundled template wall plus the visitor's own walls, all local (`localWalls.ts`). Same shape as the daemon client so `WallSync` is unchanged. */
import type { HolderSpec } from '@hsw-editor/compat';
import {
  applyOp,
  LeafOpSchema,
  type Board,
  type Op,
  type Wall,
  type WallSummary,
} from '@hsw-editor/core';
import { TOOL_ASSET_INDEX_URL, ToolAssetIndexSchema } from '@hsw-editor/tools/contract';
import { z } from 'zod';
import type { ChangeEntry, OpResponse, WallResponse } from '@/api/schemas.ts';
import { wallMirror } from '@/offline/runtime.ts';
import { buildShowcaseWall } from './showcase.ts';
import { LocalWalls } from './localWalls.ts';
import { SHOWCASE_LAYOUT } from './showcaseLayout.ts';

export const DEMO_WALL_ID = 'demo';

/** Where the build ships the ops that seat the showcase tools (`scripts/tools/demo-assets.ts`). */
export const DEMO_SEATS_URL = '/api/demo/seats';

const DemoSeatsSchema = z.object({ ops: z.array(LeafOpSchema) });

/**
 * The demo wall: the showcase holders with generated tools hanging in them (`showcase.ts`), built once from the bank and tool
 * indexes the build ships, then seated: the tools rest in their holders at the poses the build computed, so the physics check has
 * nothing to flag on a wall that is the product's own showcase.
 */
let demoWall: Promise<Wall> | null = null;

interface DemoBankElement {
  readonly id: string;
  readonly category: string;
  readonly bboxMm: HolderSpec['bboxMm'];
  readonly fitsTool?: HolderSpec['fitsTool'];
}

async function buildDemoWall(): Promise<Wall> {
  const [bank, tools, seats] = await Promise.all([
    fetchJson('/api/bank/index'),
    fetchJson(TOOL_ASSET_INDEX_URL),
    fetchJson(DEMO_SEATS_URL),
  ]);
  const index = ToolAssetIndexSchema.parse(tools);
  const specs = new Map<string, HolderSpec>(
    (bank as { elements: readonly DemoBankElement[] }).elements.map((element) => [
      element.id,
      {
        id: element.id,
        category: element.category,
        fitsTool: element.fitsTool ?? [],
        bboxMm: element.bboxMm,
      },
    ]),
  );
  const { wall } = buildShowcaseWall(DEMO_WALL_ID, 'Demo wall', SHOWCASE_LAYOUT, specs, index);
  const { ops } = DemoSeatsSchema.parse(seats);
  return ops.length === 0 ? wall : applyOp(wall, { type: 'batch', label: 'seat all', ops }).wall;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** The wall is built on first use; a failed build is not remembered, so a retry after coming back online works. */
function wallOnce(): Promise<Wall> {
  demoWall ??= buildDemoWall().catch((error: unknown) => {
    demoWall = null;
    throw error;
  });
  return demoWall;
}

const walls = new LocalWalls(DEMO_WALL_ID, wallOnce, wallMirror);

/** The wall service of the demo build: the bundled demo wall is a template, a first edit of it clones it (`wall/fork.ts`). */
export const demoApi = {
  listWalls: (): Promise<WallSummary[]> => walls.list(),
  createWall: (input: { name: string; board?: Board }): Promise<Wall> => walls.create(input),
  cloneWall: (sourceId: string, input: { id: string; name: string }): Promise<Wall> =>
    walls.clone(sourceId, input),
  deleteWall: (id: string): Promise<void> => walls.remove(id),
  getWall: (id: string): Promise<WallResponse> => walls.get(id),
  history: (id: string, since: number, limit: number): Promise<ChangeEntry[]> =>
    walls.history(id, since, limit),
  applyOps: (
    id: string,
    ops: readonly Op[],
    baseRev: number,
    label?: string,
  ): Promise<OpResponse> => walls.apply(id, ops, baseRev, label),
  undo: (id: string, baseRev?: number): Promise<OpResponse> => walls.undo(id, baseRev),
  redo: (id: string, baseRev?: number): Promise<OpResponse> => walls.redo(id, baseRev),
};
