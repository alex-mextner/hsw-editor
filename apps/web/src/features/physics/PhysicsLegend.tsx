import { useI18n } from '@/i18n/index.ts';
import { physicsEnabledStore } from '@/physics/live.ts';
import { physicsStore, reportOf } from '@/physics/store.ts';
import { useStore } from '@/state/react.ts';
import { reportRows } from './reportRows.ts';

/** Same stripe geometry as the amber material: the opposite diagonal of the red legend, amber over dark. */
const STRIPES = 'repeating-linear-gradient(45deg, #f5a524 0 4px, rgba(27,27,34,0.85) 4px 8px)';

/** Viewport legend stacked above the invalid-zones one: what the amber marks mean and how many tools carry them. */
export function PhysicsLegend() {
  const { t, tn } = useI18n();
  const enabled = useStore(physicsEnabledStore);
  const view = useStore(physicsStore);
  if (!enabled || view.status === 'idle' || view.status === 'error') return null;
  const report = reportOf(view);
  const count = reportRows(report).length;
  const checking = view.status === 'running' && report === null;
  return (
    <output
      className="pointer-events-none absolute bottom-[4.25rem] left-2 z-10 flex items-center gap-1.5 rounded-md border border-border bg-panel/90 px-2 py-1 text-[11px] backdrop-blur"
      data-testid="physics-legend"
    >
      <span
        aria-hidden
        className="size-3.5 shrink-0 rounded-sm border border-amber-500/70"
        style={{ backgroundImage: STRIPES }}
        title={t('physics.legend.swatch')}
      />
      <span className={count > 0 ? 'text-foreground' : 'text-muted-foreground'}>
        {checking
          ? t('physics.legend.checking')
          : count > 0
            ? tn('physics.legend.count', count)
            : t('physics.legend.ok')}
      </span>
    </output>
  );
}
