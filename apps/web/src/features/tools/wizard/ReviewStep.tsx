import { useMemo, useState } from 'react';
import { CheckCheckIcon, CombineIcon, Layers2Icon, Loader2Icon, SaveIcon } from 'lucide-react';
import type { Draft } from '@hsw-editor/tools/contract';
import { Button } from '@/components/ui/button.tsx';
import { TagInput } from '@/features/bank/user/TagInput.tsx';
import { useI18n } from '@/i18n/index.ts';
import type { ToolClassInfo } from '../api.ts';
import { ObjectCard } from './ObjectCard.tsx';
import { ObjectEditor } from './ObjectEditor.tsx';
import { useDraftEdits } from './useDraftEdits.ts';
import { canGroup, canMerge, committable, reviewable } from './wizardModel.ts';

interface ReviewStepProps {
  readonly draft: Draft;
  readonly classes: readonly ToolClassInfo[];
  readonly onDraft: (draft: Draft) => void;
  readonly tags: readonly string[];
  readonly onTags: (tags: readonly string[]) => void;
  readonly saving: boolean;
  readonly saveError: string | null;
  readonly onSave: () => void;
  readonly onBack: () => void;
}

/**
 * Step 2: the review grid of detected objects with merge / group, the editor of the focused object, tags and the
 * save-to-library button. Nothing reaches the library until the user saves.
 */
export function ReviewStep({
  draft,
  classes,
  onDraft,
  tags,
  onTags,
  saving,
  saveError,
  onSave,
  onBack,
}: ReviewStepProps) {
  const { t, tn } = useI18n();
  const edits = useDraftEdits(draft, onDraft);
  const objects = useMemo(() => reviewable(draft), [draft]);
  const [focusKey, setFocusKey] = useState<string | null>(objects[0]?.key ?? null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  // Merge and split replace objects: keys that no longer exist are ignored.
  const checked = useMemo(
    () => picked.filter((key) => draft.objects.some((object) => object.key === key)),
    [picked, draft],
  );
  const focus = objects.find((object) => object.key === focusKey) ?? objects[0];
  const ready = committable(draft);
  const pendingKeys = objects
    .filter((object) => object.status === 'pending' && !object.needsScale)
    .map((object) => object.key);

  const check = (key: string, on: boolean): void =>
    setPicked(on ? [...checked, key] : checked.filter((entry) => entry !== key));

  if (objects.length === 0) {
    return (
      <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-testid="wizard-no-objects">
        <p className="text-sm font-medium">{t('toolWizard.review.none')}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{t('toolWizard.review.noneHint')}</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          {t('toolWizard.back')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="wizard-review">
      <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] md:p-4">
        <section aria-label={t('toolWizard.review.grid')} className="grid content-start gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="mr-auto text-xs text-muted-foreground">
              {tn('toolWizard.review.found', objects.length)}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={edits.busy || pendingKeys.length === 0}
              data-testid="wizard-accept-all"
              onClick={() => void edits.acceptAll(pendingKeys)}
            >
              <CheckCheckIcon aria-hidden />
              {t('toolWizard.review.acceptAll')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={edits.busy || !canMerge(draft, checked)}
              title={t('toolWizard.review.mergeHint')}
              data-testid="wizard-merge"
              onClick={() => void edits.merge(checked)}
            >
              <CombineIcon aria-hidden />
              {t('toolWizard.review.merge')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={edits.busy || !canGroup(draft, checked)}
              title={t('toolWizard.review.groupHint')}
              data-testid="wizard-group"
              onClick={() => void edits.group(checked)}
            >
              <Layers2Icon aria-hidden />
              {t('toolWizard.review.group')}
            </Button>
          </div>
          <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3" data-testid="wizard-grid">
            {objects.map((object) => (
              <li key={object.key}>
                <ObjectCard
                  draft={draft}
                  object={object}
                  classes={classes}
                  focused={focus?.key === object.key}
                  checked={checked.includes(object.key)}
                  onFocus={setFocusKey}
                  onCheck={check}
                />
              </li>
            ))}
          </ul>
          {edits.error === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              {edits.error}
            </p>
          )}
        </section>
        {focus === undefined ? null : (
          <aside aria-label={t('toolWizard.editor.title')} className="min-w-0 md:sticky md:top-0 md:self-start">
            <ObjectEditor key={focus.key} draft={draft} object={focus} classes={classes} edits={edits} />
          </aside>
        )}
      </div>
      <footer className="flex flex-wrap items-end gap-3 border-t border-border bg-background p-3 md:px-4">
        <div className="grid min-w-48 flex-1 gap-1">
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t('toolDetail.tags')}
          </span>
          <TagInput tags={tags} onChange={onTags} label={t('toolDetail.tags')} testId="wizard-tags" disabled={saving} />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack} disabled={saving}>
            {t('toolWizard.back')}
          </Button>
          <Button onClick={onSave} disabled={saving || ready.length === 0} data-testid="wizard-save">
            {saving ? <Loader2Icon className="animate-spin" aria-hidden /> : <SaveIcon aria-hidden />}
            {tn('toolWizard.save', ready.length)}
          </Button>
        </div>
        {saveError === null ? null : (
          <p role="alert" className="w-full text-xs text-destructive">
            {saveError}
          </p>
        )}
      </footer>
    </div>
  );
}
