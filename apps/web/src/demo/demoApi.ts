/** The wall API of the demo build: one bundled wall, read-only. Same shape as the daemon client so `WallSync` is unchanged. */
import type { HolderSpec } from '@hsw-editor/compat';
import type { Wall } from '@hsw-editor/core';
import { TOOL_ASSET_INDEX_URL, ToolAssetIndexSchema } from '@hsw-editor/tools/contract';
import { ApiError } from '@/api/http.ts';
import type { OpResponse, WallResponse, WallSummary } from '@/api/schemas.ts';
import { t } from '@/i18n/index.ts';
import { buildShowcaseWall } from './showcase.ts';
import { SHOWCASE_LAYOUT } from './showcaseLayout.ts';

export const DEMO_WALL_ID = 'demo';

/** The demo wall: the showcase holders with generated tools hanging in them (`showcase.ts`), built once from the bank and tool indexes the build ships. */
let demoWall: Promise<Wall> | null = null;

interface DemoBankElement {
  readonly id: string;
  readonly category: string;
  readonly bboxMm: HolderSpec['bboxMm'];
  readonly fitsTool?: HolderSpec['fitsTool'];
}

async function buildDemoWall(): Promise<Wall> {
  const [bank, tools] = await Promise.all([
    fetchJson('/api/bank/index'),
    fetchJson(TOOL_ASSET_INDEX_URL),
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
  return buildShowcaseWall(DEMO_WALL_ID, 'Demo wall (read-only)', SHOWCASE_LAYOUT, specs, index)
    .wall;
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

function readOnly(): ApiError {
  return new ApiError(403, 'demo_read_only', t('demo.readOnly'), null);
}

export const demoApi = {
  async listWalls(): Promise<WallSummary[]> {
    const wall = await wallOnce();
    return [
      {
        id: wall.id,
        name: wall.name,
        rev: wall.rev,
        items: wall.items.length,
        photos: 0,
        models: wall.models.length,
        updatedAt: new Date(0).toISOString(),
      },
    ];
  },
  createWall(): Promise<Wall> {
    return Promise.reject(readOnly());
  },
  async getWall(): Promise<WallResponse> {
    return { wall: await wallOnce(), canUndo: false, canRedo: false, warnings: [] };
  },
  applyOps(): Promise<OpResponse> {
    return Promise.reject(readOnly());
  },
  undo(): Promise<OpResponse> {
    return Promise.reject(readOnly());
  },
  redo(): Promise<OpResponse> {
    return Promise.reject(readOnly());
  },
};
