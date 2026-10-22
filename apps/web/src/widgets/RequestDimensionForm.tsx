import { useState } from 'react';
import type { JsonValue } from '@hsw-editor/core';
import type { RequestOfKind } from '@/api/requests.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { useT } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { formatDimension, initialText, parseDimensionInput } from './requestsDimension.ts';

interface RequestDimensionFormProps {
  readonly request: RequestOfKind<'dimension'>;
  readonly onAnswer: (answer: JsonValue) => void;
}

/** Number fields for the dimensions an agent could not settle; Apply writes them as item params. */
export function RequestDimensionForm({ request, onAnswer }: RequestDimensionFormProps) {
  const t = useT();
  const wall = useStore(sessionStore)?.wall ?? null;
  const item = wall?.items.find((entry) => entry.id === request.itemId);
  const { fields } = request.payload;
  const [texts, setTexts] = useState<ReadonlyMap<string, string>>(
    () => new Map(fields.map((field) => [field.key, initialText(field, item?.params[field.key])])),
  );
  const [error, setError] = useState<string | null>(null);
  const { values, errors } = parseDimensionInput(fields, texts);
  const canApply = item !== undefined && errors.size === 0 && Object.keys(values).length > 0;

  if (!item) {
    return <p className="text-sm text-muted-foreground">{t('request.itemGone')}</p>;
  }

  function apply(): void {
    if (!item) return;
    const result = submitOps(
      [{ type: 'setParams', id: item.id, set: values }],
      'dimension-request',
    );
    if (result.ok) onAnswer({ values });
    else setError(result.error.message);
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canApply) apply();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const id = `${request.id}-${field.key}`;
          const problem = errors.get(field.key);
          const current = item.params[field.key];
          const { fitted, suggested } = field;
          const limits =
            field.min !== undefined && field.max !== undefined
              ? t('request.dimension.range', {
                  min: formatDimension(field.min),
                  max: formatDimension(field.max),
                })
              : null;
          return (
            <div key={field.key} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{field.label ?? field.key}</Label>
              <div className="relative">
                <Input
                  id={id}
                  inputMode="decimal"
                  value={texts.get(field.key) ?? ''}
                  aria-invalid={problem !== undefined}
                  aria-describedby={`${id}-hint`}
                  className="pr-9"
                  onChange={(event) => setTexts(new Map(texts).set(field.key, event.target.value))}
                />
                <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
                  {t('request.unit')}
                </span>
              </div>
              <p id={`${id}-hint`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                {problem ? (
                  <span className="text-destructive">
                    {t(`request.dimension.error.${problem}`)}
                  </span>
                ) : (
                  <>
                    {current === undefined ? null : (
                      <span className="text-muted-foreground">
                        {t('request.dimension.current', { value: formatDimension(current) })}
                      </span>
                    )}
                    {limits ? <span className="text-muted-foreground">{limits}</span> : null}
                  </>
                )}
                {fitted === undefined ? null : (
                  <HintButton
                    label={t('request.dimension.fitted', { value: formatDimension(fitted) })}
                    onPick={() => setTexts(new Map(texts).set(field.key, formatDimension(fitted)))}
                  />
                )}
                {suggested === undefined ? null : (
                  <HintButton
                    label={t('request.dimension.suggested', {
                      value: formatDimension(suggested),
                    })}
                    onPick={() =>
                      setTexts(new Map(texts).set(field.key, formatDimension(suggested)))
                    }
                  />
                )}
              </p>
            </div>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t('request.error.apply', { message: error })}
        </p>
      ) : null}
      <div>
        <Button type="submit" disabled={!canApply}>
          {t('request.apply')}
        </Button>
      </div>
    </form>
  );
}

function HintButton({ label, onPick }: { readonly label: string; readonly onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="rounded-full border border-border px-2 py-0.5 text-primary outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {label}
    </button>
  );
}
