import { useEffect, useMemo, useState } from 'react';
import { currentWallId } from '@/state/current-wall.ts';
import { useStore } from '@/state/react.ts';
import { useT } from '@/i18n/index.ts';
import { ActivityBanners, ConnectionBanner, NoticeList } from './Banners.tsx';
import { Composer } from './Composer.tsx';
import { DialogCard, WallPromptCard } from './PendingCards.tsx';
import { PanelHeader } from './PanelHeader.tsx';
import { AgentEditBar, QueueStrip, TodoStrip } from './Strips.tsx';
import { omp, ompView } from './store.ts';
import { Transcript } from './vendor/index.ts';
import './omp-render.css';

type UndoResult = 'stale' | 'failed' | null;

/** The embedded omp panel: transcript, pending approvals and questions, composer, and session controls. */
export function OmpPanel() {
  const t = useT();
  const wallId = useStore(currentWallId);
  const view = useStore(ompView);
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const [undoResult, setUndoResult] = useState<UndoResult>(null);

  useEffect(() => {
    omp.connect(wallId);
    return () => omp.connect(null);
  }, [wallId]);

  const { conversation, server } = view;
  const working = conversation.working;
  const ready = view.phase === 'live' && server?.phase === 'ready' && view.loaded;
  const dot = !ready
    ? view.phase === 'live' && server?.phase === 'failed'
      ? 'warn'
      : 'off'
    : working
      ? 'busy'
      : 'ok';
  const hasContent = conversation.entries.length > 0 || conversation.stream !== null || working;
  const todos = view.state?.todoPhases ?? [];
  const hint = useMemo(
    () => (view.statusTexts.size === 0 ? null : [...view.statusTexts.values()].join(' · ')),
    [view.statusTexts],
  );

  if (wallId === null) {
    return <p className="p-4 text-xs text-muted-foreground">{t('omp.noWall')}</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="omp-panel">
      <PanelHeader
        models={view.models}
        thinkingLevels={view.thinkingLevels}
        state={view.state}
        stats={view.stats}
        sessions={view.sessions}
        working={working}
        dot={dot}
        onModel={(model) => void omp.setModel(model)}
        onThinking={(level) => void omp.setThinkingLevel(level)}
        onNew={() => void omp.newSession()}
        onFork={() => void omp.fork()}
        onCompact={() => void omp.compact()}
        onSwitch={(path) => void omp.switchSession(path)}
      />
      <ConnectionBanner
        phase={view.phase}
        server={server}
        loaded={view.loaded}
        onRestart={() => omp.restartChild()}
      />
      <ActivityBanners retry={conversation.retry} compacting={conversation.compacting} />
      <NoticeList
        notices={conversation.notices}
        dismissed={dismissed}
        onDismiss={(id) => setDismissed(new Set([...dismissed, id]))}
      />
      <div className="omp-scope relative min-h-0 flex-1 overflow-hidden">
        {hasContent ? (
          <Transcript
            entries={conversation.entries}
            stream={conversation.stream}
            streamDone={false}
            activeTools={conversation.activeTools}
            working={working}
            phase={view.phase}
          />
        ) : (
          ready && (
            <p className="px-6 pt-8 text-center text-xs text-muted-foreground">{t('omp.empty')}</p>
          )
        )}
      </div>
      {hint !== null && (
        <p className="truncate border-t border-border px-3 py-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <TodoStrip phases={todos} />
      <div className="max-h-[55%] shrink-0 overflow-auto pt-2">
        {view.prompts.map((prompt) => (
          <WallPromptCard
            key={prompt.id}
            request={prompt}
            onAnswer={(answer) => omp.answerPrompt(prompt.id, answer)}
          />
        ))}
        {view.dialogs.map((dialog) => (
          <DialogCard
            key={dialog.id}
            request={dialog}
            onAnswer={(response) => omp.answerDialog(response)}
          />
        ))}
      </div>
      {view.lastEdit !== null && !working && (
        <AgentEditBar
          edit={view.lastEdit}
          result={undoResult}
          onUndo={() => {
            void omp
              .undoLastAgentEdit()
              .then((outcome) => setUndoResult(outcome === 'undone' ? null : outcome));
          }}
        />
      )}
      {undoResult !== null && view.lastEdit === null && (
        <output className="block border-t border-border px-3 py-1 text-xs text-muted-foreground">
          {undoResult === 'stale' ? t('omp.edit.stale') : t('omp.edit.failed')}
        </output>
      )}
      <QueueStrip
        queue={conversation.queue}
        onRemove={(message, queue) => void omp.removeQueued(message, queue)}
        onPromote={(message) => void omp.promoteQueued(message)}
      />
      <Composer
        working={working}
        disabled={!ready}
        fill={view.composerFill}
        onSubmit={(text, images, mode) => omp.submit(text, images, mode)}
        onStop={() => void omp.stop()}
      />
    </div>
  );
}
