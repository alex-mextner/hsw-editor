import { Gauge, RefreshCw } from 'lucide-react';
import type { Wall } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { physicsStore, reportOf } from '@/physics/store.ts';
import { useStore } from '@/state/react.ts';
import { checkPhysics } from './checkPhysics.ts';
import { PhysicsReportList } from './PhysicsReportList.tsx';
import { reportRows } from './reportRows.ts';

/** Wall-view section: run the physics check, the one-line verdict and the list of tools that need attention. */
export function PhysicsSection({ wall }: { readonly wall: Wall }) {
  const { t, tn } = useI18n();
  const view = useStore(physicsStore);
  const bank = useStore(bankStore);
  const report = reportOf(view);
  const rows = reportRows(report);
  const running = view.status === 'running';

  const status =
    view.status === 'error'
      ? t('physics.panel.error', { message: view.message })
      : running
        ? t('physics.panel.running')
        : report === null
          ? t('physics.panel.idle')
          : rows.length > 0
            ? tn('physics.panel.attention', rows.length)
            : report.tools.length === 0
              ? t('physics.panel.noTools')
              : t('physics.panel.allOk');

  return (
    <section className="grid gap-2" data-testid="physics-section">
      <div className="flex items-center gap-2">
        <h3 className="flex flex-1 items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <Gauge className="size-3.5" aria-hidden />
          {t('physics.panel.title')}
        </h3>
        <Button variant="outline" size="xs" disabled={running} onClick={() => void checkPhysics()}>
          <RefreshCw aria-hidden />
          {t(report === null ? 'physics.panel.checkFirst' : 'physics.panel.check')}
        </Button>
      </div>
      <p
        role={view.status === 'error' ? 'alert' : 'status'}
        className={
          view.status === 'error' || rows.length > 0
            ? 'text-xs text-amber-700 dark:text-amber-400'
            : 'text-xs text-muted-foreground'
        }
      >
        {status}
      </p>
      {rows.length > 0 ? (
        <PhysicsReportList
          wall={wall}
          bank={bank.status === 'ready' ? bank.byId : new Map()}
          rows={rows}
        />
      ) : null}
    </section>
  );
}
