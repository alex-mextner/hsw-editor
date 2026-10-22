import { createValueStore } from '#state-backend';
import type { MessageKey } from '@/i18n/index.ts';

export type CommandGroup = 'edit' | 'view' | 'wall' | 'tools' | 'app';

export interface Command {
  readonly id: string;
  readonly label: MessageKey;
  readonly group: CommandGroup;
  /** Display string, e.g. `Ctrl+Z`. The matching is described by `keys`. */
  readonly shortcut?: string;
  /** Key combos that trigger the command: `mod+z`, `shift+mod+z`, `delete`, `r`. */
  readonly keys?: readonly string[];
  readonly enabled?: () => boolean;
  readonly run: () => void;
}

/** Commands registered by feature modules; palette and keyboard handler read from here. */
export const commandsStore = createValueStore<readonly Command[]>([]);

export function registerCommands(commands: readonly Command[]): () => void {
  commandsStore.set([...commandsStore.get(), ...commands]);
  const ids = new Set(commands.map((command) => command.id));
  return () => commandsStore.set(commandsStore.get().filter((command) => !ids.has(command.id)));
}

export const paletteOpenStore = createValueStore<boolean>(false);

/** Layout-independent key name: physical letter/digit keys work on the Russian layout too. */
function keyName(event: KeyboardEvent): string {
  if (event.code.startsWith('Key')) return event.code.slice(3).toLowerCase();
  if (event.code.startsWith('Digit')) return event.code.slice(5);
  return event.key.toLowerCase();
}

/** Normalises a keyboard event to the combo syntax used in `Command.keys`. */
export function comboOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  parts.push(keyName(event));
  return parts.join('+');
}

/** Typing in a field must not trigger single-key shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}
