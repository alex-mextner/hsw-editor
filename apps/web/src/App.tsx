import { useEffect } from 'react';
import { CommandPalette } from '@/commands/CommandPalette.tsx';
import { registerEditorCommands } from '@/commands/editorCommands.ts';
import { useShortcuts } from '@/commands/useShortcuts.ts';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { ConflictDialog } from '@/features/notices/ConflictDialog.tsx';
import { UpdateToast } from '@/features/notices/UpdateToast.tsx';
import { Toaster } from '@/features/notices/Toaster.tsx';
import { LeftPanel } from '@/features/palette/LeftPanel.tsx';
import { Inspector } from '@/features/inspector/Inspector.tsx';
import { Timeline } from '@/features/timeline/Timeline.tsx';
import { TopBar } from '@/features/topbar/TopBar.tsx';
import { ViewportArea } from '@/features/viewport/ViewportArea.tsx';
import { NewWallDialog } from '@/features/wizard/NewWallDialog.tsx';
import { OmpDock } from '@/shell/OmpDock.tsx';
import { Shell } from '@/shell/Shell.tsx';

export function App() {
  useShortcuts();
  useEffect(() => registerEditorCommands(), []);
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
      <NewWallDialog />
      <Toaster />
      <UpdateToast />
      <ConflictDialog />
    </TooltipProvider>
  );
}
