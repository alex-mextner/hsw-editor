import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  CircleSlash,
  ListChecks,
  Undo2,
  X,
  ArrowUpToLine,
} from 'lucide-react';
import type { OmpQueuedMessages, OmpTodoPhase, OmpTodoStatus } from '@hsw-editor/omp-protocol';
import { IconButton } from '@/components/IconButton.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useT } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import type { AgentEdit } from './store.ts';

const STATUS_ICON: Readonly<Record<OmpTodoStatus, typeof Circle>> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: Check,
  abandoned: CircleSlash,
  blocked: CircleSlash,
};

export function TodoStrip({ phases }: { phases: readonly OmpTodoPhase[] }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length === 0) return null;
  const done = tasks.filter((task) => task.status === 'completed').length;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section
      className="border-t border-border px-2 py-1.5 text-xs"
      aria-label={t('omp.todo.title')}
    >
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left font-medium"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Chevron className="size-3.5" />
        <ListChecks className="size-3.5 text-primary" />
        <span className="flex-1">{t('omp.todo.title')}</span>
        <span className="text-muted-foreground">
          {t('omp.todo.progress', { done, total: tasks.length })}
        </span>
      </button>
      {open && (
        <div className="mt-1 max-h-32 space-y-1 overflow-auto">
          {phases.map((phase) => (
            <div key={phase.name}>
              {phases.length > 1 && <p className="text-muted-foreground">{phase.name}</p>}
              <ul>
                {phase.tasks.map((task, index) => {
                  const Icon = STATUS_ICON[task.status];
                  return (
                    <li
                      key={`${index}-${task.content}`}
                      className={cn(
                        'flex items-start gap-1.5 py-0.5',
                        task.status === 'completed' && 'text-muted-foreground line-through',
                      )}
                    >
                      <Icon
                        className={cn(
                          'mt-0.5 size-3 shrink-0',
                          task.status === 'in_progress' && 'text-primary',
                          task.status === 'blocked' && 'text-destructive',
                        )}
                      />
                      <span className="break-words">{task.content}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function QueueStrip({
  queue,
  onRemove,
  onPromote,
}: {
  queue: OmpQueuedMessages;
  onRemove: (message: string, queue: 'steering' | 'followUp') => void;
  onPromote: (message: string) => void;
}) {
  const t = useT();
  const items = [
    ...queue.steering.map((message) => ({ message, queue: 'steering' as const })),
    ...queue.followUp.map((message) => ({ message, queue: 'followUp' as const })),
  ];
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 border-t border-border px-2 py-1.5 text-xs">
      {items.map((item, index) => (
        <li
          key={`${item.queue}-${index}`}
          className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1"
        >
          <span className="shrink-0 rounded bg-background px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {item.queue === 'steering' ? t('omp.queue.steering') : t('omp.queue.followUp')}
          </span>
          <span className="min-w-0 flex-1 truncate" title={item.message}>
            {item.message}
          </span>
          {item.queue === 'followUp' && (
            <IconButton
              label={t('omp.queue.promote')}
              size="icon-xs"
              onClick={() => onPromote(item.message)}
            >
              <ArrowUpToLine />
            </IconButton>
          )}
          <IconButton
            label={t('omp.queue.remove')}
            size="icon-xs"
            onClick={() => onRemove(item.message, item.queue)}
          >
            <X />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

export function AgentEditBar({
  edit,
  onUndo,
  result,
}: {
  edit: AgentEdit;
  onUndo: () => void;
  result: 'stale' | 'failed' | null;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-2 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate">
        {t('omp.edit.applied', { rev: edit.rev, count: edit.opCount })}
      </span>
      <Button size="xs" variant="outline" onClick={onUndo}>
        <Undo2 />
        {t('omp.edit.undo')}
      </Button>
      {result !== null && (
        <span className="sr-only">
          {result === 'stale' ? t('omp.edit.stale') : t('omp.edit.failed')}
        </span>
      )}
    </div>
  );
}
