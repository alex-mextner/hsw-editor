import { useState } from 'react';
import type { BankElement } from '@hsw-editor/bank';
import type { WallItem } from '@hsw-editor/core';
import { createValueStore } from '#state-backend';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import {
  AXIS_LABEL_KEY,
  LADDER_KEYS,
  ladderReasonKey,
  rungsOf,
  snapToLadder,
  switchOps,
  type LadderKey,
  type LadderResult,
  type Rung,
} from './variantLadder.ts';
import { formatLength, formatNumber, parseLength, type LengthUnit } from './units.ts';

/**
 * The last typed size of each item and the rung it resolved to. Outside the widget because committing a rung
 * swaps the item's variant, which can remount the inspector; the explanation has to survive that.
 */
const ladderNoteStore = createValueStore<Readonly<Record<string, LadderResult>>>({});

/** Remembers `result` for `itemId` and forgets the notes of items that are no longer on the wall. */
function rememberLadder(itemId: string, result: LadderResult): void {
  const onWall = new Set(sessionStore.get()?.wall?.items.map((item) => item.id));
  const kept = Object.entries(ladderNoteStore.get()).filter(([id]) => onWall.has(id));
  ladderNoteStore.set({ ...Object.fromEntries(kept), [itemId]: result });
}

interface DimensionLadderProps {
  readonly item: WallItem;
  readonly element: BankElement;
  /** The element's family, itself included. */
  readonly family: readonly BankElement[];
  readonly unit: LengthUnit;
}

/**
 * Width / height / depth of a holder that comes in fixed sizes. Typing a size picks the nearest real variant of
 * the family, says what was asked and what it became, and offers the neighbouring sizes as chips.
 */
export function DimensionLadder({ item, element, family, unit }: DimensionLadderProps) {
  const { locale, t } = useI18n();
  const note = useStore(ladderNoteStore)[item.id] ?? null;
  const [typing, setTyping] = useState<{ readonly key: LadderKey; readonly text: string } | null>(
    null,
  );

  const label = (rung: Rung): string => {
    const variant = rung.element.variantLabel?.[locale];
    const size = formatLength(rung.valueMm, unit);
    return variant === undefined ? size : `${size} · ${variant}`;
  };

  const choose = (result: LadderResult): void => {
    // A refused switch (locked item, a concurrent edit) leaves no note about a size that was never applied.
    if (result.chosen !== null && result.chosen.element.id !== element.id) {
      if (!submitOps(switchOps(item, result.chosen.element), 'set-variant').ok) return;
    }
    rememberLadder(item.id, result);
  };

  const commit = (key: LadderKey): void => {
    const text = typing?.key === key ? typing.text : null;
    setTyping(null);
    if (text === null) return;
    const mm = parseLength(text, unit);
    if (mm === null) return;
    choose(snapToLadder(family, key, mm, element));
  };

  const pick = (key: LadderKey, rung: Rung): void => {
    choose(snapToLadder(family, key, rung.valueMm, element));
  };

  // A note belongs to the variant it chose: once the item shows another one, the note is stale.
  const live =
    note !== null && (note.chosen === null || note.chosen.element.id === element.id) ? note : null;
  return (
    <div className="grid gap-2" data-slot="dimension-ladder">
      {LADDER_KEYS.map((key) => {
        const editable = rungsOf(family, key, element).length > 1;
        const inputId = `ladder-${item.id}-${key}`;
        const text = typing?.key === key ? typing.text : formatNumber(element.dimsMm[key], unit);
        const noted = live?.key === key ? live : null;
        const changed =
          noted !== null &&
          noted.chosen !== null &&
          Math.abs(noted.chosen.valueMm - noted.requestedMm) > 0.005;
        return (
          <div key={key} className="grid gap-1" data-slot="ladder-field">
            <div className="flex items-center gap-2">
              <Label htmlFor={inputId} className="min-w-0 flex-1 truncate text-xs">
                {t(AXIS_LABEL_KEY[key])}
              </Label>
              <Input
                id={inputId}
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                disabled={item.locked || !editable}
                value={text}
                onChange={(event) => setTyping({ key, text: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commit(key);
                  } else if (event.key === 'Escape' && typing !== null) {
                    event.stopPropagation();
                    setTyping(null);
                  }
                }}
                onBlur={() => commit(key)}
                onFocus={(event) => event.target.select()}
                className="h-7 w-[4.25rem] px-1.5 text-right font-mono text-xs md:text-xs"
              />
              <span className="w-4 text-[10px] text-muted-foreground">{unit}</span>
            </div>
            {noted !== null && noted.chosen === null ? (
              <p className="text-[11px] text-warn" data-slot="ladder-note">
                {t(ladderReasonKey(noted.reason), { name: '' })}
              </p>
            ) : null}
            {noted !== null && noted.chosen !== null ? (
              <div className="grid gap-1" data-slot="ladder-note">
                {noted.alsoChanged.map((other) => (
                  <p key={other.key} className="text-[11px] text-warn">
                    {t('photo.snap.alsoChanged', {
                      name: t(AXIS_LABEL_KEY[other.key]),
                      from: formatLength(other.fromMm, unit),
                      to: formatLength(other.toMm, unit),
                    })}
                  </p>
                ))}
                {changed ? (
                  <p className="text-[11px] text-warn">
                    {t('photo.snap.requested', {
                      requested: formatNumber(noted.requestedMm, unit),
                      snapped: formatNumber(noted.chosen.valueMm, unit),
                    })}{' '}
                    {t(ladderReasonKey(noted.reason), {
                      name: noted.chosen.element.variantLabel?.[locale] ?? element.name[locale],
                    })}
                  </p>
                ) : null}
                <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
                  <legend className="sr-only">{t('photo.snap.rungs')}</legend>
                  {[noted.below, noted.chosen, noted.above].map((rung) =>
                    rung === null ? null : (
                      <button
                        key={rung.element.id}
                        type="button"
                        data-rung={rung.element.id}
                        aria-current={rung.element.id === element.id ? 'true' : undefined}
                        disabled={item.locked}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pick(key, rung)}
                        className={cn(
                          'rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors',
                          rung.element.id === element.id
                            ? 'border-primary bg-primary/10 text-foreground'
                            : 'border-border text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {label(rung)}
                      </button>
                    ),
                  )}
                </fieldset>
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground">{t('photo.snap.ladderHint')}</p>
    </div>
  );
}
