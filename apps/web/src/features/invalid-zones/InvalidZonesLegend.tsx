import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { legendState } from '@/scene/invalid-zones/reasons.ts';
import { invalidZonesEnabledStore, invalidZonesResultStore } from '@/scene/invalid-zones/store.ts';

/**
 * Same stripe geometry as the material (`scene/invalid-zones/stripeMaterial.ts`, keep the colours in sync): 45 degrees,
 * ~6 px period. Red over neutral by default; white over a dark gap on red for invalid parts on red material, where red
 * stripes would vanish.
 */
const SWATCHES = [
  {
    id: 'red',
    background: 'repeating-linear-gradient(135deg, #ff3b3b 0 3px, rgba(255,255,255,0.55) 3px 6px)',
  },
  {
    id: 'white',
    background:
      'repeating-linear-gradient(135deg, #ffffff 0 3px, rgba(20,20,26,0.35) 3px 6px), linear-gradient(#d00f1a, #d00f1a)',
  },
] as const;

/** Viewport legend: what the stripes mean and how many items carry invalid parts right now. */
export function InvalidZonesLegend() {
  const { t, tn } = useI18n();
  const enabled = useStore(invalidZonesEnabledStore);
  const result = useStore(invalidZonesResultStore);
  if (!enabled || !result) return null;
  const state = legendState(result);
  return (
    <output
      className="pointer-events-none absolute bottom-10 left-2 z-10 flex items-center gap-1.5 rounded-md border border-border bg-panel/90 px-2 py-1 text-[11px] backdrop-blur"
      data-testid="invalid-legend"
    >
      <span aria-hidden className="flex shrink-0 gap-0.5" title={t('invalid.legend.swatch')}>
        {SWATCHES.map((swatch) => (
          <span
            key={swatch.id}
            className="size-3.5 rounded-sm border border-red-500/70"
            style={{ backgroundImage: swatch.background }}
            data-testid={`invalid-swatch-${swatch.id}`}
          />
        ))}
      </span>
      <span className={state.kind === 'count' ? 'text-foreground' : 'text-muted-foreground'}>
        {state.kind === 'count'
          ? tn('invalid.legend.count', state.items)
          : t(state.kind === 'checking' ? 'invalid.legend.checking' : 'invalid.legend.none')}
      </span>
    </output>
  );
}
