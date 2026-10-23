import { useEffect } from 'react';
import { Wrench } from 'lucide-react';
import { bankStore } from '@/bank/client.ts';
import { BankPanel } from '@/features/bank/BankPanel.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { presetDims } from '@/wall/toolPresets.ts';
import { addToolPreset } from '@/wall/actions.ts';
import { startToolSelectionSync } from '@/features/bank/toolFilterStore.ts';

/** Left panel: the element bank and the tool presets used to start a wall from scratch. */
export function LeftPanel() {
  const { t } = useI18n();
  // The selection feeds the bank filter whichever tab is open.
  useEffect(() => startToolSelectionSync(), []);
  return (
    <Tabs defaultValue="bank" className="flex min-h-0 flex-1 flex-col gap-0">
      <TabsList className="m-2 mb-0 shrink-0">
        <TabsTrigger value="bank">{t('panel.bank')}</TabsTrigger>
        <TabsTrigger value="tools">{t('panel.tools')}</TabsTrigger>
      </TabsList>
      <TabsContent value="bank" className="min-h-0 flex-1">
        <BankPanel />
      </TabsContent>
      <TabsContent value="tools" className="min-h-0 flex-1 overflow-y-auto">
        <ToolPresets />
      </TabsContent>
    </Tabs>
  );
}

function ToolPresets() {
  const { t, locale } = useI18n();
  const bank = useStore(bankStore);
  if (bank.status !== 'ready') {
    return <p className="p-4 text-sm text-muted-foreground">{t('tools.waitBank')}</p>;
  }
  return (
    <div className="grid gap-2 p-2">
      <p className="px-1 text-xs text-muted-foreground">{t('tools.hint')}</p>
      <ul className="grid gap-1.5">
        {bank.index.toolClasses.map((toolClass) => {
          const dims = presetDims(toolClass.id);
          return (
            <li key={toolClass.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-left text-sm transition-colors hover:border-primary/60 hover:bg-muted"
                onClick={() => addToolPreset(toolClass, toolClass.name[locale])}
              >
                <Wrench className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {toolClass.name[locale]}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {dims.x}×{dims.y}×{dims.z}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
