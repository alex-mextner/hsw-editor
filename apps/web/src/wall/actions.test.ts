import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ToolClass } from '@hsw-editor/bank';
import { makeElement } from '@hsw-editor/bank/testing';
import {
  applyOp,
  cellCenter,
  checkWall,
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
const RAIL = makeElement({
  id: 'rail',
  ru: 'Рейка',
  en: 'Rail',
  category: 'holders/screwdrivers',
  dims: [120, 40, 40],
  fitsTool: [{ toolClass: 'screwdriver', capacity: 3 }],
});

const READY_BANK = { status: 'ready', byId: new Map([[RAIL.id, RAIL]]) };
const fakeBank = createValueStore<unknown>(READY_BANK);
const submitted: { ops: readonly Op[]; label: string | undefined }[] = [];
const seated: string[] = [];

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
  seatAfterChosenHang: (toolId: string) => {
    seated.push(toolId);
  },
}));

const { addToolFromPayload, addToolPreset, deleteSelection, nudgeSelection, rotateSelection } =
  await import('./actions.ts');
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
  seated.length = 0;
  fakeBank.set(READY_BANK);
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

const SCREWDRIVER = {
  toolClass: 'screwdriver',
  label: 'Screwdriver',
  dimsMm: { x: 28, y: 210, z: 28 },
};

describe('addToolFromPayload', () => {
  test('hangs the tool on the compatible holder, selects it and has the physics seat it', () => {
    const wall = wallWith([holder('h', 6, 10)]);
    open(wall);
    const result = addToolFromPayload(SCREWDRIVER);
    if (!result.ok) throw new Error(`expected an add, got ${result.reason}`);
    expect(submitted.map((entry) => entry.label)).toEqual(['add-and-hang']);
    const added = item(afterSubmit(wall), result.itemId);
    expect(added.parentId).toBe('h');
    expect(editorStore.get().selection).toEqual([result.itemId]);
    expect(seated).toEqual([result.itemId]);
  });

  test('a tool no holder takes lies free inside the board and is not seated', () => {
    const wall = wallWith([holder('h', 6, 10)]);
    open(wall);
    const result = addToolFromPayload({ ...SCREWDRIVER, toolClass: 'pliers', label: 'Pliers' });
    if (!result.ok) throw new Error(`expected an add, got ${result.reason}`);
    expect(submitted.map((entry) => entry.label)).toEqual(['add-tool']);
    const added = item(afterSubmit(wall), result.itemId);
    expect(added.parentId).toBeUndefined();
    expect(added.pose.x).toBeGreaterThanOrEqual(0);
    expect(added.pose.y).toBeGreaterThanOrEqual(0);
    expect(seated).toEqual([]);
  });

  test('says why nothing was added without touching the wall', () => {
    expect(addToolFromPayload(SCREWDRIVER)).toEqual({ ok: false, reason: 'noWall' });
    open(wallWith([]));
    fakeBank.set({ status: 'loading' });
    expect(addToolFromPayload(SCREWDRIVER)).toEqual({ ok: false, reason: 'bankNotReady' });
    expect(submitted).toHaveLength(0);
  });

  test('a bank that failed to load still takes the tool, lying free', () => {
    const wall = wallWith([]);
    open(wall);
    fakeBank.set({ status: 'error', message: 'offline' });
    const result = addToolFromPayload(SCREWDRIVER);
    if (!result.ok) throw new Error(`expected an add, got ${result.reason}`);
    expect(item(afterSubmit(wall), result.itemId).parentId).toBeUndefined();
    expect(seated).toEqual([]);
  });
});

const SCREWDRIVER_CLASS: ToolClass = {
  id: 'screwdriver',
  name: { ru: 'Отвёртка', en: 'Screwdriver' },
  synonyms: { ru: [], en: [] },
};

describe('addToolPreset', () => {
  /** Adds `count` presets one after the other, the wall each time being what the previous ones left. */
  function addInARow(base: Wall, toolClass: ToolClass, count: number): string[] {
    const ids: string[] = [];
    for (let n = 0; n < count; n += 1) {
      open(afterSubmit(base));
      const id = addToolPreset(toolClass, toolClass.name.en);
      if (id === null) throw new Error(`preset ${n} was not added`);
      ids.push(id);
    }
    return ids;
  }

  test('several presets in a row hang on the compatible holder while it has room, the rest lie on distinct clear spots of the board', () => {
    const base = wallWith([holder('h', 6, 10)]);
    const ids = addInARow(base, SCREWDRIVER_CLASS, 5);
    const wall = afterSubmit(base);
    const added = ids.map((id) => item(wall, id));
    // the rail takes three: first fitting tool on it, each in its own slot
    const hung = added.filter((tool) => tool.parentId === 'h');
    expect(hung).toHaveLength(3);
    expect(hung.map((tool) => tool.slot).sort()).toEqual([0, 1, 2]);
    expect(seated.sort()).toEqual(hung.map((tool) => tool.id).sort());
    // the other two are loose, on distinct spots, inside the board (not the viewport-centre pile)
    const loose = added.filter((tool) => tool.parentId === undefined);
    expect(loose).toHaveLength(2);
    const spots = new Set(loose.map((tool) => `${tool.pose.x},${tool.pose.y}`));
    expect(spots.size).toBe(2);
    for (const tool of loose) {
      expect(tool.pose.x).toBeGreaterThanOrEqual(0);
      expect(tool.pose.y).toBeGreaterThanOrEqual(0);
    }
    expect(submitted.map((entry) => entry.label)).toEqual([
      'add-and-hang',
      'add-and-hang',
      'add-and-hang',
      'add-tool',
      'add-tool',
    ]);
    // right after adding presets the wall has no out_of_board or overlap warning
    const codes = checkWall(wall).map((warning) => warning.code);
    expect(codes).not.toContain('out_of_board');
    expect(codes).not.toContain('cell_collision');
  });

  test('presets of a class no holder takes never stack at one point', () => {
    const base = wallWith([holder('h', 6, 10)]);
    const pliers: ToolClass = {
      ...SCREWDRIVER_CLASS,
      id: 'pliers',
      name: { ru: 'Плоскогубцы', en: 'Pliers' },
    };
    const ids = addInARow(base, pliers, 4);
    const wall = afterSubmit(base);
    const spots = new Set(ids.map((id) => `${item(wall, id).pose.x},${item(wall, id).pose.y}`));
    expect(spots.size).toBe(4);
    expect(seated).toEqual([]);
  });

  test('with no wall open it adds nothing and is silent (the caller says the wall is missing)', () => {
    expect(addToolPreset(SCREWDRIVER_CLASS, 'Screwdriver')).toBeNull();
    expect(submitted).toHaveLength(0);
    expect(toastStore.get()).toEqual([]);
  });

  test('a refusal is a toast, not a silent null', () => {
    open(wallWith([]));
    fakeBank.set({ status: 'loading' });
    expect(addToolPreset(SCREWDRIVER_CLASS, 'Screwdriver')).toBeNull();
    expect(toastStore.get().some((toast) => toast.kind === 'error')).toBe(true);
  });
});

// Bun keeps module mocks for the rest of the process: hand the real modules back to later test files.
afterAll(() => {
  mock.module('@/bank/client.ts', () => realBankExports);
  mock.module('./session.ts', () => realSessionExports);
  mock.module('@/physics/postStep.ts', () => realPostStepExports);
});
