/** The app's one AI conversation: the session core wired to the registry, settings and bridge. */
import { createValueStore } from '#state-backend';
import { type AiBridgeStatus, executeAppCommand } from '@hsw-editor/commands';
import { localeStore } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import type { ValueStore } from '@/state/types.ts';
import { aiBridgeStore } from './aiBridge.ts';
import { AiSession } from './aiSessionCore.ts';
import { commandRegistry, getBaseContext, keymapStore, settingsStore } from './app.ts';

export const aiSession = new AiSession({
  bridge: () => aiBridgeStore.get(),
  approvalMode: () => (settingsStore.get('ai.approval') === false ? 'auto' : 'approve'),
  locale: () => localeStore.get(),
  executeAppCommand: (gate, request, signal) =>
    executeAppCommand(
      {
        registry: commandRegistry,
        // The AI works while the palette is open; it must see the editor, not the dialog.
        getContext: getBaseContext,
        getKeymap: () => keymapStore.get().keymap,
        gate,
        locale: () => localeStore.get(),
      },
      request,
      signal,
    ),
});

const statusStore: ValueStore<AiBridgeStatus> = createValueStore<AiBridgeStatus>(
  aiBridgeStore.get().status(),
);

export function useAiStatus(): AiBridgeStatus {
  return useStore(statusStore);
}

/** Registers `app_command` with the current bridge and follows bridge swaps and status changes. */
export function startAiSession(): () => void {
  let stopStatus = (): void => undefined;
  const follow = (): void => {
    stopStatus();
    const bridge = aiBridgeStore.get();
    statusStore.set(bridge.status());
    stopStatus = bridge.onStatus((status) => statusStore.set(status));
    aiSession.attach();
  };
  follow();
  const stopBridge = aiBridgeStore.subscribe(follow);
  return () => {
    stopBridge();
    stopStatus();
    aiSession.dispose();
  };
}
