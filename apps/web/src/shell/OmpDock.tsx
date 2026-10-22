import type { ReactNode } from 'react';
import { Bot, X } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { useT } from '@/i18n/index.ts';
import { layoutStore } from '@/state/layout.ts';
import { useStore } from '@/state/react.ts';
import { cn } from '@/lib/cn.ts';

/**
 * Collapsible dock for the embedded omp panel. The container stays mounted while collapsed (hidden,
 * not removed) so an agent session keeps streaming; `data-slot="omp-dock"` is the stable mount point.
 */
export function OmpDock({ children }: { readonly children?: ReactNode }) {
  const t = useT();
  const open = useStore(layoutStore).ompOpen;
  return (
    <aside
      data-slot="omp-dock"
      aria-label={t('panel.omp')}
      className={cn('flex min-h-0 flex-1 flex-col', !open && 'hidden')}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium">
        <Bot className="size-3.5 text-primary" aria-hidden />
        <span className="flex-1">{t('panel.omp')}</span>
        <IconButton
          label={t('action.close')}
          size="icon-xs"
          onClick={() => layoutStore.set({ ...layoutStore.get(), ompOpen: false })}
        >
          <X />
        </IconButton>
      </div>
      <div data-slot="omp-dock-body" className="min-h-0 flex-1 overflow-hidden">
        {children ?? <p className="p-4 text-xs text-muted-foreground">{t('omp.unavailable')}</p>}
      </div>
    </aside>
  );
}
