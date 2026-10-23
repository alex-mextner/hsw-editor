import { Fact, Facts, Section } from '@/features/bank/DetailSections.tsx';
import { useI18n } from '@/i18n/index.ts';
import { HoldingDiagram } from './HoldingDiagram.tsx';
import type { Loadable } from './hooks.ts';
import type { HoldingResponse } from './api.ts';

/** Millimetres with at most one decimal: measured values carry float noise. */
function mm(value: number): string {
  return `${Number(value.toFixed(1))} mm`;
}

/** Humanised measured dimension name: `shaftDiameter` -> "shaft diameter". */
function dimLabel(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** The holding interface of the tool: diagram plus the measured dimensions a holder is matched against. */
export function HoldingSection({ holding }: { readonly holding: Loadable<HoldingResponse> }) {
  const t = useI18n().t;
  return (
    <Section title={t('toolDetail.holding')}>
      {holding.status === 'loading' ? (
        <div className="h-32 animate-pulse rounded-md bg-muted" aria-label={t('toolDetail.holding.loading')} />
      ) : holding.status === 'error' ? (
        <p role="alert" className="text-xs text-destructive">
          {t('toolDetail.holding.error', { message: holding.message })}
        </p>
      ) : (
        <>
          <HoldingDiagram holding={holding.value.holding} />
          <Facts>
            <Fact label={t('toolDetail.holding.length')}>
              <span className="tabular-nums">{mm(holding.value.holding.lengthMm)}</span>
            </Fact>
            <Fact label={t('toolDetail.holding.maxSection')}>
              <span className="tabular-nums">
                {Number(holding.value.holding.maxSection.w.toFixed(1))} × {mm(holding.value.holding.maxSection.t)}
              </span>
            </Fact>
            {Object.entries(holding.value.holding.dims).map(([key, value]) => (
              <Fact key={key} label={dimLabel(key)}>
                <span className="tabular-nums" data-testid={`holding-dim-${key}`}>
                  {mm(value)}
                </span>
              </Fact>
            ))}
            {holding.value.bankClass === null ? null : (
              <Fact label={t('toolDetail.holding.bankClass')}>{holding.value.bankClass}</Fact>
            )}
          </Facts>
        </>
      )}
    </Section>
  );
}
