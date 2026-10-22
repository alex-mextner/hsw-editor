import { useEffect } from 'react';
import { comboOf, commandsStore, isTypingTarget, paletteOpenStore } from './registry.ts';

/** Global keyboard handler: dispatches registered commands and opens the palette on Ctrl/Cmd+K. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const combo = comboOf(event);
      if (combo === 'mod+k') {
        event.preventDefault();
        paletteOpenStore.set(!paletteOpenStore.get());
        return;
      }
      // A focused widget (grid, tabs, menu, dialog) that already handled the key owns it.
      if (event.defaultPrevented || isTypingTarget(event.target) || event.repeat) return;
      for (const command of commandsStore.get()) {
        if (!command.keys?.includes(combo)) continue;
        if (command.enabled && !command.enabled()) continue;
        event.preventDefault();
        command.run();
        return;
      }
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, []);
}
