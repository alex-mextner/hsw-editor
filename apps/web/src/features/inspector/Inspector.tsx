import { useState } from 'react';
import {
  Bot,
  Copy,
  Lock,
  LockOpen,
  RotateCcw,
  RotateCw,
  Terminal,
  Trash2,
  User,
} from 'lucide-react';
import type { BankElement } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useI18n, type Locale } from '@/i18n/index.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import {
  deleteSelection,
  duplicateSelection,
  rotateSelection,
  toggleLockSelection,
} from '@/wall/actions.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { ItemWidgets } from '@/widgets/ItemWidgets.tsx';
import { CompareSection } from '@/widgets/CompareSection.tsx';
import { WallPanel } from './WallPanel.tsx';

export function itemTitle(
  item: WallItem,
  element: BankElement | undefined,
  locale: Locale,
): string {
  return item.label ?? element?.name[locale] ?? item.bankId ?? item.id;
}

/** Right-hand panel: the selected item (position, rotation, widgets) or, with no selection, the wall. */
export function Inspector() {
  const { t, tn } = useI18n();
  const wall = useStore(sessionStore)?.wall ?? null;
  const selection = useStore(editorStore).selection;
  const bank = useStore(bankStore);
  if (!wall) return <p className="p-4 text-sm text-muted-foreground">{t('inspector.noWall')}</p>;
  const items = wall.items.filter((item) => selection.includes(item.id));
  const [first] = items;
  if (!first) return <WallPanel wall={wall} />;
  if (items.length > 1) {
    return (
      <div className="grid gap-3 p-3">
        <h2 className="text-sm font-semibold">{tn('inspector.selected', items.length)}</h2>
        <ItemActions items={items} />
      </div>
    );
  }
  const element = bank.status === 'ready' && first.bankId ? bank.byId.get(first.bankId) : undefined;
  return <ItemPanel key={first.id} wall={wall} item={first} element={element} />;
}

function ItemPanel({
  wall,
  item,
  element,
}: {
  readonly wall: Wall;
  readonly item: WallItem;
  readonly element: BankElement | undefined;
}) {
  const { t, locale } = useI18n();
  const title = itemTitle(item, element, locale);
  return (
    <div className="grid gap-4 p-3">
      <header className="grid gap-2">
        <LabelField item={item} placeholder={element?.name[locale] ?? t('inspector.unnamed')} />
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="secondary">{t(`kind.${item.kind}`)}</Badge>
          <SourceBadge item={item} />
          {item.locked ? (
            <Badge variant="outline" className="gap-1">
              <Lock className="size-3" aria-hidden /> {t('inspector.locked')}
            </Badge>
          ) : null}
        </div>
        {element ? (
          <p className="text-xs text-muted-foreground" title={title}>
            {element.name[locale]}
          </p>
        ) : null}
      </header>

      <ItemActions items={[item]} />
      <Placement item={item} wall={wall} />
      <ItemWidgets item={item} />
      <CompareSection item={item} />
    </div>
  );
}

function LabelField({
  item,
  placeholder,
}: {
  readonly item: WallItem;
  readonly placeholder: string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(item.label ?? '');
  const [focused, setFocused] = useState(false);
  // An undo or a remote rename changes the label under an idle field; follow it unless being typed in.
  if (!focused && draft !== (item.label ?? '')) setDraft(item.label ?? '');
  const commit = (): void => {
    const next = draft.trim();
    if (next === (item.label ?? '') || next === '') return;
    submitOps([{ type: 'rename', name: next, itemId: item.id }], 'rename-item');
  };
  return (
    <Input
      value={draft}
      placeholder={placeholder}
      aria-label={t('inspector.name')}
      disabled={item.locked}
      className="h-8 font-medium"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(item.label ?? '');
      }}
    />
  );
}

function SourceBadge({ item }: { readonly item: WallItem }) {
  const { t } = useI18n();
  const { type, confidence, by } = item.source;
  if (type === 'manual') return null;
  const Icon = type === 'agent' ? Bot : type === 'vision' ? Terminal : User;
  return (
    <Badge variant="outline" className="gap-1" title={by}>
      <Icon className="size-3" aria-hidden />
      {t(`source.${type}`)}
      {confidence !== undefined ? (
        <span className="text-muted-foreground">{Math.round(confidence * 100)}%</span>
      ) : null}
    </Badge>
  );
}

function ItemActions({ items }: { readonly items: readonly WallItem[] }) {
  const { t } = useI18n();
  const allLocked = items.every((item) => item.locked);
  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        label={t('action.rotateLeft')}
        shortcut="Shift+R"
        disabled={allLocked}
        onClick={() => rotateSelection(-1)}
      >
        <RotateCcw />
      </IconButton>
      <IconButton
        label={t('action.rotateRight')}
        shortcut="R"
        disabled={allLocked}
        onClick={() => rotateSelection(1)}
      >
        <RotateCw />
      </IconButton>
      <IconButton label={t('action.duplicate')} shortcut="Ctrl+D" onClick={duplicateSelection}>
        <Copy />
      </IconButton>
      <IconButton
        label={allLocked ? t('action.unlock') : t('action.lock')}
        shortcut="L"
        pressed={allLocked}
        onClick={toggleLockSelection}
      >
        {allLocked ? <LockOpen /> : <Lock />}
      </IconButton>
      <div className="flex-1" />
      <IconButton
        label={t('action.delete')}
        shortcut="Del"
        disabled={allLocked}
        onClick={deleteSelection}
      >
        <Trash2 className="text-destructive" />
      </IconButton>
    </div>
  );
}

function Placement({ item, wall }: { readonly item: WallItem; readonly wall: Wall }) {
  const { t } = useI18n();
  const { x, y, z, rotZ } = item.pose;
  const cell = item.cell;
  return (
    <section className="grid gap-1.5">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {t('inspector.placement')}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {cell ? (
          <>
            <dt className="text-muted-foreground">{t('inspector.cell')}</dt>
            <dd className="font-mono">
              {cell.col}, {cell.row}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{t('inspector.position')}</dt>
        <dd className="font-mono">
          {x.toFixed(1)} × {y.toFixed(1)} mm
        </dd>
        <dt className="text-muted-foreground">{t('inspector.offset')}</dt>
        <dd className="font-mono">{z.toFixed(1)} mm</dd>
        <dt className="text-muted-foreground">{t('inspector.rotation')}</dt>
        <dd className="font-mono">{Math.round(rotZ)}°</dd>
      </dl>
      {item.parentId ? (
        <p className="text-xs text-muted-foreground">
          {t('inspector.heldBy', {
            name: wall.items.find((other) => other.id === item.parentId)?.label ?? item.parentId,
          })}
        </p>
      ) : null}
    </section>
  );
}
