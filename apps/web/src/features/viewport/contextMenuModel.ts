/**
 * What the viewport's right-click menu offers. Pure: the target and the editor state go in, grouped
 * entries come out; `ViewportContextMenu` draws them and `contextMenuActions` runs them.
 */
import type { WallItem } from '@hsw-editor/core';
import type { MessageKey } from '@/i18n/index.ts';
import type { ViewMode } from '@/scene/CameraRig.tsx';
import type { Vec2 } from '@/state/editor.ts';

export type MenuAction =
  | 'duplicate'
  | 'copy'
  | 'rotateRight'
  | 'rotateLeft'
  | 'toggleLock'
  | 'properties'
  | 'delete'
  | 'paste'
  | 'addHere'
  | 'selectAll'
  | 'viewPerspective'
  | 'viewFront'
  | 'fit';

/** What was under the pointer: an item, or the board/background with the wall point (mm) if the ray hit the wall plane. */
export type MenuTarget =
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'board'; readonly point: Vec2 | null };

export interface MenuContext {
  readonly target: MenuTarget;
  /** The selection the menu acts on (right-clicking an unselected item selects it first). */
  readonly selected: readonly WallItem[];
  readonly clipboardCount: number;
  readonly view: ViewMode;
}

export interface MenuEntry {
  readonly action: MenuAction;
  readonly label: MessageKey;
  /** Display string of the matching keyboard shortcut. */
  readonly shortcut?: string;
  readonly disabled: boolean;
  readonly destructive: boolean;
  /** Set only on entries that show a current state (the active view). */
  readonly checked?: boolean;
}

function entry(
  action: MenuAction,
  label: MessageKey,
  options: {
    readonly shortcut?: string;
    readonly disabled?: boolean;
    readonly destructive?: boolean;
    readonly checked?: boolean;
  } = {},
): MenuEntry {
  return {
    action,
    label,
    disabled: options.disabled ?? false,
    destructive: options.destructive ?? false,
    ...(options.shortcut === undefined ? {} : { shortcut: options.shortcut }),
    ...(options.checked === undefined ? {} : { checked: options.checked }),
  };
}

/** Groups of entries; the renderer puts a separator between groups. */
export function buildMenu(context: MenuContext): MenuEntry[][] {
  return context.target.kind === 'item' ? itemMenu(context) : boardMenu(context, context.target);
}

function itemMenu({ selected }: MenuContext): MenuEntry[][] {
  const copyable = selected.some((item) => item.cell !== undefined);
  const movable = selected.some((item) => !item.locked);
  const unlockOnly = selected.length > 0 && selected.every((item) => item.locked);
  return [
    [
      entry('duplicate', 'action.duplicate', { shortcut: 'Ctrl+D', disabled: !copyable }),
      entry('copy', 'context.copy', { shortcut: 'Ctrl+C', disabled: !copyable }),
    ],
    [
      entry('rotateRight', 'action.rotateRight', { shortcut: 'R', disabled: !movable }),
      entry('rotateLeft', 'action.rotateLeft', { shortcut: 'Shift+R', disabled: !movable }),
      entry('toggleLock', unlockOnly ? 'action.unlock' : 'action.lock', { shortcut: 'L' }),
      entry('properties', 'context.properties', { disabled: selected.length !== 1 }),
    ],
    [entry('delete', 'action.delete', { shortcut: 'Del', destructive: true, disabled: !movable })],
  ];
}

function boardMenu(
  { clipboardCount, view }: MenuContext,
  target: { readonly point: Vec2 | null },
): MenuEntry[][] {
  const placeable = target.point !== null;
  return [
    [
      entry('paste', 'context.pasteHere', {
        shortcut: 'Ctrl+V',
        disabled: clipboardCount === 0 || !placeable,
      }),
      entry('addHere', 'context.addHere', { disabled: !placeable }),
      entry('selectAll', 'action.selectAll', { shortcut: 'Ctrl+A' }),
    ],
    [
      entry('viewPerspective', 'view.perspective', {
        shortcut: 'O',
        checked: view === 'perspective',
      }),
      entry('viewFront', 'view.front', { shortcut: 'O', checked: view === 'front' }),
      entry('fit', 'view.fit', { shortcut: 'F' }),
    ],
  ];
}
