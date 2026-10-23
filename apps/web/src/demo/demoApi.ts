/** The wall API of the demo build: one bundled wall, read-only. Same shape as the daemon client so `WallSync` is unchanged. */
import { applyOp, createEmptyWall, type LeafOp, type Wall } from '@hsw-editor/core';
import { ApiError } from '@/api/http.ts';
import type { OpResponse, WallResponse, WallSummary } from '@/api/schemas.ts';
import { t } from '@/i18n/index.ts';

export const DEMO_WALL_ID = 'demo';

/** Ids exist in the committed seed bank (`packages/bank/seed`); positions are honeycomb cells. */
const DEMO_ITEMS: readonly { id: string; bankId: string; col: number; row: number }[] = [
  { id: 'demo-1', bankId: 'clamp-bar-roddiameter12-rodlength100', col: 6, row: 6 },
  { id: 'demo-2', bankId: 'clamp-bar-roddiameter16-rodlength100', col: 14, row: 6 },
  { id: 'demo-3', bankId: 'j-hook-reach100-bardiameter10', col: 22, row: 6 },
  { id: 'demo-4', bankId: 'shelf-ledge-widthcells2-depth100', col: 8, row: 14 },
  { id: 'demo-5', bankId: 'bin-open-width100-depth40-height30', col: 18, row: 14 },
  { id: 'demo-6', bankId: 'cable-hanger-hangerreach100-strapwidth20', col: 28, row: 14 },
];

function buildDemoWall(): Wall {
  let wall = createEmptyWall(DEMO_WALL_ID, 'Demo wall (read-only)');
  for (const item of DEMO_ITEMS) {
    const op: LeafOp = {
      type: 'addItem',
      item: {
        id: item.id,
        kind: 'holder',
        bankId: item.bankId,
        cell: { col: item.col, row: item.row },
        pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
        params: {},
        source: { type: 'manual' },
        locked: false,
      },
    };
    wall = applyOp(wall, op).wall;
  }
  return wall;
}

const wall = buildDemoWall();

function readOnly(): ApiError {
  return new ApiError(403, 'demo_read_only', t('demo.readOnly'), null);
}

export const demoApi = {
  listWalls(): Promise<WallSummary[]> {
    return Promise.resolve([
      {
        id: wall.id,
        name: wall.name,
        rev: wall.rev,
        items: wall.items.length,
        photos: 0,
        models: 0,
        updatedAt: new Date(0).toISOString(),
      },
    ]);
  },
  createWall(): Promise<Wall> {
    return Promise.reject(readOnly());
  },
  getWall(): Promise<WallResponse> {
    return Promise.resolve({ wall, canUndo: false, canRedo: false, warnings: [] });
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
