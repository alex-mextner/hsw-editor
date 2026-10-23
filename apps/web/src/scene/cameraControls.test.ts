import { afterEach, describe, expect, test } from 'bun:test';
import { createValueStore } from '#state-backend';
import {
  cellCenter,
  createEmptyWall,
  DEFAULT_BOARD,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { MOUSE, TOUCH } from 'three';
import { editorStore, patchEditor } from '@/state/editor.ts';
import { sessionStore } from '@/wall/session.ts';
import { bindCameraLock, mouseButtonsFor, touchesFor } from './cameraControls.ts';
import { beginItemDrag } from './dragController.ts';
import { setViewportBridge } from './viewportBridge.ts';

describe('mouseButtonsFor', () => {
  test('perspective: left drag orbits, middle drag pans, right button is left to the context menu', () => {
    const buttons = mouseButtonsFor({ ortho: false, panHeld: false });
    expect(buttons.LEFT).toBe(MOUSE.ROTATE);
    expect(buttons.MIDDLE).toBe(MOUSE.PAN);
    expect(buttons).not.toHaveProperty('RIGHT');
  });

  test('front view cannot rotate, so the left drag pans there', () => {
    const buttons = mouseButtonsFor({ ortho: true, panHeld: false });
    expect(buttons.LEFT).toBe(MOUSE.PAN);
    expect(buttons.MIDDLE).toBe(MOUSE.PAN);
    expect(buttons).not.toHaveProperty('RIGHT');
  });

  test('holding Space turns the left drag into a pan', () => {
    expect(mouseButtonsFor({ ortho: false, panHeld: true }).LEFT).toBe(MOUSE.PAN);
  });
});

describe('touchesFor', () => {
  test('one finger orbits, two fingers pan and zoom', () => {
    expect(touchesFor({ ortho: false })).toEqual({ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN });
  });

  test('front view: one finger pans because the view cannot rotate', () => {
    expect(touchesFor({ ortho: true })).toEqual({ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN });
  });
});

describe('bindCameraLock', () => {
  test('orbit is disabled the moment an item is held, without waiting for a React render', () => {
    const store = createValueStore({ holding: false });
    const controls = { enabled: true };
    const unbind = bindCameraLock(controls, store);
    store.set({ holding: true });
    expect(controls.enabled).toBe(false);
    store.set({ holding: false });
    expect(controls.enabled).toBe(true);
    unbind();
  });

  test('applies the current state when it binds (controls re-created while an item is held)', () => {
    const store = createValueStore({ holding: true });
    const controls = { enabled: true };
    bindCameraLock(controls, store);
    expect(controls.enabled).toBe(false);
  });

  test('stops following the store after unbind', () => {
    const store = createValueStore({ holding: false });
    const controls = { enabled: true };
    bindCameraLock(controls, store)();
    store.set({ holding: true });
    expect(controls.enabled).toBe(true);
  });
});

const board = { ...DEFAULT_BOARD, cols: 20, rows: 20 };

function holder(id: string, col: number, row: number, locked = false): WallItem {
  const centre = cellCenter(board, { col, row });
  return {
    id,
    kind: 'holder',
    bankId: 'unknown-element',
    cell: { col, row },
    pose: { x: centre.x, y: centre.y, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked,
  };
}

function openWall(items: WallItem[]): void {
  const wall: Wall = { ...createEmptyWall('w', 'W', board), items };
  sessionStore.set({
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
    errorMessage: null,
    conflict: null,
  });
  setViewportBridge({
    toWall: (x, y) => ({ x, y }),
    itemAt: () => null,
    invalidate: () => undefined,
  });
}

function press(id: string, at = { x: 100, y: 100 }): void {
  beginItemDrag(id, {
    nativeEvent: {
      button: 0,
      clientX: at.x,
      clientY: at.y,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
    },
    stopPropagation: () => undefined,
  });
}

function pointer(type: 'pointermove' | 'pointerup' | 'pointercancel', at = { x: 100, y: 100 }) {
  globalThis.dispatchEvent(
    Object.assign(new Event(type), { clientX: at.x, clientY: at.y, altKey: false }),
  );
}

/**
 * Left drag now orbits the camera, so the item under the pointer must own the gesture: orbit is off
 * for the whole press and comes back on every way a press can end (a stuck lock is "the board no
 * longer moves").
 */
describe('item press owns the left-button gesture', () => {
  const controls = { enabled: true };
  let unbind = (): void => undefined;

  function arm(items: WallItem[]): void {
    openWall(items);
    patchEditor({ tool: 'select', selection: [], holding: false });
    controls.enabled = true;
    unbind = bindCameraLock(controls, editorStore);
  }

  afterEach(() => {
    unbind();
    patchEditor({ holding: false, dragging: new Map(), selection: [] });
    setViewportBridge(null);
    sessionStore.set(null);
  });

  test('pressing an item disables orbit synchronously; releasing re-enables it', () => {
    arm([holder('a', 4, 4)]);
    press('a');
    expect(controls.enabled).toBe(false);
    pointer('pointerup');
    expect(controls.enabled).toBe(true);
  });

  test('orbit comes back after a real drag is cancelled with pointercancel', () => {
    arm([holder('a', 4, 4)]);
    press('a');
    pointer('pointermove', { x: 160, y: 140 });
    expect(controls.enabled).toBe(false);
    pointer('pointercancel', { x: 160, y: 140 });
    expect(controls.enabled).toBe(true);
    expect(editorStore.get().dragging.size).toBe(0);
  });

  test('orbit comes back after a real drag is cancelled with Escape', () => {
    arm([holder('a', 4, 4)]);
    press('a');
    pointer('pointermove', { x: 160, y: 140 });
    globalThis.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(controls.enabled).toBe(true);
  });

  test('a locked item cannot be moved, so the press does not hold the camera', () => {
    arm([holder('a', 4, 4, true)]);
    press('a');
    expect(controls.enabled).toBe(true);
  });
});
