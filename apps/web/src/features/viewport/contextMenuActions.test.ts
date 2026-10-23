import { afterEach, describe, expect, test } from 'bun:test';
import { editorStore, patchEditor } from '@/state/editor.ts';
import { layoutStore } from '@/state/layout.ts';
import { setViewportBridge } from '@/scene/viewportBridge.ts';
import { openMenuTarget, runMenuAction } from './contextMenuActions.ts';

function contextmenu(x: number, y: number): Event {
  return Object.assign(new Event('contextmenu'), { clientX: x, clientY: y });
}

/** Scene stub: item `a` fills x < 50, everything else is board with the wall point equal to the client point. */
function sceneUnderPointer(): void {
  setViewportBridge({
    toWall: (x, y) => ({ x: x * 2, y: y * 2 }),
    itemAt: (x) => (x < 50 ? 'a' : null),
    invalidate: () => undefined,
  });
}

afterEach(() => {
  setViewportBridge(null);
  patchEditor({ selection: [], placeAt: null, view: 'perspective' });
});

describe('what a right-click hits', () => {
  test('an item that is not selected becomes the selection, so the menu acts on it', () => {
    sceneUnderPointer();
    patchEditor({ selection: ['b'] });
    expect(openMenuTarget(contextmenu(10, 10))).toEqual({ kind: 'item', id: 'a' });
    expect(editorStore.get().selection).toEqual(['a']);
  });

  test('right-clicking inside a multi-selection keeps it', () => {
    sceneUnderPointer();
    patchEditor({ selection: ['a', 'b'] });
    openMenuTarget(contextmenu(10, 10));
    expect(editorStore.get().selection).toEqual(['a', 'b']);
  });

  test('the background yields the wall point under the pointer and leaves the selection alone', () => {
    sceneUnderPointer();
    patchEditor({ selection: ['b'] });
    expect(openMenuTarget(contextmenu(80, 30))).toEqual({
      kind: 'board',
      point: { x: 160, y: 60 },
    });
    expect(editorStore.get().selection).toEqual(['b']);
  });

  test('an event without a position (keyboard menu key) opens the board menu without a point', () => {
    sceneUnderPointer();
    expect(openMenuTarget(new Event('contextmenu'))).toEqual({ kind: 'board', point: null });
  });
});

describe('menu entries that touch editor state', () => {
  test('"add element here" marks the spot and opens the element bank', () => {
    layoutStore.set({ ...layoutStore.get(), leftOpen: false });
    runMenuAction('addHere', { kind: 'board', point: { x: 5, y: 6 } });
    expect(editorStore.get().placeAt).toEqual({ x: 5, y: 6 });
    expect(layoutStore.get().leftOpen).toBe(true);
  });

  test('"add element here" without a wall point does nothing', () => {
    runMenuAction('addHere', { kind: 'board', point: null });
    expect(editorStore.get().placeAt).toBeNull();
  });

  test('view presets switch the camera mode', () => {
    runMenuAction('viewFront', { kind: 'board', point: null });
    expect(editorStore.get().view).toBe('front');
    runMenuAction('viewPerspective', { kind: 'board', point: null });
    expect(editorStore.get().view).toBe('perspective');
  });

  test('"variant and size" opens the inspector', () => {
    layoutStore.set({ ...layoutStore.get(), rightOpen: false });
    runMenuAction('properties', { kind: 'item', id: 'a' });
    expect(layoutStore.get().rightOpen).toBe(true);
  });
});
