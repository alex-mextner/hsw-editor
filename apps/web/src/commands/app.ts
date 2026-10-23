/**
 * The command center's composition root: the one registry, settings store, keymap, key dispatcher
 * and palette/dialog state of the editor. Panels and dialogs read everything from here.
 */
import { createValueStore } from '#state-backend';
import {
  buildKeymap,
  CommandRegistry,
  detectPlatform,
  EMPTY_USAGE,
  EMPTY_USER_KEYMAP,
  formatChord,
  bindingsOf,
  KeyDispatcher,
  parseUsage,
  parseUserKeymap,
  recordUse,
  settingCommands,
  SettingsStore,
  type Context,
  type Keymap,
  type KeyEventLike,
  type KeyOutcome,
  type PendingChord,
  type Platform,
  type UsageRecord,
  type UserKeymap,
  type Command,
} from '@hsw-editor/commands';
import { createHttpTransport, createSettingsClient } from '@hsw-editor/user-settings';
import { newWallDialogStore } from '@/features/wizard/NewWallDialog.tsx';
import { notify } from '@/features/notices/notices.ts';
import { localeStore, t } from '@/i18n/index.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import type { ValueStore } from '@/state/types.ts';
import { clipboardStore } from '@/wall/clipboard.ts';
import { sessionStore } from '@/wall/session.ts';
import { createAppActions } from './appActions.ts';
import { appSettingBindings } from './appBindings.ts';
import { APP_SETTINGS, DEFAULT_CHORD_TIMEOUT_MS } from './appSettings.ts';
import { deriveContext, focusRegion, probeFocus } from './context.ts';
import { createEditorCommands } from './editorCommands.ts';
import { persistNamespaces, startServerSync } from './persistence.ts';
import { wireSettings } from './settingsSync.ts';
import { commandTitle } from './messages.ts';
import { isTypingTarget } from './typing.ts';

export { commandTitle, msg } from './messages.ts';

// ---- Registry and settings ----------------------------------------------------------------------

export const commandRegistry = new CommandRegistry();
export const settingsStore = new SettingsStore(APP_SETTINGS);

// ---- Dialog and palette state -------------------------------------------------------------------

export interface PaletteState {
  readonly open: boolean;
  readonly input: string;
}

export const paletteStore: ValueStore<PaletteState> = createValueStore<PaletteState>({
  open: false,
  input: '',
});
export const keybindingEditorStore: ValueStore<boolean> = createValueStore(false);
export const cheatSheetStore: ValueStore<boolean> = createValueStore(false);
/** The chord typed so far, for the "waiting for the next key" hint. */
export const pendingChordStore: ValueStore<PendingChord | null> =
  createValueStore<PendingChord | null>(null);

export function openPalette(initialInput = ''): void {
  paletteStore.set({ open: true, input: initialInput });
}

export function closePalette(): void {
  paletteStore.set({ open: false, input: '' });
}

// ---- Keymap ----------------------------------------------------------------------------------------

export interface KeymapState {
  readonly platform: Platform;
  readonly user: UserKeymap;
  readonly keymap: Keymap;
  readonly commands: readonly Command[];
}

const platform = detectPlatform({
  platform: globalThis.navigator?.platform,
  userAgent: globalThis.navigator?.userAgent,
});

function keymapState(user: UserKeymap): KeymapState {
  const commands = commandRegistry.all();
  return { platform, user, keymap: buildKeymap(commands, user, platform), commands };
}

export const keymapStore: ValueStore<KeymapState> = createValueStore(
  keymapState(EMPTY_USER_KEYMAP),
);
commandRegistry.subscribe(() => keymapStore.set(keymapState(keymapStore.get().user)));

/** Validates (bad entries are dropped, keys canonicalised), applies and persists a user keymap. */
export function setUserKeymap(next: UserKeymap): void {
  const parsed = parseUserKeymap(next);
  if (!parsed.ok) {
    notify('error', parsed.error);
    return;
  }
  keymapStore.set(keymapState(parsed.value.keymap));
}

export function useKeymapState(): KeymapState {
  return useStore(keymapStore);
}

/** First binding of a command as the platform writes it (`Ctrl+Z`, `⌘Z`), if it has one. */
export function shortcutLabel(commandId: string): string | undefined {
  const { keymap } = keymapStore.get();
  const binding = bindingsOf(keymap, commandId)[0];
  return binding === undefined ? undefined : formatChord(binding.chord, keymap.platform);
}

/** Reactive {@link shortcutLabel}: updates when the user rebinds the command. */
export function useShortcutLabel(commandId: string): string | undefined {
  useStore(keymapStore);
  return shortcutLabel(commandId);
}

// ---- Context -----------------------------------------------------------------------------------------

function overlayOpen(): boolean {
  return paletteStore.get().open || keybindingEditorStore.get() || cheatSheetStore.get();
}

function buildContext(options: { readonly overlays: boolean; readonly live: boolean }): Context {
  const session = sessionStore.get();
  const editor = editorStore.get();
  const typing = options.live && isTypingTarget(globalThis.document?.activeElement ?? null);
  const palette = options.overlays && paletteStore.get().open;
  return deriveContext({
    selectionCount: editor.selection.length,
    hasWall: session?.wall != null,
    canUndo: session?.canUndo === true,
    canRedo: session?.canRedo === true,
    clipboard: clipboardStore.get().length > 0,
    textSelection: options.live && (globalThis.getSelection?.()?.toString() ?? '') !== '',
    placeAt: editor.placeAt !== null,
    mode: editor.tool,
    dialogOpen: newWallDialogStore.get() || (options.overlays && overlayOpen()),
    focus: options.live
      ? focusRegion(probeFocus(palette, typing))
      : focusRegion({ slot: undefined, typing: false, paletteOpen: false }),
    settings: settingsStore.context(),
  });
}

/** The context of the key that was just pressed: where focus is and which overlays are open. */
export function getCommandContext(): Context {
  return buildContext({ overlays: true, live: true });
}

/**
 * The context of the editor behind the palette and the other overlays. The palette lists and runs
 * commands against this, otherwise its own open dialog would disable every `!dialog` command.
 */
export function getBaseContext(): Context {
  return buildContext({ overlays: false, live: false });
}

function sameContext(a: Context, b: Context): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

const contextStore: ValueStore<Context> = createValueStore(
  buildContext({ overlays: false, live: false }),
);
for (const source of [sessionStore, editorStore, newWallDialogStore]) {
  source.subscribe(refreshContext);
}
settingsStore.subscribe(refreshContext);

function refreshContext(): void {
  const next = buildContext({ overlays: false, live: false });
  if (!sameContext(contextStore.get(), next)) contextStore.set(next);
}

/**
 * Context for panels that list shortcuts (cheat-sheet, keybinding editor): what holds once the
 * overlays are closed and focus is back on the canvas, since those overlays are what is open
 * while the list is read. A wizard dialog still counts.
 */
export function useCommandContext(): Context {
  return useStore(contextStore);
}

// ---- Running commands and usage -----------------------------------------------------------------------

const USAGE_NAMESPACE = 'palette';
export const usageStore: ValueStore<UsageRecord> = createValueStore<UsageRecord>(EMPTY_USAGE);

export function recordPaletteUse(itemId: string): void {
  usageStore.set(recordUse(usageStore.get(), itemId, Date.now()));
}

async function runBinding(commandId: string): Promise<void> {
  const command = commandRegistry.get(commandId);
  const outcome = await commandRegistry.run(commandId, undefined, getCommandContext());
  if (!outcome.ok && outcome.reason === 'failed') {
    notify(
      'error',
      t('cmd.failed', {
        title: command === undefined ? commandId : commandTitle(command, localeStore.get()),
        reason: outcome.message,
      }),
    );
  }
}

// ---- Key dispatcher -----------------------------------------------------------------------------------

function chordTimeout(): number {
  const value = settingsStore.get('keyboard.chordTimeout');
  return typeof value === 'number' ? value : DEFAULT_CHORD_TIMEOUT_MS;
}

function createDispatcher(): { readonly dispatcher: KeyDispatcher; readonly stop: () => void } {
  const dispatcher = new KeyDispatcher({
    getKeymap: () => keymapStore.get().keymap,
    getContext: getCommandContext,
    onRun: (binding) => void runBinding(binding.commandId),
    timeoutMs: chordTimeout(),
  });
  return { dispatcher, stop: dispatcher.subscribe((pending) => pendingChordStore.set(pending)) };
}

let active = createDispatcher();

/** Feeds a key event to the keymap; `consumed` means the caller must stop the browser handling it. */
export function dispatchKey(event: KeyEventLike, typing: boolean): KeyOutcome {
  return active.dispatcher.handleKeyDown(event, typing);
}

function restartDispatcher(): void {
  active.dispatcher.reset();
  active.stop();
  active = createDispatcher();
}

// ---- Registration and start -----------------------------------------------------------------------------

function resetAllSettings(): void {
  for (const definition of settingsStore.definitions) settingsStore.reset(definition.id);
}

commandRegistry.register(
  ...createEditorCommands(
    createAppActions({
      // The palette key opens it and, pressed again, closes it; a mode prefix always (re)opens.
      openPalette: (initialInput) =>
        paletteStore.get().open && initialInput === undefined
          ? closePalette()
          : openPalette(initialInput),
      toggleCheatSheet: () => cheatSheetStore.set(!cheatSheetStore.get()),
      openKeybindingEditor: () => keybindingEditorStore.set(true),
      nudgeStep: () => {
        const value = settingsStore.get('editor.nudge');
        return typeof value === 'number' ? value : 2;
      },
      resetSettings: resetAllSettings,
    }),
  ),
  ...settingCommands(settingsStore),
);

/**
 * Loads and persists settings, keymap and palette usage, mirrors settings into the app stores and
 * keeps the key dispatcher in step. Safe without a server: everything stays local until it is back.
 */
export function startCommandCenter(): () => void {
  const client = createSettingsClient({
    transport: createHttpTransport(),
    storage: globalThis.localStorage,
  });
  const settings = wireSettings(client, settingsStore, appSettingBindings());
  const unpersist = persistNamespaces(client, [
    {
      namespace: 'keymap',
      read: () => {
        const { user } = keymapStore.get();
        return Object.keys(user.overrides).length === 0 ? undefined : user;
      },
      write: (value) => {
        const parsed = parseUserKeymap(value ?? EMPTY_USER_KEYMAP);
        keymapStore.set(keymapState(parsed.ok ? parsed.value.keymap : EMPTY_USER_KEYMAP));
      },
      subscribe: keymapStore.subscribe,
    },
    {
      namespace: USAGE_NAMESPACE,
      read: () => (Object.keys(usageStore.get()).length === 0 ? undefined : usageStore.get()),
      write: (value) => usageStore.set(parseUsage(value)),
      subscribe: usageStore.subscribe,
    },
  ]);
  restartDispatcher();
  const stopTimeout = settingsStore.subscribe((id) => {
    if (id === 'keyboard.chordTimeout') restartDispatcher();
  });
  // A dialog opening mid-chord would otherwise complete the chord behind it.
  const dialogStores = [paletteStore, keybindingEditorStore, cheatSheetStore, newWallDialogStore];
  const stopDialogs = dialogStores.map((store) => store.subscribe(() => active.dispatcher.reset()));
  const sync = startServerSync(client, {
    eventsUrl: '/api/settings/events',
    createEventSource: (url) => new EventSource(url),
    addWindowListener: (type, listener) => {
      globalThis.addEventListener(type, listener);
      return () => globalThis.removeEventListener(type, listener);
    },
  });
  let stopped = false;
  // The server's document goes first; the app's own values are reconciled with it afterwards.
  void sync.ready.then(() => {
    if (!stopped) settings.adopt();
  });
  return () => {
    stopped = true;
    sync.dispose();
    for (const stop of stopDialogs) stop();
    stopTimeout();
    settings.dispose();
    unpersist();
    client.dispose();
  };
}
