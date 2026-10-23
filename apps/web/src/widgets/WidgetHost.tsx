import { useEffect, useRef, useState } from 'react';
import type { JsonValue } from '@hsw-editor/core';
import { ApiError, NetworkError } from '@/api/http.ts';
import type { InputRequest } from '@/api/requests.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { patchEditor } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import { CalibrationWizard } from './CalibrationWizard.tsx';
import { CompareWidget } from './CompareWidget.tsx';
import { RequestDimensionForm } from './RequestDimensionForm.tsx';
import { RequestVariantForm } from './RequestVariantForm.tsx';
import { activeRequest, answerOpenRequest, dismissOpenRequest, useRequests } from './requests.ts';

/** Wide widgets (3D tiles, photo viewer) get a wide card; the forms stay compact. */
const WIDE_KINDS: ReadonlySet<InputRequest['kind']> = new Set<InputRequest['kind']>([
  'compare',
  'calibration',
]);

/**
 * Contextual card for the oldest open input request of the open wall. A DOM overlay mounted next to
 * the canvas: anchored bottom-centre so the viewport stays usable around it.
 */
export function WidgetHost() {
  const requests = useRequests();
  const session = useStore(sessionStore);
  const active =
    session?.status === 'ready' && requests.wallId === session.wallId
      ? activeRequest(requests)
      : undefined;
  const itemId = active?.itemId;

  // The scene highlights the item a widget is about while its card is open.
  useEffect(() => {
    if (itemId === undefined) return;
    patchEditor({ widgetItemId: itemId });
    return () => patchEditor({ widgetItemId: null });
  }, [itemId]);

  if (!active || !session) return null;
  return (
    <RequestCard
      key={active.id}
      wallId={session.wallId}
      request={active}
      queued={requests.requests.length}
    />
  );
}

function RequestCard({
  wallId,
  request,
  queued,
}: {
  readonly wallId: string;
  readonly request: InputRequest;
  readonly queued: number;
}) {
  const { t } = useI18n();
  const sending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [unsent, setUnsent] = useState<JsonValue | null>(null);

  function describe(failure: unknown): string {
    if (failure instanceof NetworkError) return t('request.error.offline');
    return failure instanceof ApiError || failure instanceof Error
      ? failure.message
      : t('request.error.unknown');
  }

  /** The wall edits are already applied; only the report to the asker can fail and be retried. */
  async function answer(payload: JsonValue): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    try {
      await answerOpenRequest(wallId, request.id, payload);
    } catch (failure) {
      setUnsent(payload);
      setError(describe(failure));
      sending.current = false;
    }
  }

  async function skip(): Promise<void> {
    if (sending.current) return;
    sending.current = true;
    setError(null);
    try {
      await dismissOpenRequest(wallId, request.id);
    } catch (failure) {
      setError(describe(failure));
      sending.current = false;
    }
  }

  const by = request.createdBy.name ?? t(`request.actor.${request.createdBy.kind}`);
  const title = request.title ?? t(`request.title.${request.kind}`);

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-end justify-center p-2 sm:p-3">
      <section
        aria-label={title}
        className={cn(
          'pointer-events-auto flex max-h-full w-full flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg',
          WIDE_KINDS.has(request.kind) ? 'max-w-5xl' : 'max-w-xl',
        )}
      >
        <header className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">{title}</h2>
            {request.prompt ? (
              <p className="mt-0.5 text-sm text-muted-foreground">{request.prompt}</p>
            ) : null}
          </div>
          {queued > 1 ? (
            <Badge variant="outline">{t('request.counter', { index: 1, total: queued })}</Badge>
          ) : null}
          <Badge variant="secondary">{t('request.by', { name: by })}</Badge>
          <Button variant="ghost" size="sm" onClick={() => void skip()}>
            {t('request.skip')}
          </Button>
        </header>

        <RequestBody request={request} onAnswer={(payload) => void answer(payload)} />

        {error ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
            <span>{t('request.error.send', { message: error })}</span>
            {unsent === null ? null : (
              <Button size="xs" variant="outline" onClick={() => void answer(unsent)}>
                {t('request.retry')}
              </Button>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function RequestBody({
  request,
  onAnswer,
}: {
  readonly request: InputRequest;
  readonly onAnswer: (payload: JsonValue) => void;
}) {
  switch (request.kind) {
    case 'compare':
      return (
        <CompareWidget
          modelRefIds={request.payload.modelRefIds}
          {...(request.itemId === undefined ? {} : { itemId: request.itemId })}
          onDone={(outcome) =>
            onAnswer({ chosen: outcome.chosenId, rejected: [...outcome.rejectedIds] })
          }
        />
      );
    case 'calibration':
      return (
        <CalibrationWizard
          photoId={request.payload.photoId}
          mode={request.payload.mode}
          onDone={(outcome) => onAnswer({ calibrated: true, method: outcome.method })}
        />
      );
    case 'dimension':
      return <RequestDimensionForm request={request} onAnswer={onAnswer} />;
    case 'variant':
      return <RequestVariantForm request={request} onAnswer={onAnswer} />;
  }
}
