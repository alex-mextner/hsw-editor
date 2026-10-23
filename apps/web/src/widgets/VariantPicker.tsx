import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { BankElement, BankIndex } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { familyOf } from '@/bank/suggest.ts';
import { suggestHolders } from '@/bank/holderSuggestions.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { addHolderForTool } from '@/wall/actions.ts';
import { toolInterfaceOf } from '@/wall/toolInterface.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { usePhysicsRatings, useRankedCandidates } from '@/physics/suggest.ts';
import { VariantPickerCard, type Candidate } from './VariantPickerCard.tsx';
import { switchOps } from './variantLadder.ts';

const NO_HOLDER_IDS: readonly string[] = [];

const FOCUS_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];

/** Roving focus over the cards: arrows step, Home/End jump. */
function moveFocus(event: KeyboardEvent): void {
  if (!FOCUS_KEYS.includes(event.key) || !(event.currentTarget instanceof HTMLElement)) return;
  const cards = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-candidate]')];
  const at = cards.findIndex((card) => card === document.activeElement);
  const target =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? cards.length - 1
        : Math.min(cards.length - 1, Math.max(0, at + (event.key === 'ArrowRight' ? 1 : -1)));
  event.preventDefault();
  cards[target]?.focus();
}

/**
 * `toolClass` is optional on items and model refs and may not exist in older documents, so it is
 * read without assuming the field is declared.
 */
function toolClassOf(item: WallItem, wall: Wall | null): string | undefined {
  if ('toolClass' in item && typeof item.toolClass === 'string') return item.toolClass;
  const ref = wall?.models.find((model) => model.id === item.modelRefId);
  return ref && 'toolClass' in ref && typeof ref.toolClass === 'string' ? ref.toolClass : undefined;
}

function candidatesFor(
  item: WallItem,
  wall: Wall | null,
  index: BankIndex,
  byId: ReadonlyMap<string, BankElement>,
): Candidate[] {
  if (item.kind === 'tool') {
    // The compatibility maths of `@hsw-editor/compat`: class, measured dimensions and mount ranges decide.
    const tool = wall ? toolInterfaceOf(item, wall) : undefined;
    return tool === undefined
      ? []
      : suggestHolders(tool, index.elements).map(({ element, score, capacity }) => ({
          element,
          score,
          capacity,
        }));
  }
  const element = item.bankId === undefined ? undefined : byId.get(item.bankId);
  return element
    ? familyOf(index, element).map((sibling) => ({ element: sibling, score: null, capacity: null }))
    : [];
}

/**
 * Carousel of alternatives for the selected item: size/variant siblings for a holder or board part,
 * ranked holder suggestions for a tool. Picking replaces the holder's variant or adds a new holder.
 */
export function VariantPicker({ item }: { readonly item: WallItem }) {
  const { locale, t } = useI18n();
  const bank = useStore(bankStore);
  const session = useStore(sessionStore);
  const wall = session?.wall ?? null;
  const isTool = item.kind === 'tool';
  const toolClass = isTool ? toolClassOf(item, wall) : undefined;

  // Fit order of the compatibility maths.
  const suggested = useMemo(
    () => (bank.status === 'ready' ? candidatesFor(item, wall, bank.index, bank.byId) : []),
    [bank, item, wall],
  );
  // Stability and convenience of hanging this tool on each suggested holder (tools only).
  const holderIds = useMemo(
    () => (isTool ? suggested.map((candidate) => candidate.element.id) : NO_HOLDER_IDS),
    [isTool, suggested],
  );
  const ratings = usePhysicsRatings(item.id, holderIds);
  // Re-ranked as ratings arrive; rows already shown move only when their place changes by more than one.
  const candidates = useRankedCandidates(suggested, ratings);
  // Keyed by item so the message of one pick never shows on another selection.
  const [noRoomFor, setNoRoomFor] = useState<string | null>(null);
  const noRoom = noRoomFor === item.id;
  const listRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = (): void =>
      setEdges({
        start: list.scrollLeft <= 1,
        end: list.scrollLeft + list.clientWidth >= list.scrollWidth - 1,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    list.addEventListener('scroll', measure, { passive: true });
    // Native listener: the scroller is not an interactive element, so React props on it are a11y errors.
    list.addEventListener('keydown', moveFocus);
    return () => {
      observer.disconnect();
      list.removeEventListener('scroll', measure);
      list.removeEventListener('keydown', moveFocus);
    };
  }, [candidates]);

  // Open on the current choice so it is never hidden off-screen in a long ladder.
  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-current="true"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [candidates, item.bankId]);

  const pick = (candidate: Candidate): void => {
    if (isTool) {
      // A refusal already told the user why in a toast; only a missing cell shows the no-room line.
      setNoRoomFor(addHolderForTool(item, candidate.element) === 'no-room' ? item.id : null);
      return;
    }
    submitOps(switchOps(item, candidate.element), 'set-variant');
  };

  const scrollBy = (direction: 1 | -1): void => {
    const list = listRef.current;
    list?.scrollBy({ left: direction * list.clientWidth * 0.8, behavior: 'smooth' });
  };

  const toolClassName =
    bank.status === 'ready' && toolClass !== undefined
      ? bank.index.toolClasses.find((entry) => entry.id === toolClass)?.name[locale]
      : undefined;
  const title =
    isTool && toolClass !== undefined
      ? t('widgets.variants.forTool', { name: toolClassName ?? toolClass })
      : t('widgets.variants.title');

  return (
    <section className="grid gap-2" data-slot="variant-picker" aria-label={title}>
      <header className="flex items-center gap-1">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </h3>
        {candidates.length > 1 ? (
          <>
            <IconButton
              label={t('widgets.variants.previous')}
              size="icon-xs"
              disabled={edges.start}
              onClick={() => scrollBy(-1)}
            >
              <ChevronLeft />
            </IconButton>
            <IconButton
              label={t('widgets.variants.next')}
              size="icon-xs"
              disabled={edges.end}
              onClick={() => scrollBy(1)}
            >
              <ChevronRight />
            </IconButton>
          </>
        ) : null}
      </header>
      <Body
        status={bank.status}
        count={candidates.length}
        unknownClass={isTool && toolClass === undefined}
        isTool={isTool}
      />
      {candidates.length > 0 ? (
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="sr-only">{title}</legend>
          <div
            ref={listRef}
            className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto scroll-smooth px-1 pb-1 [scrollbar-width:thin]"
          >
            {candidates.map((candidate) => (
              <VariantPickerCard
                key={candidate.element.id}
                candidate={candidate}
                physics={ratings.get(candidate.element.id)}
                current={!isTool && candidate.element.id === item.bankId}
                disabled={!isTool && item.locked}
                adds={isTool}
                onPick={() => pick(candidate)}
              />
            ))}
          </div>
        </fieldset>
      ) : null}
      {noRoom ? (
        <p role="alert" className="text-[11px] text-warn">
          {t('widgets.variants.noRoom')}
        </p>
      ) : null}
    </section>
  );
}

interface BodyProps {
  readonly status: 'loading' | 'error' | 'ready';
  readonly count: number;
  readonly unknownClass: boolean;
  readonly isTool: boolean;
}

/** Loading / error / empty states; renders nothing when there are cards to show. */
function Body({ status, count, unknownClass, isTool }: BodyProps) {
  const { t } = useI18n();
  if (status === 'loading') {
    return (
      <div className="flex gap-2" aria-busy aria-label={t('widgets.variants.loading')}>
        {[0, 1, 2].map((slot) => (
          <div key={slot} className="h-32 w-28 shrink-0 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }
  if (status === 'error') {
    return (
      <p role="alert" className="text-xs text-destructive">
        {t('widgets.variants.error')}
      </p>
    );
  }
  if (unknownClass) {
    return <p className="text-xs text-muted-foreground">{t('widgets.variants.noClass')}</p>;
  }
  if (count === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {isTool ? t('widgets.variants.noHolders') : t('widgets.variants.noVariants')}
      </p>
    );
  }
  if (!isTool && count === 1) {
    return <p className="text-xs text-muted-foreground">{t('widgets.variants.noVariants')}</p>;
  }
  return null;
}
