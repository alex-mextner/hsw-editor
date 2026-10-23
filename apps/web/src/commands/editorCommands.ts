/**
 * Every editor action as a registry command (ids are persisted in user keymaps, so they are stable).
 * Handlers go through `EditorActions` so the definitions, default keys and when-clauses can be
 * checked without the 3D scene, the network or the DOM.
 */
import { defineCommand, type Command } from '@hsw-editor/commands';
import { z } from 'zod';
import { msg } from './messages.ts';

export type PanelKey = 'bank' | 'inspector' | 'history' | 'agent';

export interface EditorActions {
  readonly undo: () => void;
  readonly redo: () => void;
  readonly deleteSelection: () => void;
  readonly duplicateSelection: () => void;
  readonly rotateSelection: (steps: number) => void;
  readonly toggleLockSelection: () => void;
  readonly selectAll: () => void;
  readonly deselect: () => void;
  /** Remembers the selected items so Paste can put copies on the wall. */
  readonly copySelection: () => void;
  readonly pasteClipboard: () => void;
  /** One step in a unit direction; the app scales it by the nudge setting. */
  readonly nudge: (dx: -1 | 0 | 1, dy: -1 | 0 | 1) => void;
  readonly selectTool: () => void;
  readonly toggleMeasure: () => void;
  readonly toggleSnap: () => void;
  readonly fitView: () => void;
  readonly toggleViewMode: () => void;
  readonly toggleOverlay: () => void;
  readonly exportPhoto: () => void;
  readonly findPhotoTools: () => void;
  /** Runs the wall physics check and opens its report list (the wall view of the inspector). */
  readonly checkPhysics: () => void;
  /** Seats every hung tool in its holder as the physics says (one undo step). */
  readonly seatPhysics: () => void;
  readonly calibratePhoto: () => void;
  readonly togglePhotoVisible: () => void;
  readonly togglePhotoSplit: () => void;
  readonly cleanPhotoBackground: () => void;
  readonly toggleAutoClean: () => void;
  readonly togglePanel: (panel: PanelKey) => void;
  /** Opens the panel and moves keyboard focus into it. */
  readonly focusPanel: (panel: PanelKey) => void;
  readonly newWall: () => void;
  readonly toggleTheme: () => void;
  readonly toggleLanguage: () => void;
  readonly openPalette: (initialInput?: string) => void;
  readonly toggleCheatSheet: () => void;
  readonly openKeybindingEditor: () => void;
  readonly openWall: (id: string) => boolean;
  readonly selectItem: (id: string) => boolean;
  /** Adds the bank element to the wall; the new item id, or null when it did not fit. */
  readonly addBankElement: (id: string) => string | null;
  readonly addToolPreset: (toolClassId: string) => string | null;
  /** Brings the Tool Library tab forward (opening the left panel). */
  readonly showToolLibrary: () => void;
  /** Opens the "Add from photo" wizard of the Tool Library. */
  readonly openToolPhotoWizard: () => void;
  /** Shows the library filtered by `query` (ru/en words). */
  readonly searchToolLibrary: (query: string) => void;
  /** Adds a library tool by entry key (`class:<id>`, `tool:<id>`) or bare id; the new item id, or null. */
  readonly addLibraryTool: (id: string) => string | null;
  /** Undoes edits until the wall is at `rev`; resolves to the number of undo steps taken. */
  readonly undoToRevision: (rev: number) => Promise<number>;
  readonly resetSettings: () => void;
}

/** Single-key shortcuts must stay quiet while a dialog (palette, editor, wizard) is open. */
const FREE = '!dialog';

const PANELS: readonly {
  readonly panel: PanelKey;
  readonly key: string;
  readonly chord: string;
}[] = [
  { panel: 'bank', key: 'b', chord: 'g b' },
  { panel: 'inspector', key: 'i', chord: 'g i' },
  { panel: 'history', key: 'h', chord: 'g h' },
  { panel: 'agent', key: 'a', chord: 'g a' },
];

const PANEL_TITLES = {
  bank: msg('panel.bank'),
  inspector: msg('panel.inspector'),
  history: msg('panel.history'),
  agent: msg('panel.omp'),
} as const;

const SHOW_TITLES = {
  bank: msg('cmd.panel.show.bank'),
  inspector: msg('cmd.panel.show.inspector'),
  history: msg('cmd.panel.show.history'),
  agent: msg('cmd.panel.show.agent'),
} as const;

const NUDGES = [
  { id: 'Left', title: msg('action.nudgeLeft'), key: 'left', dx: -1, dy: 0 },
  { id: 'Right', title: msg('action.nudgeRight'), key: 'right', dx: 1, dy: 0 },
  { id: 'Up', title: msg('action.nudgeUp'), key: 'up', dx: 0, dy: 1 },
  { id: 'Down', title: msg('action.nudgeDown'), key: 'down', dx: 0, dy: -1 },
] as const;

/** Handlers return JSON for the AI; a plain action returns nothing. */
function effect(action: () => void): () => undefined {
  return () => {
    action();
    return undefined;
  };
}

const idArgs = z.object({ id: z.string().min(1) });

function requireSome<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

export function createEditorCommands(actions: EditorActions): readonly Command[] {
  return [
    defineCommand({
      id: 'edit.undo',
      title: msg('action.undo'),
      keywords: ['revert', 'отменить', 'отмена', 'назад'],
      group: 'edit',
      when: `canUndo && ${FREE}`,
      keybindings: { all: ['mod+z'] },
      mutates: true,
      handler: effect(actions.undo),
    }),
    defineCommand({
      id: 'edit.redo',
      title: msg('action.redo'),
      keywords: ['repeat', 'вернуть', 'повторить'],
      group: 'edit',
      when: `canRedo && ${FREE}`,
      keybindings: { all: ['mod+shift+z', 'ctrl+y'] },
      mutates: true,
      handler: effect(actions.redo),
    }),
    defineCommand({
      id: 'edit.delete',
      title: msg('action.delete'),
      keywords: ['remove', 'удалить', 'убрать'],
      group: 'edit',
      when: `selection && ${FREE}`,
      keybindings: { all: ['delete', 'backspace'] },
      mutates: true,
      handler: effect(actions.deleteSelection),
    }),
    defineCommand({
      id: 'edit.duplicate',
      title: msg('action.duplicate'),
      keywords: ['copy', 'clone', 'копировать', 'дублировать'],
      group: 'edit',
      when: `selection && ${FREE}`,
      keybindings: { all: ['mod+d'] },
      mutates: true,
      handler: effect(actions.duplicateSelection),
    }),
    defineCommand({
      id: 'edit.copy',
      title: msg('context.copy'),
      keywords: ['clipboard', 'copy items', 'копировать', 'буфер'],
      group: 'edit',
      // Ctrl+C with text selected (agent transcript, inspector) is a text copy, not a wall copy.
      when: `selection && !textSelection && ${FREE}`,
      keybindings: { all: ['mod+c'] },
      mutates: false,
      handler: effect(actions.copySelection),
    }),
    defineCommand({
      id: 'edit.paste',
      title: msg('action.paste'),
      keywords: ['clipboard', 'paste items', 'вставить', 'буфер'],
      group: 'edit',
      when: `hasWall && clipboard && ${FREE}`,
      keybindings: { all: ['mod+v'] },
      mutates: true,
      handler: effect(actions.pasteClipboard),
    }),
    defineCommand({
      id: 'edit.rotate',
      title: msg('action.rotateRight'),
      keywords: ['turn', 'повернуть', 'поворот'],
      group: 'edit',
      when: `selection && ${FREE}`,
      keybindings: { all: ['r'] },
      mutates: true,
      handler: effect(() => actions.rotateSelection(1)),
    }),
    defineCommand({
      id: 'edit.rotateBack',
      title: msg('action.rotateLeft'),
      keywords: ['turn', 'повернуть', 'поворот'],
      group: 'edit',
      when: `selection && ${FREE}`,
      keybindings: { all: ['shift+r'] },
      mutates: true,
      handler: effect(() => actions.rotateSelection(-1)),
    }),
    defineCommand({
      id: 'edit.lock',
      title: msg('action.lockToggle'),
      keywords: ['unlock', 'заблокировать', 'зафиксировать', 'замок'],
      group: 'edit',
      when: `selection && ${FREE}`,
      keybindings: { all: ['l'] },
      mutates: true,
      handler: effect(actions.toggleLockSelection),
    }),
    defineCommand({
      id: 'edit.selectAll',
      title: msg('action.selectAll'),
      keywords: ['выделить всё', 'выбрать все'],
      group: 'edit',
      when: `hasWall && ${FREE}`,
      keybindings: { all: ['mod+a'] },
      mutates: true,
      handler: effect(actions.selectAll),
    }),
    defineCommand({
      id: 'edit.deselect',
      title: msg('action.deselect'),
      keywords: ['clear selection', 'снять выделение'],
      group: 'edit',
      when: `(selection || placeAt) && ${FREE}`,
      keybindings: { all: ['escape'] },
      mutates: true,
      handler: effect(actions.deselect),
    }),
    ...NUDGES.map((nudge) =>
      defineCommand({
        id: `edit.nudge${nudge.id}`,
        title: nudge.title,
        keywords: ['move', 'сдвинуть', 'переместить'],
        group: 'edit',
        when: `selection && ${FREE}`,
        keybindings: { all: [nudge.key] },
        mutates: true,
        repeat: true,
        handler: effect(() => actions.nudge(nudge.dx, nudge.dy)),
      }),
    ),

    defineCommand({
      id: 'tool.select',
      title: msg('tool.select'),
      keywords: ['pointer', 'выбор', 'выделение'],
      group: 'tools',
      when: FREE,
      keybindings: { all: ['v'] },
      mutates: false,
      handler: effect(actions.selectTool),
    }),
    defineCommand({
      id: 'tool.measure',
      title: msg('tool.measure'),
      keywords: ['ruler', 'distance', 'линейка', 'измерить', 'рулетка'],
      group: 'tools',
      when: FREE,
      keybindings: { all: ['m'] },
      mutates: false,
      handler: effect(actions.toggleMeasure),
    }),
    defineCommand({
      id: 'tool.snap',
      title: msg('tool.snap'),
      keywords: ['grid', 'сетка', 'привязка', 'шаг'],
      group: 'tools',
      when: FREE,
      keybindings: { all: ['s'] },
      mutates: true,
      handler: effect(actions.toggleSnap),
    }),

    defineCommand({
      id: 'view.fit',
      title: msg('view.fit'),
      keywords: ['zoom', 'вписать', 'масштаб', 'по размеру'],
      group: 'view',
      when: FREE,
      keybindings: { all: ['f'] },
      mutates: false,
      handler: effect(actions.fitView),
    }),
    defineCommand({
      id: 'view.toggle',
      title: msg('view.toggle'),
      keywords: ['perspective', 'orthographic', 'перспектива', 'фронтальный', 'вид'],
      group: 'view',
      when: FREE,
      keybindings: { all: ['o'] },
      mutates: true,
      handler: effect(actions.toggleViewMode),
    }),
    defineCommand({
      id: 'view.overlay',
      title: msg('overlay.toggle'),
      keywords: ['photo', 'фото', 'наложение'],
      group: 'view',
      when: `hasWall && ${FREE}`,
      keybindings: { all: ['p'] },
      mutates: false,
      handler: effect(actions.toggleOverlay),
    }),
    defineCommand({
      id: 'photo.export',
      title: msg('photo.cmd.export'),
      keywords: ['png', 'export', 'photo', 'экспорт', 'фото'],
      group: 'view',
      when: `hasWall && ${FREE}`,
      mutates: false,
      handler: effect(actions.exportPhoto),
    }),
    defineCommand({
      id: 'photo.findTools',
      title: msg('photo.cmd.findTools'),
      keywords: ['tools', 'detect', 'vision', 'инструменты', 'найти'],
      group: 'view',
      when: `hasWall && ${FREE}`,
      mutates: false,
      handler: effect(actions.findPhotoTools),
    }),
    defineCommand({
      id: 'physics.check',
      title: msg('physics.cmd.check'),
      keywords: [
        'physics',
        'stability',
        'balance',
        'hang',
        'swing',
        'tip',
        'removal',
        'физика',
        'устойчивость',
        'равновесие',
      ],
      group: 'view',
      when: `hasWall && ${FREE}`,
      mutates: false,
      handler: effect(actions.checkPhysics),
    }),
    defineCommand({
      id: 'physics.seat',
      title: msg('physics.cmd.seat'),
      keywords: ['physics', 'seat', 'hang', 'levitate', 'fix', 'физика', 'посадить', 'держатель'],
      group: 'edit',
      when: `hasWall && ${FREE}`,
      mutates: true,
      handler: effect(actions.seatPhysics),
    }),
    defineCommand({
      id: 'photo.calibrate',
      title: msg('photo.cmd.calibrate'),
      keywords: ['scale', 'tape', 'ruler', 'калибровка', 'масштаб'],
      group: 'view',
      when: `hasWall && ${FREE}`,
      mutates: false,
      handler: effect(actions.calibratePhoto),
    }),
    defineCommand({
      id: 'photo.hide',
      title: msg('photo.cmd.hide'),
      keywords: ['photo', 'hide', 'фото', 'скрыть'],
      group: 'view',
      when: `hasWall && ${FREE}`,
      mutates: false,
      handler: effect(actions.togglePhotoVisible),
    }),
    defineCommand({
      id: 'photo.split',
      title: msg('photo.cmd.split'),
      keywords: ['before', 'after', 'compare', 'до', 'после'],
      group: 'view',
      when: `hasWall && ${FREE}`,
      mutates: false,
      handler: effect(actions.togglePhotoSplit),
    }),
    defineCommand({
      id: 'photo.cleanBackground',
      title: msg('photo.cmd.cleanBackground'),
      keywords: ['clean', 'erase', 'background', 'inpaint', 'очистить', 'фон', 'стена'],
      group: 'view',
      when: `hasWall && ${FREE}`,
      mutates: true,
      handler: effect(actions.cleanPhotoBackground),
    }),
    defineCommand({
      id: 'photo.autoClean',
      title: msg('photo.cmd.autoClean'),
      keywords: ['clean', 'auto', 'background', 'авто', 'фон', 'очистка'],
      group: 'view',
      when: FREE,
      mutates: false,
      handler: effect(actions.toggleAutoClean),
    }),
    ...PANELS.map(({ panel, key }) =>
      defineCommand({
        id: `panel.${panel === 'agent' ? 'omp' : panel}`,
        title: PANEL_TITLES[panel],
        keywords: ['panel', 'sidebar', 'панель'],
        group: 'view',
        when: FREE,
        keybindings: { all: [key] },
        mutates: true,
        handler: effect(() => actions.togglePanel(panel)),
      }),
    ),
    ...PANELS.map(({ panel, chord }) =>
      defineCommand({
        id: `panel.focus.${panel}`,
        title: SHOW_TITLES[panel],
        keywords: ['focus', 'open', 'фокус', 'открыть'],
        group: 'navigation',
        when: FREE,
        keybindings: { all: [chord] },
        mutates: false,
        handler: effect(() => actions.focusPanel(panel)),
      }),
    ),

    defineCommand({
      id: 'wall.new',
      title: msg('wall.new'),
      keywords: ['create', 'создать', 'новая стена'],
      group: 'wall',
      when: FREE,
      mutates: true,
      handler: effect(actions.newWall),
    }),
    defineCommand({
      id: 'app.theme',
      title: msg('theme.toggle'),
      keywords: ['dark', 'light', 'тема', 'тёмная', 'светлая'],
      group: 'app',
      mutates: true,
      handler: effect(actions.toggleTheme),
    }),
    defineCommand({
      id: 'app.language',
      title: msg('language.toggle'),
      keywords: ['russian', 'english', 'язык', 'русский', 'английский'],
      group: 'app',
      mutates: true,
      handler: effect(actions.toggleLanguage),
    }),

    defineCommand({
      id: 'app.palette',
      title: msg('cmd.palette.open'),
      description: msg('cmd.palette.openDescription'),
      keywords: ['search', 'find', 'поиск', 'палитра', 'команды'],
      group: 'app',
      keybindings: { all: ['mod+shift+p', 'mod+k'] },
      allowInInput: true,
      mutates: false,
      aiHidden: true,
      handler: effect(() => actions.openPalette()),
    }),
    defineCommand({
      id: 'app.palette.commands',
      title: msg('cmd.palette.commandsMode'),
      group: 'app',
      mutates: false,
      aiHidden: true,
      handler: effect(() => actions.openPalette('>')),
    }),
    defineCommand({
      id: 'ai.ask',
      title: msg('cmd.palette.askAi'),
      description: msg('cmd.palette.askAiDescription'),
      keywords: ['assistant', 'agent', 'ИИ', 'ассистент', 'агент', 'спросить'],
      group: 'ai',
      mutates: false,
      aiHidden: true,
      handler: effect(() => actions.openPalette('?')),
    }),
    defineCommand({
      id: 'help.cheatsheet',
      title: msg('cmd.cheatsheet.toggle'),
      description: msg('help.cheatsheetDescription'),
      keywords: ['hotkeys', 'shortcuts', 'help', 'горячие клавиши', 'справка', 'шпаргалка'],
      group: 'help',
      keybindings: { all: ['shift+/'] },
      mutates: false,
      aiHidden: true,
      handler: effect(actions.toggleCheatSheet),
    }),
    defineCommand({
      id: 'app.keybindings',
      title: msg('cmd.keybindings.open'),
      keywords: ['hotkeys', 'shortcuts', 'rebind', 'горячие клавиши', 'клавиши', 'сочетания'],
      group: 'settings',
      // `mod+k` already opens the palette, and a chord starting with it could never be completed.
      keybindings: { all: ['g k'] },
      when: FREE,
      mutates: false,
      aiHidden: true,
      handler: effect(actions.openKeybindingEditor),
    }),

    defineCommand({
      id: 'wall.open',
      title: msg('cmd.wall.open'),
      description: msg('cmd.wall.openDescription'),
      group: 'wall',
      args: idArgs,
      mutates: true,
      handler: ({ id }) => {
        if (!actions.openWall(id)) throw new Error(`unknown wall '${id}'`);
        return { opened: id };
      },
    }),
    defineCommand({
      id: 'item.select',
      title: msg('cmd.item.select'),
      description: msg('cmd.item.selectDescription'),
      group: 'edit',
      when: 'hasWall',
      args: idArgs,
      mutates: true,
      handler: ({ id }) => {
        if (!actions.selectItem(id)) throw new Error(`no item '${id}' on the wall`);
        return { selected: id };
      },
    }),
    defineCommand({
      id: 'bank.add',
      title: msg('cmd.bank.add'),
      description: msg('cmd.bank.addDescription'),
      group: 'bank',
      when: 'hasWall',
      args: idArgs,
      mutates: true,
      handler: ({ id }) => ({
        itemId: requireSome(
          actions.addBankElement(id),
          `cannot add '${id}': no room or unknown id`,
        ),
      }),
    }),
    defineCommand({
      id: 'tool.addPreset',
      title: msg('cmd.tool.addPreset'),
      description: msg('cmd.tool.addPresetDescription'),
      group: 'bank',
      when: 'hasWall',
      args: idArgs,
      mutates: true,
      handler: ({ id }) => ({
        itemId: requireSome(actions.addToolPreset(id), `cannot add tool '${id}'`),
      }),
    }),
    defineCommand({
      id: 'tools.library.show',
      title: msg('cmd.tools.library.show'),
      keywords: ['tools', 'library', 'инструменты', 'библиотека'],
      group: 'navigation',
      when: FREE,
      keybindings: { all: ['g t'] },
      mutates: false,
      handler: effect(actions.showToolLibrary),
    }),
    defineCommand({
      id: 'tools.library.search',
      title: msg('cmd.tools.library.search'),
      description: msg('cmd.tools.library.searchDescription'),
      keywords: ['tools', 'find', 'инструменты', 'найти'],
      group: 'bank',
      args: z.object({ query: z.string() }),
      mutates: false,
      handler: ({ query }) => {
        actions.searchToolLibrary(query);
        return { query };
      },
    }),
    defineCommand({
      id: 'tools.fromPhoto',
      title: msg('cmd.tools.fromPhoto'),
      keywords: ['photo', 'camera', 'custom tool', 'фото', 'свой инструмент'],
      group: 'bank',
      when: FREE,
      mutates: false,
      handler: effect(actions.openToolPhotoWizard),
    }),
    defineCommand({
      id: 'tools.add',
      title: msg('cmd.tools.add'),
      description: msg('cmd.tools.addDescription'),
      group: 'bank',
      when: 'hasWall',
      args: idArgs,
      mutates: true,
      handler: ({ id }) => ({
        itemId: requireSome(actions.addLibraryTool(id), `cannot add library tool '${id}'`),
      }),
    }),
    defineCommand({
      id: 'history.undoTo',
      title: msg('cmd.history.undoTo'),
      description: msg('cmd.history.undoToDescription'),
      group: 'history',
      when: 'canUndo',
      args: z.object({ rev: z.number().int().min(0) }),
      mutates: true,
      handler: async ({ rev }) => ({ undone: await actions.undoToRevision(rev) }),
    }),
    defineCommand({
      id: 'settings.reset',
      title: msg('cmd.settings.reset'),
      description: msg('cmd.settings.resetDescription'),
      keywords: ['default', 'defaults', 'сбросить', 'по умолчанию'],
      group: 'settings',
      mutates: true,
      handler: effect(actions.resetSettings),
    }),
  ];
}
