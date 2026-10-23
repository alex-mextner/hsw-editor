import { memo } from 'react';
import { CheckIcon, RulerIcon } from 'lucide-react';
import type { Draft, DraftObject } from '@hsw-editor/tools/contract';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { toolRoutes, type ToolClassInfo } from '../api.ts';
import { percent, topClasses } from './wizardModel.ts';

interface ObjectCardProps {
  readonly draft: Draft;
  readonly object: DraftObject;
  readonly classes: readonly ToolClassInfo[];
  readonly focused: boolean;
  readonly checked: boolean;
  readonly onFocus: (key: string) => void;
  readonly onCheck: (key: string, checked: boolean) => void;
}

/** One detected object in the review grid: its crop, name, best class, status; a checkbox selects it for merge/group. */
export const ObjectCard = memo(function ObjectCard({
  draft,
  object,
  classes,
  focused,
  checked,
  onFocus,
  onCheck,
}: ObjectCardProps) {
  const { t, locale } = useI18n();
  const chosen = object.classId === null ? undefined : classes.find((cls) => cls.id === object.classId);
  const best = topClasses(object, 1)[0];
  const name = object.name[locale] ?? object.name.en ?? object.name.ru ?? chosen?.name[locale] ?? object.key;
  const crop = object.images.crop;
  return (
    <div
      data-testid="object-card"
      data-key={object.key}
      data-status={object.status}
      className={cn(
        'relative overflow-hidden rounded-lg border bg-card transition-colors',
        focused ? 'border-primary ring-2 ring-primary/40' : 'border-border hover:border-primary/60',
        object.status === 'discarded' && 'opacity-50',
      )}
    >
      <button
        type="button"
        onClick={() => onFocus(object.key)}
        aria-pressed={focused}
        aria-label={t('toolWizard.object.open', { name })}
        className="flex size-full flex-col text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <span className="relative block aspect-square w-full bg-muted/60">
          {crop === undefined ? null : (
            <img
              src={toolRoutes.draftFile(draft.id, crop)}
              alt=""
              loading="lazy"
              draggable={false}
              className="size-full object-contain p-1"
            />
          )}
          {object.status === 'added' ? (
            <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-ok/90 py-0.5 text-[10px] text-background">
              <CheckIcon className="size-3" aria-hidden />
              {t('toolWizard.object.added')}
            </span>
          ) : null}
        </span>
        <span className="flex flex-col gap-0.5 px-2 py-1.5">
          <span className="line-clamp-1 text-xs font-medium">{name}</span>
          <span className="line-clamp-1 text-[11px] text-muted-foreground">
            {chosen?.name[locale] ?? t('toolWizard.class.generic')}
            {best !== undefined && best.classId === object.classId ? ` · ${percent(best.score)}%` : ''}
          </span>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            {t(`toolWizard.status.${object.status}`)}
            {object.needsScale ? (
              <span className="inline-flex items-center gap-0.5 text-warn" title={t('toolWizard.object.needsScale')}>
                <RulerIcon className="size-3" aria-hidden />
                {t('toolWizard.object.noScale')}
              </span>
            ) : null}
          </span>
        </span>
      </button>
      {object.status === 'added' ? null : (
        <label className="absolute top-1 left-1 flex size-6 cursor-pointer items-center justify-center rounded bg-background/90 shadow-sm">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onCheck(object.key, event.target.checked)}
            aria-label={t('toolWizard.object.select', { name })}
            className="size-3.5"
          />
        </label>
      )}
    </div>
  );
});
