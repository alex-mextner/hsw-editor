import type { ReactNode } from 'react';
import { useStore } from '@/state/react.ts';
import { layoutStore } from '@/state/layout.ts';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { cn } from '@/lib/cn.ts';
import { useT } from '@/i18n/index.ts';

interface ShellProps {
  readonly topBar: ReactNode;
  readonly left: ReactNode;
  readonly right: ReactNode;
  readonly bottom: ReactNode;
  readonly ompDock: ReactNode;
  readonly children: ReactNode;
}

/**
 * Editor frame: top bar, left palette, centre viewport, right inspector (+ omp dock), bottom timeline.
 * Below the `lg` breakpoint the side panels become overlay sheets over the viewport.
 */
export function Shell({ topBar, left, right, bottom, ompDock, children }: ShellProps) {
  const t = useT();
  const layout = useStore(layoutStore);
  const wide = useMediaQuery('(min-width: 1024px)');
  const closeSheets = () =>
    layoutStore.set({ ...layoutStore.get(), leftOpen: false, rightOpen: false });
  const sheetOpen = !wide && (layout.leftOpen || layout.rightOpen);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <header className="z-30 flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2">
        {topBar}
      </header>
      <div className="relative flex min-h-0 flex-1">
        <aside
          data-slot="palette"
          aria-label={t('panel.bank')}
          className={cn(
            'z-20 flex min-h-0 flex-col border-r border-border bg-panel',
            wide
              ? cn('w-80 shrink-0', !layout.leftOpen && 'hidden')
              : cn(
                  'absolute inset-y-0 left-0 w-[min(22rem,92vw)] shadow-2xl transition-transform',
                  layout.leftOpen ? 'translate-x-0' : '-translate-x-full',
                ),
          )}
        >
          {left}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <main data-slot="viewport" className="relative min-h-0 flex-1 bg-viewport">
            {children}
          </main>
          {layout.bottomOpen ? (
            <section
              data-slot="timeline"
              aria-label={t('panel.history')}
              className="h-36 shrink-0 border-t border-border bg-panel"
            >
              {bottom}
            </section>
          ) : null}
        </div>

        <div
          className={cn(
            'z-20 flex min-h-0 flex-col border-l border-border bg-panel',
            wide
              ? cn('w-80 shrink-0', !layout.rightOpen && !layout.ompOpen && 'hidden')
              : cn(
                  'absolute inset-y-0 right-0 w-[min(22rem,92vw)] shadow-2xl transition-transform',
                  layout.rightOpen || layout.ompOpen ? 'translate-x-0' : 'translate-x-full',
                ),
          )}
        >
          <aside
            data-slot="inspector"
            aria-label={t('panel.inspector')}
            className={cn(
              'min-h-0 flex-1 overflow-y-auto',
              layout.ompOpen && layout.rightOpen && 'max-h-[45%] border-b border-border',
              layout.ompOpen && !layout.rightOpen && 'hidden',
            )}
          >
            {right}
          </aside>
          {ompDock}
        </div>

        {sheetOpen ? (
          <button
            type="button"
            aria-label={t('action.closePanels')}
            className="absolute inset-0 z-10 bg-black/40"
            onClick={closeSheets}
          />
        ) : null}
      </div>
    </div>
  );
}
