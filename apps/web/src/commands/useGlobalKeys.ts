import { useEffect } from 'react';
import { dispatchKey } from './app.ts';
import { isTypingTarget } from './typing.ts';

/**
 * The editor's single keyboard listener. Bubble phase: a widget that handled the key (a menu, the
 * bank's own Escape) has already had its say, and the keybinding recorder can still intercept
 * keys in the capture phase before they reach the keymap. Text fields and IME composition are
 * the dispatcher's business, it is only told whether a field has focus.
 */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const outcome = dispatchKey(event, isTypingTarget(event.target));
      if (!outcome.consumed) return;
      event.preventDefault();
      event.stopPropagation();
    };
    globalThis.addEventListener('keydown', onKeyDown);
    return () => globalThis.removeEventListener('keydown', onKeyDown);
  }, []);
}
