import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { HolderSpec } from '@hsw-editor/compat';
import { cellCenter, createEmptyWall, DEFAULT_BOARD, type Op, type Wall } from '@hsw-editor/core';
import { createValueStore } from '#state-backend';
import * as realBank from '@/bank/client.ts';
import * as realPostStep from '@/physics/postStep.ts';
import * as realSession from '@/wall/session.ts';

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
const HOOK: HolderSpec = {
  id: 'tape-hook',
  category: 'hooks/tape',
  fitsTool: [{ toolClass: 'tape-measure', capacity: 1 }],
  bboxMm: { min: { x: -20, y: -20, z: 0 }, max: { x: 20, y: 20, z: 50 } },
};

const fakeBank = createValueStore<unknown>({
  status: 'ready',
  byId: new Map([
    [RAIL.id, RAIL],
    [HOOK.id, HOOK],
  ]),
});
const submitted: { ops: readonly Op[]; label: string | undefined }[] = [];
const seated: string[] = [];

mock.module('@/bank/client.ts', () => ({ ...realBankExports, bankStore: fakeBank }));
mock.module('@/wall/session.ts', () => ({
  ...realSessionExports,
  submitOps: (ops: readonly Op[], label?: string) => {
    submitted.push({ ops, label });
    return { ok: true };
  },
}));
mock.module('@/physics/postStep.ts', () => ({
  ...realPostStepExports,
  seatAfterDrop: (id: string) => seated.push(id),
  seatAfterChosenHang: (id: string) => seated.push(id),
  // A free release: the physics' fall decision has its own tests (physics/fall.test.ts); here the tool is placed.
  releaseFreeTool: async (release: { ops: readonly Op[]; label: string }) => {
    submitted.push({ ops: release.ops, label: release.label });
    return { kind: 'placed' as const };
  },
}));

const { editorStore, patchEditor } = await import('@/state/editor.ts');
const { setViewportBridge } = await import('./viewportBridge.ts');
const { beginToolDrag, dragOverTool, dropTool, endToolDrag, TOOL_DRAG_TYPE } =
  await import('./toolDrop.ts');

function holderItem(id: string, bankId: string, col: number, row: number) {
  const centre = cellCenter(board, { col, row });
  return {
    id,
    kind: 'holder' as const,
    bankId,
    cell: { col, row },
    pose: { x: centre.x, y: centre.y, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' as const },
    locked: false,
  };
}

const wall: Wall = {
  ...createEmptyWall('w', 'W', board),
  items: [holderItem('rail', 'rail', 6, 10), holderItem('hook', 'tape-hook', 20, 10)],
};

interface FakeDrag {
  readonly clientX: number;
  readonly clientY: number;
  readonly altKey: boolean;
  readonly dataTransfer: {
    types: string[];
    dropEffect: string;
    setData: () => void;
    effectAllowed: string;
  };
  prevented: boolean;
  preventDefault: () => void;
}

function dragEvent(x: number, y: number, altKey = false): FakeDrag {
  const event: FakeDrag = {
    clientX: x,
    clientY: y,
    altKey,
    dataTransfer: { types: [TOOL_DRAG_TYPE], dropEffect: '', setData: () => {}, effectAllowed: '' },
    prevented: false,
    preventDefault: () => {
      event.prevented = true;
    },
  };
  return event;
}

// The fake viewport maps a client position straight to the wall plane.
const asDrag = (event: FakeDrag): DragEvent => event as unknown as DragEvent;

beforeEach(() => {
  submitted.length = 0;
  seated.length = 0;
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
  setViewportBridge({
    toWall: (x, y) => ({ x, y }),
    itemAt: () => null,
    invalidate: () => {},
  });
  beginToolDrag({ dataTransfer: null }, { toolClass: 'screwdriver', label: 'Screwdriver' });
});

afterEach(() => {
  endToolDrag();
  setViewportBridge(null);
  realSession.sessionStore.set(null);
  patchEditor({ attach: null });
});

/** Lets the free release (an async decision of the physics) finish. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const rail = wall.items[0]!;
const hook = wall.items[1]!;

describe('dragOverTool', () => {
  test('over a suitable holder the drop is allowed and the holder glows', () => {
    const event = dragEvent(rail.pose.x, rail.pose.y);
    dragOverTool(asDrag(event));
    expect(event.prevented).toBe(true);
    expect(event.dataTransfer.dropEffect).toBe('copy');
    expect(editorStore.get().attach?.target?.holderId).toBe('rail');
  });

  test('over an unsuitable holder the drop stays forbidden and the refusal names it', () => {
    const event = dragEvent(hook.pose.x, hook.pose.y);
    dragOverTool(asDrag(event));
    expect(event.prevented).toBe(false);
    expect(event.dataTransfer.dropEffect).toBe('none');
    expect(editorStore.get().attach?.refusal?.holderId).toBe('hook');
  });

  test('on bare board the drop is allowed with a free ghost', () => {
    const event = dragEvent(500, 500);
    dragOverTool(asDrag(event));
    expect(event.prevented).toBe(true);
    expect(editorStore.get().attach?.target).toBeNull();
    expect(editorStore.get().attach?.ghost?.valid).toBe(true);
  });

  test('a drag that is not a panel tool is ignored', () => {
    const event = dragEvent(rail.pose.x, rail.pose.y);
    event.dataTransfer.types = [];
    dragOverTool(asDrag(event));
    expect(event.prevented).toBe(false);
    expect(editorStore.get().attach).toBeNull();
  });
});

describe('dropTool', () => {
  test('dropping on a suitable holder adds and hangs the tool in one submission', () => {
    dropTool(asDrag(dragEvent(rail.pose.x, rail.pose.y)));
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.label).toBe('add-and-hang');
    const flat = (submitted[0]?.ops ?? []).flatMap((op) => (op.type === 'batch' ? op.ops : [op]));
    const added = flat.find((op) => op.type === 'addItem');
    expect(added?.type === 'addItem' ? added.item.parentId : undefined).toBe('rail');
    expect(seated).toHaveLength(1);
    expect(editorStore.get().selection).toHaveLength(1);
  });

  test('dropping on bare board adds a free tool and does not hang it', async () => {
    dropTool(asDrag(dragEvent(500, 500)));
    await settled();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.label).toBe('add-tool');
    expect(seated).toHaveLength(0);
  });

  test('dropping on an unsuitable holder submits nothing', () => {
    dropTool(asDrag(dragEvent(hook.pose.x, hook.pose.y)));
    expect(submitted).toHaveLength(0);
  });

  test('Alt drops free even over a suitable holder', async () => {
    dropTool(asDrag(dragEvent(rail.pose.x, rail.pose.y, true)));
    await settled();
    expect(submitted[0]?.label).toBe('add-tool');
  });

  test('the drag state is cleared by the drop', () => {
    dropTool(asDrag(dragEvent(500, 500)));
    dragOverTool(asDrag(dragEvent(500, 500)));
    expect(editorStore.get().attach).toBeNull();
  });
});

// Bun keeps module mocks for the rest of the process: hand the real modules back to later test files.
afterAll(() => {
  mock.module('@/bank/client.ts', () => realBankExports);
  mock.module('@/wall/session.ts', () => realSessionExports);
  mock.module('@/physics/postStep.ts', () => realPostStepExports);
});
