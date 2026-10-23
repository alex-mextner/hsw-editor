/** Shared fixtures for the package tests: a small command set shaped like the editor's own. */
import { type Command, defineCommand } from './registry.ts';
import type { KeyEventLike } from './keys.ts';

export const calls: string[] = [];

export function resetCalls(): void {
  calls.length = 0;
}

function note(id: string): () => undefined {
  return () => {
    calls.push(id);
    return undefined;
  };
}

export function sampleCommands(): readonly Command[] {
  return [
    defineCommand({
      id: 'edit.undo',
      title: { en: 'Undo', ru: 'Отменить' },
      keywords: ['revert', 'отмена'],
      group: 'edit',
      keybindings: { all: ['mod+z'] },
      mutates: true,
      handler: note('edit.undo'),
    }),
    defineCommand({
      id: 'edit.redo',
      title: { en: 'Redo', ru: 'Повторить' },
      group: 'edit',
      keybindings: { all: ['mod+shift+z'], windows: ['ctrl+y'], linux: ['mod+shift+z', 'ctrl+y'] },
      mutates: true,
      handler: note('edit.redo'),
    }),
    defineCommand({
      id: 'edit.delete',
      title: { en: 'Delete selection', ru: 'Удалить выбранное' },
      group: 'edit',
      when: 'selection',
      keybindings: { all: ['delete', 'backspace'] },
      mutates: true,
      handler: note('edit.delete'),
    }),
    defineCommand({
      id: 'edit.rotate',
      title: { en: 'Rotate', ru: 'Повернуть' },
      group: 'edit',
      when: 'selection && !dialog',
      keybindings: { all: ['r'] },
      mutates: true,
      handler: note('edit.rotate'),
    }),
    defineCommand({
      id: 'view.toggleGrid',
      title: { en: 'Toggle grid', ru: 'Показать или скрыть сетку' },
      keywords: ['honeycomb', 'сетка'],
      group: 'view',
      keybindings: { all: ['g'] },
      mutates: false,
      handler: note('view.toggleGrid'),
    }),
    defineCommand({
      id: 'view.sortElements',
      title: { en: 'Sort elements', ru: 'Сортировать элементы' },
      keywords: ['sort', 'order', 'сортировка'],
      group: 'wall',
      mutates: true,
      handler: note('view.sortElements'),
    }),
    defineCommand({
      id: 'app.palette',
      title: { en: 'Command palette', ru: 'Палитра команд' },
      group: 'app',
      keybindings: { all: ['mod+shift+p', 'mod+k'] },
      allowInInput: true,
      mutates: false,
      handler: note('app.palette'),
    }),
    defineCommand({
      id: 'app.settings',
      title: { en: 'Open settings', ru: 'Открыть настройки' },
      group: 'app',
      keybindings: { all: ['mod+e mod+s'] },
      mutates: false,
      handler: note('app.settings'),
    }),
    defineCommand({
      id: 'app.cheatsheet',
      title: { en: 'Keyboard shortcuts', ru: 'Горячие клавиши' },
      group: 'help',
      keybindings: { all: ['shift+/'] },
      mutates: false,
      handler: note('app.cheatsheet'),
    }),
  ];
}

export interface KeyOptions {
  readonly key?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
  readonly repeat?: boolean;
}

export function keyEvent(code: string, options: KeyOptions = {}): KeyEventLike {
  return {
    code,
    key: options.key ?? (code.startsWith('Key') ? code.slice(3).toLowerCase() : code),
    ctrlKey: options.ctrl === true,
    metaKey: options.meta === true,
    altKey: options.alt === true,
    shiftKey: options.shift === true,
    isComposing: options.isComposing,
    keyCode: options.keyCode,
    repeat: options.repeat,
  };
}
