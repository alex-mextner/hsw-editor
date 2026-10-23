import type { DraftObject } from '@hsw-editor/tools/contract';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { toolRoutes, type ToolClassInfo } from '../api.ts';
import { ToolThumb } from '../ToolThumb.tsx';
import { percent } from './wizardModel.ts';

interface CandidateCompareProps {
  readonly object: DraftObject;
  readonly classes: readonly ToolClassInfo[];
  readonly disabled: boolean;
  readonly onPick: (classId: string) => void;
}

/**
 * The built-in classes the fit tried for this object, side by side: how well each model's width profile matches the
 * photo silhouette (IoU) and how likely the recogniser thought it was. Picking one refits the object with it.
 */
export function CandidateCompare({ object, classes, disabled, onPick }: CandidateCompareProps) {
  const { t, locale } = useI18n();
  const alternatives = object.fit?.alternatives ?? [];
  if (alternatives.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('toolWizard.compare.none')}</p>;
  }
  const ranked = [...alternatives].sort((a, b) => b.iou - a.iou);
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3" data-testid="wizard-compare">
      {ranked.map((candidate) => {
        const info = classes.find((cls) => cls.id === candidate.classId);
        const current = candidate.classId === object.classId;
        const name = info?.name[locale] ?? candidate.classId;
        return (
          <li key={candidate.classId}>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={current}
              aria-label={t('toolWizard.compare.use', { name })}
              onClick={() => onPick(candidate.classId)}
              className={cn(
                'grid w-full gap-1 rounded-lg border bg-card p-1.5 text-left text-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60',
                current ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-muted',
              )}
            >
              <span className="relative block aspect-4/3 overflow-hidden rounded-md">
                <ToolThumb id={`class:${candidate.classId}`} url={toolRoutes.classThumb(candidate.classId)} />
              </span>
              <span className="line-clamp-1 font-medium">{name}</span>
              <span aria-hidden className="block h-1 overflow-hidden rounded-full bg-muted">
                <span className="block h-full bg-primary" style={{ width: `${percent(candidate.iou)}%` }} />
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">
                {t('toolWizard.compare.iou', { iou: percent(candidate.iou) })}
                {' · '}
                {t('toolWizard.compare.recognised', { score: percent(candidate.score) })}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
