import { useEffect } from 'react';
import { startAiSession } from '@/commands/aiSession.ts';
import { startCommandCenter } from '@/commands/app.ts';
import { useGlobalKeys } from '@/commands/useGlobalKeys.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { CommandPalette } from '@/features/commandPalette/CommandPalette.tsx';
import { CheatSheet } from '@/features/keybindings/CheatSheet.tsx';
import { KeybindingEditor } from '@/features/keybindings/KeybindingEditor.tsx';
import { PendingChordHint } from '@/features/keybindings/PendingChordHint.tsx';
import { OfflineStorageDialog } from '@/features/offline/OfflineStorageDialog.tsx';
import { ConflictDialog } from '@/features/notices/ConflictDialog.tsx';
import { Toaster } from '@/features/notices/Toaster.tsx';
import { UpdateToast } from '@/features/notices/UpdateToast.tsx';
import { LeftPanel } from '@/features/palette/LeftPanel.tsx';
import { Inspector } from '@/features/inspector/Inspector.tsx';
import { Timeline } from '@/features/timeline/Timeline.tsx';
import { TopBar } from '@/features/topbar/TopBar.tsx';
import { ViewportArea } from '@/features/viewport/ViewportArea.tsx';
import { NewWallDialog } from '@/features/wizard/NewWallDialog.tsx';
import { OmpDock } from '@/shell/OmpDock.tsx';
import { Shell } from '@/shell/Shell.tsx';

export function App() {
  useGlobalKeys();
  useEffect(() => startCommandCenter(), []);
  useEffect(() => startAiSession(), []);
  return (
    <TooltipProvider delay={300}>
      <Shell
        topBar={<TopBar />}
        left={<LeftPanel />}
        right={<Inspector />}
        bottom={<Timeline />}
        ompDock={<OmpDock />}
      >
        <ViewportArea />
      </Shell>
      <CommandPalette />
      <KeybindingEditor />
      <CheatSheet />
      <PendingChordHint />
      <NewWallDialog />
      <Toaster />
      <UpdateToast />
      <ConflictDialog />
      <OfflineStorageDialog />
    </TooltipProvider>
  );
}
