import type { PlanEntry, PlanStatus } from '@hsw-editor/commands';
import { Check, Loader2, Square, X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { aiSession, useAiStatus } from '@/commands/aiSession.ts';
import { settingsStore } from '@/commands/app.ts';
import { Button } from '@/components/ui/button.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { useI18n, type MessageKey } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';

const STATUS_KEYS: Readonly<Record<PlanStatus, MessageKey>> = {
  planned: 'palette.ai.planned',
  running: 'palette.ai.running',
  done: 'palette.ai.done',
  failed: 'palette.ai.failed',
};

function formatArgs(args: unknown): string | null {
  return args === null || args === undefined ? null : JSON.stringify(args);
}

function useApprovalNeeded(): boolean {
  const read = (): boolean => settingsStore.get('ai.approval') !== false;
  return useSyncExternalStore((notify) => settingsStore.subscribe(notify), read, read);
}

/** The AI's streamed answer, the actions it planned, and the approval prompt for changing ones. */
interface AiAnswerPaneProps {
  readonly question: string;
  readonly onNewQuestion: () => void;
}

export function AiAnswerPane({ question, onNewQuestion }: AiAnswerPaneProps) {
  const { t, locale } = useI18n();
  const status = useAiStatus();
  const answer = useStore(aiSession.answer);
  const approval = useStore(aiSession.approval);
  const needsApproval = useApprovalNeeded();
  // While this pane is on screen the user can answer approval prompts.
  useEffect(() => aiSession.attachApprovalUi(), []);

  if (status === 'unavailable') {
    return <p className="p-4 text-sm text-muted-foreground">{t('palette.ai.unavailable')}</p>;
  }
  if (status === 'connecting') {
    return (
      <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('palette.ai.connecting')}
      </p>
    );
  }

  return (
    <div className="flex max-h-[min(24rem,60dvh)] flex-col gap-3 overflow-y-auto p-4 text-sm">
      <p className="font-medium">{t('palette.ai.title', { text: question })}</p>

      {answer.status === 'streaming' && answer.text === '' ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t('palette.ai.thinking')}
        </p>
      ) : null}
      {answer.text === '' ? null : <p className="whitespace-pre-wrap">{answer.text}</p>}
      {answer.error === null ? null : (
        <p role="alert" className="text-destructive">
          {t('palette.ai.error', { message: answer.error })}
        </p>
      )}

      {answer.plans.length === 0 ? null : (
        <section aria-label={t('palette.ai.actions')} className="grid gap-1.5">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t('palette.ai.actions')}
          </h3>
          <ul className="grid gap-1">
            {answer.plans.map((entry) => (
              <PlanRow key={entry.plan.id} entry={entry} locale={locale} />
            ))}
          </ul>
        </section>
      )}

      {approval === null ? null : (
        <section
          aria-label={t('palette.ai.approvalTitle')}
          className="grid gap-2 rounded-lg border border-primary/50 bg-primary/5 p-3"
        >
          <h3 className="font-medium">{t('palette.ai.approvalTitle')}</h3>
          <p>
            {approval.plan.title[locale]}{' '}
            <span className="text-xs text-muted-foreground">
              {approval.plan.mutates ? t('palette.ai.mutating') : t('palette.ai.readOnly')}
            </span>
          </p>
          {formatArgs(approval.plan.args) === null ? null : (
            <p className="font-mono text-xs break-all text-muted-foreground">
              {t('palette.ai.argsLabel')}: {formatArgs(approval.plan.args)}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" className="max-sm:h-11" onClick={() => aiSession.respond(true)}>
              <Check aria-hidden /> {t('palette.ai.approve')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="max-sm:h-11"
              onClick={() => aiSession.respond(false)}
            >
              <X aria-hidden /> {t('palette.ai.reject')}
            </Button>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={needsApproval}
            onCheckedChange={(checked) => settingsStore.set('ai.approval', checked)}
          />
          <span>
            {t('palette.ai.approvalMode')}:{' '}
            {needsApproval
              ? t('palette.ai.approvalMode.approve')
              : t('palette.ai.approvalMode.auto')}
          </span>
        </label>
        <span className="flex-1" />
        {answer.status === 'streaming' ? (
          <Button
            size="sm"
            variant="outline"
            className="max-sm:h-11"
            onClick={() => aiSession.cancel()}
          >
            <Square aria-hidden /> {t('palette.ai.stop')}
          </Button>
        ) : answer.status === 'idle' ? null : (
          <Button size="sm" variant="outline" className="max-sm:h-11" onClick={onNewQuestion}>
            {t('palette.ai.newQuestion')}
          </Button>
        )}
      </div>
    </div>
  );
}

function PlanRow({ entry, locale }: { readonly entry: PlanEntry; readonly locale: 'en' | 'ru' }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-2 rounded-md bg-muted/50 px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate">{entry.plan.title[locale]}</span>
      <span
        className={cn(
          'shrink-0 text-xs',
          entry.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {t(STATUS_KEYS[entry.status])}
      </span>
    </li>
  );
}
