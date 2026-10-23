import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { HolderSpec } from '@hsw-editor/compat';
import {
  applyOp,
  cellCenter,
  createEmptyWall,
  DEFAULT_BOARD,
  type Op,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { createValueStore } from '#state-backend';
import * as realBank from '@/bank/client.ts';
import * as realPostStep from '@/physics/postStep.ts';
import * as realSession from './session.ts';

// Plain copies: a namespace shows the mocked exports once mock.module patched the loaded module.
const realBankExports = { ...realBank };
const realSessionExports = { ...realSession };
const realPostStepExports = { ...realPostStep };

const board = { ...DEFAULT_BOARD, cols: 30, rows: 30 };
const RAIL: HolderSpec = {
  id: 'rail',
  category: 'holders/screwdrivers',
  fitsTool: [{ toolClass: 'screwdriver', capacity: 3 }],
  bboxMm: { min: { x: -60, y: -20, z: 0 }, max: { x: 60, y: 20, z: 40 } },
};

const fakeBank = createValueStore<unknown>({
  status: 'ready',
  byId: new Map([[RAIL.id, RAIL]]),
});
const submitted: { ops: readonly Op[]; label: string | undefined }[] = [];

mock.module('@/bank/client.ts', () => ({ ...realBankExports, bankStore: fakeBank }));
mock.module('./session.ts', () => ({
  ...realSessionExports,
  submitOps: (ops: readonly Op[], label?: string) => {
    submitted.push({ ops, label });
    return { ok: true };
  },
}));
mock.module('@/physics/postStep.ts', () => ({
  ...realPostStepExports,
  seatAfterDrop: () => {},
  seatAfterChosenHang: () => {},
}));

const { deleteSelection, nudgeSelection, rotateSelection } = await import('./actions.ts');
const { editorStore, setSelection } = await import('@/state/editor.ts');
const { toastStore } = await import('@/features/notices/notices.ts');

function holder(id: string, col: number, row: number): WallItem {
  const centre = cellCenter(board, { col, row });
  return {
    id,
    kind: 'holder',
    bankId: 'rail',
    cell: { col, row },
    pose: { x: centre.x, y: centre.y, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

function tool(id: string, parentId: string | undefined, x: number, y: number): WallItem {
  return {
    id,
    kind: 'tool',
    toolClass: 'screwdriver',
    modelRefId: 'm',
    ...(parentId === undefined ? {} : { parentId, slot: 0 }),
    pose: { x, y, z: 10, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

function wallWith(items: WallItem[]): Wall {
  return {
    ...createEmptyWall('w', 'W', board),
    models: [
      {
        id: 'm',
        label: 'tool',
        status: 'chosen',
        source: { type: 'library', by: 'preset' },
        dimensionsMm: { x: 28, y: 210, z: 28 },
      },
    ],
    items,
  };
}

function open(wall: Wall): void {
  realSession.sessionStore.set({
    wallId: 'w',
    status: 'ready',
    wall,
    confirmedRev: 0,
    pending: 0,
    warnings: [],
    canUndo: false,
    canRedo: false,
    lastRemote: null,
    notice: null,
    conflict: null,
    errorMessage: null,
  });
}

/** The wall after everything the action submitted. */
function afterSubmit(wall: Wall): Wall {
  return submitted.reduce(
    (current, entry) => entry.ops.reduce((w, op) => applyOp(w, op).wall, current),
    wall,
  );
}

function item(wall: Wall, id: string): WallItem {
  const found = wall.items.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

beforeEach(() => {
  submitted.length = 0;
  toastStore.set([]);
});
afterEach(() => {
  realSession.sessionStore.set(null);
  setSelection([]);
});

describe('deleteSelection', () => {
  test('a removed holder lets its tools go and they stay on the wall', () => {
    const wall = wallWith([holder('h', 6, 10), tool('a', 'h', 60, 60), tool('b', 'h', 80, 60)]);
    open(wall);
    setSelection(['h']);
    deleteSelection();
    const next = afterSubmit(wall);
    expect(next.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(item(next, 'a').parentId).toBeUndefined();
    expect(item(next, 'b').parentId).toBeUndefined();
    expect(editorStore.get().selection).toEqual([]);
    expect(toastStore.get().some((toast) => toast.kind === 'info')).toBe(true);
  });

  test('a holder carrying a locked tool is kept and the user is told', () => {
    const locked = { ...tool('a', 'h', 60, 60), locked: true };
    const wall = wallWith([holder('h', 6, 10), locked]);
    open(wall);
    setSelection(['h']);
    deleteSelection();
    expect(submitted).toHaveLength(0);
    expect(toastStore.get().some((toast) => toast.kind === 'error')).toBe(true);
  });

  test('a locked holder is not deleted', () => {
    const wall = wallWith([{ ...holder('h', 6, 10), locked: true }]);
    open(wall);
    setSelection(['h']);
    deleteSelection();
    expect(submitted).toHaveLength(0);
  });

  test('a hung tool deleted together with its holder is removed, not detached', () => {
    const wall = wallWith([holder('h', 6, 10), tool('a', 'h', 60, 60)]);
    open(wall);
    setSelection(['h', 'a']);
    deleteSelection();
    expect(afterSubmit(wall).items).toEqual([]);
  });
});

describe('rotateSelection', () => {
  test('a holder turns its hung tool with it; the tool is not rotated separately', () => {
    const base = holder('h', 6, 10);
    const wall = wallWith([base, tool('a', 'h', base.pose.x + 20, base.pose.y)]);
    open(wall);
    setSelection(['h', 'a']);
    rotateSelection(1);
    const next = afterSubmit(wall);
    expect(item(next, 'h').pose.rotZ).toBeCloseTo(60, 6);
    const a = item(next, 'a');
    expect(a.parentId).toBe('h');
    // The tool orbited the holder's anchor: same distance, new bearing.
    const dist = Math.hypot(a.pose.x - base.pose.x, a.pose.y - base.pose.y);
    expect(dist).toBeCloseTo(20, 6);
    expect(a.pose.x).not.toBeCloseTo(base.pose.x + 20, 3);
    expect(a.pose.rotZ).toBeCloseTo(60, 6);
  });

  test('a free tool turns by itself', () => {
    const wall = wallWith([tool('f', undefined, 100, 100)]);
    open(wall);
    setSelection(['f']);
    rotateSelection(2);
    expect(item(afterSubmit(wall), 'f').pose.rotZ).toBeCloseTo(120, 6);
  });

  test('a locked tool on a holder blocks the holder turn and the user is told', () => {
    const wall = wallWith([holder('h', 6, 10), { ...tool('a', 'h', 60, 60), locked: true }]);
    open(wall);
    setSelection(['h']);
    rotateSelection(1);
    expect(submitted).toHaveLength(0);
    expect(toastStore.get().some((toast) => toast.kind === 'error')).toBe(true);
  });
});

describe('nudgeSelection', () => {
  test('a holder moves one row and its hung tool keeps its offset', () => {
    const base = holder('h', 6, 10);
    const wall = wallWith([base, tool('a', 'h', base.pose.x + 15, base.pose.y + 5)]);
    open(wall);
    setSelection(['h', 'a']);
    nudgeSelection(0, 2);
    const next = afterSubmit(wall);
    expect(item(next, 'h').cell).toEqual({ col: 6, row: 11 });
    const h = item(next, 'h');
    const a = item(next, 'a');
    expect(a.pose.x - h.pose.x).toBeCloseTo(15, 6);
    expect(a.pose.y - h.pose.y).toBeCloseTo(5, 6);
  });

  test('a nudge off the board changes nothing', () => {
    const wall = wallWith([holder('h', 0, 10)]);
    open(wall);
    setSelection(['h']);
    nudgeSelection(-1, 0);
    expect(submitted).toHaveLength(0);
  });

  test('a locked holder stays put', () => {
    const wall = wallWith([{ ...holder('h', 6, 10), locked: true }]);
    open(wall);
    setSelection(['h']);
    nudgeSelection(1, 0);
    expect(submitted).toHaveLength(0);
  });

  test('a hung tool alone has no cell and is not nudged', () => {
    const wall = wallWith([holder('h', 6, 10), tool('a', 'h', 60, 60)]);
    open(wall);
    setSelection(['a']);
    nudgeSelection(1, 0);
    expect(submitted).toHaveLength(0);
  });
});

// Bun keeps module mocks for the rest of the process: hand the real modules back to later test files.
afterAll(() => {
  mock.module('@/bank/client.ts', () => realBankExports);
  mock.module('./session.ts', () => realSessionExports);
  mock.module('@/physics/postStep.ts', () => realPostStepExports);
});
