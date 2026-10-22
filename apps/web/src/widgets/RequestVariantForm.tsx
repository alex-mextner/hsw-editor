import { useState } from 'react';
import type { JsonValue } from '@hsw-editor/core';
import type { RequestOfKind, VariantCandidate } from '@/api/requests.ts';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { ScoreBar } from './ScoreBar.tsx';

interface RequestVariantFormProps {
  readonly request: RequestOfKind<'variant'>;
  readonly onAnswer: (answer: JsonValue) => void;
}

/** Candidate variants as a grid of buttons: picking one switches the item to it right away. */
export function RequestVariantForm({ request, onAnswer }: RequestVariantFormProps) {
  const t = useT();
  const wall = useStore(sessionStore)?.wall ?? null;
  const item = wall?.items.find((entry) => entry.id === request.itemId);
  const [error, setError] = useState<string | null>(null);
  const { candidates } = request.payload;

  if (!item) return <p className="text-sm text-muted-foreground">{t('request.itemGone')}</p>;
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('request.variant.empty')}</p>;
  }

  function pick(candidate: VariantCandidate): void {
    if (!item) return;
    const result = submitOps(
      [
        {
          type: 'setVariant',
          id: item.id,
          variantId: candidate.id,
          ...(candidate.bankId === undefined ? {} : { bankId: candidate.bankId }),
        },
      ],
      'variant-request',
    );
    if (result.ok) onAnswer({ chosen: candidate.id });
    else setError(result.error.message);
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {candidates.map((candidate) => {
          const current = item.variantId === candidate.id;
          return (
            <li key={candidate.id}>
              <button
                type="button"
                aria-pressed={current}
                onClick={() => pick(candidate)}
                className={cn(
                  'flex h-full w-full flex-col gap-1.5 rounded-lg border bg-card p-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50',
                  current ? 'border-primary' : 'border-border',
                )}
              >
                <span className="truncate font-medium" title={candidate.label}>
                  {candidate.label}
                </span>
                {candidate.score === undefined ? null : (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ScoreBar score={candidate.score} />
                    <span className="tabular-nums">{Math.round(candidate.score * 100)}%</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t('request.error.apply', { message: error })}
        </p>
      ) : null}
    </div>
  );
}
