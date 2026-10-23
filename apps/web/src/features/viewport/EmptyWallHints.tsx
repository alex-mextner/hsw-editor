import { ImagePlus, LayoutGrid, Wrench } from 'lucide-react';
import { bankStore } from '@/bank/client.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { choosePhotoFile } from '@/features/photo/photoImport.ts';
import { useI18n } from '@/i18n/index.ts';
import { layoutStore } from '@/state/layout.ts';
import { useStore } from '@/state/react.ts';
import { addToolPreset } from '@/wall/actions.ts';

/** Empty-wall guidance: the three ways to start (pick from the bank, add a tool preset, import a photo). */
export function EmptyWallHints() {
  const { t, locale } = useI18n();
  const bank = useStore(bankStore);
  const toolClasses = bank.status === 'ready' ? bank.index.toolClasses : [];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-12 z-10 flex justify-center px-4">
      <div className="pointer-events-auto grid w-full max-w-xl gap-3 rounded-2xl border border-border bg-panel/95 p-4 shadow-lg backdrop-blur">
        <div>
          <h2 className="text-sm font-semibold">{t('empty.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('empty.subtitle')}</p>
        </div>
        <ol className="grid gap-2 text-xs sm:grid-cols-3">
          <li className="grid gap-1.5 rounded-lg border border-border bg-card p-2.5">
            <LayoutGrid className="size-4 text-primary" aria-hidden />
            <span className="font-medium">{t('empty.bankStep')}</span>
            <span className="text-muted-foreground">{t('empty.bankHint')}</span>
            <Button
              size="xs"
              variant="outline"
              onClick={() => layoutStore.set({ ...layoutStore.get(), leftOpen: true })}
            >
              {t('empty.openBank')}
            </Button>
          </li>
          <li className="grid gap-1.5 rounded-lg border border-border bg-card p-2.5">
            <Wrench className="size-4 text-primary" aria-hidden />
            <span className="font-medium">{t('empty.toolStep')}</span>
            <span className="text-muted-foreground">{t('empty.toolHint')}</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button size="xs" variant="outline" disabled={toolClasses.length === 0} />}
              >
                {t('empty.addTool')}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-72 w-56">
                {toolClasses.map((toolClass) => (
                  <DropdownMenuItem
                    key={toolClass.id}
                    onClick={() => addToolPreset(toolClass, toolClass.name[locale])}
                  >
                    {toolClass.name[locale]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
          <li className="grid gap-1.5 rounded-lg border border-border bg-card p-2.5">
            <ImagePlus className="size-4 text-primary" aria-hidden />
            <span className="font-medium">{t('empty.photoStep')}</span>
            <span className="text-muted-foreground">{t('empty.photoHint')}</span>
            <Button size="xs" variant="outline" onClick={choosePhotoFile}>
              {t('empty.choosePhoto')}
            </Button>
          </li>
        </ol>
      </div>
    </div>
  );
}
