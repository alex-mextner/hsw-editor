import { useEffect } from 'react';
import { BankPanel } from '@/features/bank/BankPanel.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { leftTabStore, type LeftTab } from './leftTab.ts';
import { ToolsTab } from '@/features/tools/ToolsTab.tsx';
import { startToolSelectionSync } from '@/features/bank/toolFilterStore.ts';

/** Left panel: the element bank and the tool library. */
export function LeftPanel() {
  const { t } = useI18n();
  const tab = useStore(leftTabStore);
  // The selection feeds the bank filter whichever tab is open.
  useEffect(() => startToolSelectionSync(), []);
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        if (next === 'bank' || next === 'tools') leftTabStore.set(next satisfies LeftTab);
      }}
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <TabsList className="m-2 mb-0 shrink-0">
        <TabsTrigger value="bank">{t('panel.bank')}</TabsTrigger>
        <TabsTrigger value="tools">{t('panel.tools')}</TabsTrigger>
      </TabsList>
      <TabsContent value="bank" className="min-h-0 flex-1">
        <BankPanel />
      </TabsContent>
      <TabsContent value="tools" className="min-h-0 flex-1">
        <ToolsTab />
      </TabsContent>
    </Tabs>
  );
}
