import { describe, expect, test } from 'bun:test';
import type { WallItem } from '@hsw-editor/core';
import {
  buildMenu,
  type MenuAction,
  type MenuContext,
  type MenuEntry,
} from './contextMenuModel.ts';

function item(id: string, patch: Partial<WallItem> = {}): WallItem {
  return {
    id,
    kind: 'holder',
    bankId: 'e',
    cell: { col: 1, row: 1 },
    pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
    ...patch,
  };
}

const itemMenu = (selected: WallItem[]): MenuContext => ({
  target: { kind: 'item', id: selected[0]?.id ?? 'x' },
  selected,
  clipboardCount: 0,
  view: 'perspective',
});

const boardMenu = (patch: Partial<MenuContext> = {}): MenuContext => ({
  target: { kind: 'board', point: { x: 10, y: 20 } },
  selected: [],
  clipboardCount: 0,
  view: 'perspective',
  ...patch,
});

function entry(menu: readonly (readonly MenuEntry[])[], action: MenuAction): MenuEntry {
  const found = menu.flat().find((candidate) => candidate.action === action);
  if (!found) throw new Error(`menu has no ${action}`);
  return found;
}

const actionsOf = (menu: readonly (readonly MenuEntry[])[]): MenuAction[] =>
  menu.flat().map((candidate) => candidate.action);

describe('menu on an item', () => {
  test('offers the editing actions, delete last and marked destructive', () => {
    const menu = buildMenu(itemMenu([item('a')]));
    expect(actionsOf(menu)).toEqual([
      'duplicate',
      'copy',
      'rotateRight',
      'rotateLeft',
      'toggleLock',
      'properties',
      'delete',
    ]);
    expect(entry(menu, 'delete').destructive).toBe(true);
    expect(menu.flat().every((candidate) => !candidate.disabled)).toBe(true);
  });

  test('the lock entry says what it will do', () => {
    expect(entry(buildMenu(itemMenu([item('a')])), 'toggleLock').label).toBe('action.lock');
    expect(entry(buildMenu(itemMenu([item('a', { locked: true })])), 'toggleLock').label).toBe(
      'action.unlock',
    );
    // Mixed selection: the lock action locks everything first, like the L shortcut.
    expect(
      entry(buildMenu(itemMenu([item('a'), item('b', { locked: true })])), 'toggleLock').label,
    ).toBe('action.lock');
  });

  test('locked items cannot be rotated or deleted, but can be copied and unlocked', () => {
    const menu = buildMenu(itemMenu([item('a', { locked: true })]));
    expect(entry(menu, 'rotateRight').disabled).toBe(true);
    expect(entry(menu, 'rotateLeft').disabled).toBe(true);
    expect(entry(menu, 'delete').disabled).toBe(true);
    expect(entry(menu, 'copy').disabled).toBe(false);
    expect(entry(menu, 'toggleLock').disabled).toBe(false);
  });

  test('variant and size editing needs exactly one item', () => {
    expect(entry(buildMenu(itemMenu([item('a')])), 'properties').disabled).toBe(false);
    expect(entry(buildMenu(itemMenu([item('a'), item('b')])), 'properties').disabled).toBe(true);
  });

  test('items without a cell cannot be duplicated or copied', () => {
    const menu = buildMenu(itemMenu([item('a', { cell: undefined })]));
    expect(entry(menu, 'duplicate').disabled).toBe(true);
    expect(entry(menu, 'copy').disabled).toBe(true);
  });
});

describe('menu on the empty board', () => {
  test('offers paste, add here, select all and the view presets', () => {
    expect(actionsOf(buildMenu(boardMenu()))).toEqual([
      'paste',
      'addHere',
      'selectAll',
      'viewPerspective',
      'viewFront',
      'fit',
    ]);
  });

  test('paste needs something copied', () => {
    expect(entry(buildMenu(boardMenu()), 'paste').disabled).toBe(true);
    expect(entry(buildMenu(boardMenu({ clipboardCount: 2 })), 'paste').disabled).toBe(false);
  });

  test('adding or pasting here needs a point on the wall plane (the ray can miss it)', () => {
    const noPoint = buildMenu(
      boardMenu({ clipboardCount: 1, target: { kind: 'board', point: null } }),
    );
    expect(entry(noPoint, 'addHere').disabled).toBe(true);
    expect(entry(noPoint, 'paste').disabled).toBe(true);
  });

  test('the active view is checked', () => {
    const perspective = buildMenu(boardMenu());
    expect(entry(perspective, 'viewPerspective').checked).toBe(true);
    expect(entry(perspective, 'viewFront').checked).toBe(false);
    const front = buildMenu(boardMenu({ view: 'front' }));
    expect(entry(front, 'viewPerspective').checked).toBe(false);
    expect(entry(front, 'viewFront').checked).toBe(true);
  });
});
