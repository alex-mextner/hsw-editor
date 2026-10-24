import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { CameraIcon, ChevronDownIcon, CircleAlertIcon, UserIcon } from 'lucide-react';
import { BankSkeleton, NoticeLine, type BankNotice } from '@/features/bank/BankStates.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { ADD_FAILURE_KEY } from '@/wall/actions.ts';
import { addLibraryTool, beginLibraryDrag, endLibraryDrag } from './actions.ts';
import {
  buildEntries,
  createLibrarySearch,
  entryName,
  filterEntries,
  groupEntries,
  NO_QUERY,
  tagCounts,
  type LibraryEntry,
} from './model.ts';
import {
  libraryStore,
  openPhotoWizard,
  openToolDetail,
  patchToolsQuery,
  refreshToolLibrary,
  toggleToolsGroup,
  toggleToolsTag,
  toolsPanelStore,
} from './store.ts';
import { TagChips } from './TagChips.tsx';
import { ToolCard } from './ToolCard.tsx';
import { ToolSearchBox } from './ToolSearchBox.tsx';

const NOTICE_MS = 4000;

/**
 * The Tool Library: built-in classes and the user's own tools, grouped by type with counts, searchable in
 * ru/en, filterable by tag. A tool goes on the wall with a click or a drag.
 */
export function ToolLibraryPanel() {
  const { t, tn, locale } = useI18n();
  const library = useStore(libraryStore);
  const panel = useStore(toolsPanelStore);
  const [notice, setNotice] = useState<BankNotice | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void refreshToolLibrary();
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const show = useCallback((next: BankNotice) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const ready = library.status === 'ready' ? library : null;
  const entries = useMemo(
    () => (ready ? buildEntries(ready.classes, ready.tools) : []),
    [ready],
  );
  const search = useMemo(() => createLibrarySearch(entries), [entries]);
  const visible = useMemo(
    () => filterEntries(entries, panel.query, search),
    [entries, panel.query, search],
  );
  const groups = useMemo(
    () => (ready ? groupEntries(visible, ready.classes) : []),
    [ready, visible],
  );
  const tags = useMemo(() => tagCounts(entries), [entries]);
  const mineCount = entries.filter((entry) => entry.kind === 'tool').length;

  const add = useCallback(
    (entry: LibraryEntry) => {
      const name = entryName(entry, locale);
      const result = addLibraryTool(entry, locale);
      if (result.ok) show({ tone: 'ok', text: t('toolLib.notice.added', { name }) });
      else show({ tone: 'error', text: t(ADD_FAILURE_KEY[result.reason]) });
    },
    [locale, show, t],
  );
  const open = useCallback((entry: LibraryEntry) => openToolDetail(entry.key), []);
  const dragStart = useCallback(
    (event: DragEvent<HTMLElement>, entry: LibraryEntry) =>
      beginLibraryDrag(event.nativeEvent, entry, locale),
    [locale],
  );

  if (library.status === 'loading') return <BankSkeleton />;
  if (library.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
        <CircleAlertIcon className="size-8 text-destructive" aria-hidden />
        <p className="text-sm font-medium">{t('toolLib.error.title')}</p>
        <p className="max-w-64 text-xs text-muted-foreground">
          {library.offline ? t('toolLib.error.offline') : library.message}
        </p>
        <Button variant="outline" size="sm" onClick={() => void refreshToolLibrary()}>
          {t('toolLib.error.retry')}
        </Button>
      </div>
    );
  }

  const filtered = panel.query.text !== '' || panel.query.tags.length > 0 || panel.query.mineOnly;
  return (
    <div className="relative flex h-full min-h-0 flex-col bg-panel" data-testid="tool-library">
      <div className="flex flex-col gap-2 p-2 pb-1">
        <div className="flex gap-2">
          <ToolSearchBox
            query={panel.query.text}
            onQueryChange={(text) => patchToolsQuery({ text })}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={openPhotoWizard}
            title={t('toolLib.addFromPhoto')}
            data-testid="add-from-photo"
          >
            <CameraIcon aria-hidden />
            <span className="max-sm:sr-only">{t('toolLib.addFromPhoto.short')}</span>
          </Button>
        </div>
        {mineCount > 0 ? (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              aria-pressed={panel.query.mineOnly}
              onClick={() => patchToolsQuery({ mineOnly: !panel.query.mineOnly })}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                panel.query.mineOnly
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              <UserIcon className="size-3" aria-hidden />
              {t('toolLib.mineOnly')}
              <span className="font-mono text-[10px] opacity-70">{mineCount}</span>
            </button>
            <TagChips tags={tags} selected={panel.query.tags} onToggle={toggleToolsTag} />
          </div>
        ) : null}
        <p className="text-[11px] text-muted-foreground">{t('toolLib.hint')}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <p className="text-sm font-medium">{t('toolLib.empty.title')}</p>
            <p className="max-w-64 text-xs text-muted-foreground">
              {panel.query.mineOnly && mineCount === 0
                ? t('toolLib.empty.mine')
                : t('toolLib.empty.body')}
            </p>
            {filtered ? (
              <Button variant="outline" size="sm" onClick={() => patchToolsQuery(NO_QUERY)}>
                {t('toolLib.empty.reset')}
              </Button>
            ) : null}
          </div>
        ) : (
          groups.map((group) => {
            // A search shows every match: collapsed groups would hide what the user just asked for.
            const expanded = filtered || !panel.collapsed.includes(group.id);
            const name = group.label[locale];
            return (
              <section key={group.id} className="mb-2" data-testid="tool-group" data-group={group.id}>
                <h3 className="m-0">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={t('toolLib.group.toggle', { name, count: group.entries.length })}
                    onClick={() => toggleToolsGroup(group.id)}
                    className="flex w-full items-center gap-1.5 rounded px-1 py-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <ChevronDownIcon
                      className={cn('size-3.5 shrink-0 transition-transform', !expanded && '-rotate-90')}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <span className="font-mono text-[10px] font-normal">{group.entries.length}</span>
                  </button>
                </h3>
                {expanded ? (
                  <ul className="grid grid-cols-2 gap-2">
                    {group.entries.map((entry) => (
                      <li key={entry.key} className="min-w-0">
                        <ToolCard
                          entry={entry}
                          locale={locale}
                          onAdd={add}
                          onOpen={open}
                          onDragStart={dragStart}
                          onDragEnd={endLibraryDrag}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {tn('toolLib.found', visible.length)}
      </p>
      <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
