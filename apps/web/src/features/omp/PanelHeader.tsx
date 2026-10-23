import { useMemo, useState } from 'react';
import {
  Brain,
  ChevronDown,
  Cpu,
  GitFork,
  MessageSquarePlus,
  MoreHorizontal,
  Shrink,
} from 'lucide-react';
import type {
  OmpModel,
  OmpSessionFile,
  OmpSessionStats,
  OmpState,
  OmpThinkingLevel,
} from '@hsw-editor/omp-protocol';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';

const MAX_LISTED_MODELS = 120;

function ModelPicker({
  models,
  current,
  onPick,
}: {
  models: readonly OmpModel[];
  current: OmpModel | undefined;
  onPick: (model: OmpModel) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matching =
      needle === ''
        ? models
        : models.filter((model) =>
            `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle),
          );
    return matching.slice(0, MAX_LISTED_MODELS);
  }, [models, query]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="max-w-[10rem] min-w-0 gap-1"
            aria-label={t('omp.model')}
            title={current ? `${current.provider}/${current.id}` : undefined}
          />
        }
      >
        <Cpu />
        <span className="truncate">{current?.name ?? current?.id ?? t('omp.model.unset')}</span>
        <ChevronDown />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-2 p-2">
        <Input
          value={query}
          placeholder={t('omp.model.search')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="max-h-64 overflow-auto">
          {shown.map((model) => {
            const active = current?.id === model.id && current.provider === model.provider;
            return (
              <li key={`${model.provider}/${model.id}`}>
                <button
                  type="button"
                  aria-pressed={active}
                  className={cn(
                    'flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted',
                    active && 'bg-muted font-medium',
                  )}
                  onClick={() => {
                    onPick(model);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {model.provider}
                  </span>
                </button>
              </li>
            );
          })}
          {shown.length === 0 && (
            <li className="px-2 py-1 text-xs text-muted-foreground">{t('omp.model.none')}</li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ThinkingMenu({
  levels,
  current,
  onPick,
}: {
  levels: readonly OmpThinkingLevel[];
  current: OmpThinkingLevel | undefined;
  onPick: (level: OmpThinkingLevel) => void;
}) {
  const { t } = useI18n();
  if (levels.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="xs" className="gap-1" aria-label={t('omp.thinking')} />
        }
      >
        <Brain />
        <span>{t(`omp.level.${current ?? 'off'}`)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={current ?? 'off'}
          onValueChange={(value) => onPick(value as OmpThinkingLevel)}
        >
          {levels.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              {t(`omp.level.${level}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionMenu({
  sessions,
  currentFile,
  onNew,
  onFork,
  onCompact,
  onSwitch,
  busy,
}: {
  sessions: readonly OmpSessionFile[];
  currentFile: string | undefined;
  onNew: () => void;
  onFork: () => void;
  onCompact: () => void;
  onSwitch: (path: string) => void;
  busy: boolean;
}) {
  const { t, locale } = useI18n();
  const format = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }),
    [locale],
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={t('omp.session.menu')} />}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem disabled={busy} onClick={onNew}>
          <MessageSquarePlus />
          {t('omp.session.new')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={onFork}>
          <GitFork />
          {t('omp.session.fork')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={onCompact}>
          <Shrink />
          {t('omp.session.compact')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('omp.session.recent')}</DropdownMenuLabel>
          {sessions.length === 0 && (
            <p className="px-1.5 py-1 text-xs text-muted-foreground">{t('omp.session.none')}</p>
          )}
          {sessions.slice(0, 12).map((session) => {
            const current = session.path === currentFile;
            return (
              <DropdownMenuItem
                key={session.path}
                disabled={busy || current}
                onClick={() => onSwitch(session.path)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {session.title ?? session.preview ?? t('omp.session.untitled')}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">
                    {format.format(new Date(session.updatedAt))}
                    {current ? ` · ${t('omp.session.current')}` : ''}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Usage({ stats, state }: { stats: OmpSessionStats | null; state: OmpState | null }) {
  const { t } = useI18n();
  const context = state?.contextUsage?.percent ?? stats?.contextUsage?.percent ?? null;
  if (stats === null && context === null) return null;
  const tokens = stats?.tokens;
  const title = tokens
    ? t('omp.usage.tokens', { input: tokens.input, output: tokens.output, cache: tokens.cacheRead })
    : undefined;
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground"
      title={title}
    >
      {stats !== null && (
        <span title={t('omp.usage.cost')}>${stats.cost.toFixed(stats.cost < 1 ? 3 : 2)}</span>
      )}
      {context !== null && <span title={t('omp.usage.context')}>{Math.round(context)}%</span>}
    </span>
  );
}

export interface PanelHeaderProps {
  readonly models: readonly OmpModel[];
  readonly thinkingLevels: readonly OmpThinkingLevel[];
  readonly state: OmpState | null;
  readonly stats: OmpSessionStats | null;
  readonly sessions: readonly OmpSessionFile[];
  readonly working: boolean;
  readonly dot: 'ok' | 'busy' | 'warn' | 'off';
  readonly onModel: (model: OmpModel) => void;
  readonly onThinking: (level: OmpThinkingLevel) => void;
  readonly onNew: () => void;
  readonly onFork: () => void;
  readonly onCompact: () => void;
  readonly onSwitch: (path: string) => void;
}

export function PanelHeader(props: PanelHeaderProps) {
  const dotClass = {
    ok: 'bg-emerald-500',
    busy: 'bg-sky-400 animate-pulse',
    warn: 'bg-amber-500',
    off: 'bg-muted-foreground/50',
  }[props.dot];
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <span className={cn('mx-1 size-2 shrink-0 rounded-full', dotClass)} aria-hidden />
      <ModelPicker models={props.models} current={props.state?.model} onPick={props.onModel} />
      <ThinkingMenu
        levels={props.thinkingLevels}
        current={props.state?.thinkingLevel}
        onPick={props.onThinking}
      />
      <span className="flex-1" />
      <Usage stats={props.stats} state={props.state} />
      <SessionMenu
        sessions={props.sessions}
        currentFile={props.state?.sessionFile}
        busy={props.working}
        onNew={props.onNew}
        onFork={props.onFork}
        onCompact={props.onCompact}
        onSwitch={props.onSwitch}
      />
    </div>
  );
}
