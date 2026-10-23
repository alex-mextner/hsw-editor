import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import { cn } from '@/lib/cn.ts';
import { itemNamer } from '@/features/invalid-zones/itemNames.ts';
import { useI18n } from '@/i18n/index.ts';
import { physicsHoverStore } from '@/scene/physics/hover.ts';
import { setSelection } from '@/state/editor.ts';
import { describeProblem } from './describeProblem.ts';
import type { ReportRow } from './reportRows.ts';

interface PhysicsReportListProps {
  readonly wall: Wall;
  readonly bank: ReadonlyMap<string, BankElement>;
  readonly rows: readonly ReportRow[];
}

/**
 * One row per tool with physics problems (worst first): name, holder, amber dot, the sentences and the rating.
 * Clicking selects the tool (the inspector follows); hovering or focusing a row pulses the tool's amber marks in
 * the viewport.
 */
export function PhysicsReportList({ wall, bank, rows }: PhysicsReportListProps) {
  const { t, locale } = useI18n();
  const nameOf = itemNamer(wall, bank, locale);
  return (
    <ul className="grid gap-1" data-testid="physics-report">
      {rows.map(({ physics, severity }) => (
        <li key={physics.toolId}>
          <button
            type="button"
            data-testid="physics-row"
            data-tool={physics.toolId}
            className="grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:bg-muted"
            onClick={() => setSelection([physics.toolId])}
            onPointerEnter={() => physicsHoverStore.set(physics.toolId)}
            onPointerLeave={() => physicsHoverStore.set(null)}
            onFocus={() => physicsHoverStore.set(physics.toolId)}
            onBlur={() => physicsHoverStore.set(null)}
          >
            <span className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  severity === 'error' ? 'bg-amber-500' : 'border border-amber-500 bg-transparent',
                )}
              />
              <span className="sr-only">
                {t(severity === 'error' ? 'physics.panel.errorDot' : 'physics.panel.warningDot')}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{nameOf(physics.toolId)}</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {t('physics.panel.rating', { percent: Math.round(physics.rating * 100) })}
              </span>
            </span>
            <span className="truncate text-muted-foreground">
              {t('physics.panel.on', { holder: nameOf(physics.holderId) })}
            </span>
            <ul className="grid gap-0.5 text-amber-700 dark:text-amber-400">
              {physics.problems.map((problem, index) => (
                <li key={`${problem.code}:${index}`}>{describeProblem(problem, t, nameOf)}</li>
              ))}
            </ul>
          </button>
        </li>
      ))}
    </ul>
  );
}
