import { XIcon } from 'lucide-react';
import type { BankIndex } from '@hsw-editor/bank';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import type { BankFilters } from './filters.ts';
import { ORIGIN_LABELS, SIZE_LABELS } from './labels.ts';
import { patchBankFilters } from './panelState.ts';
import { dispatchToolFilter } from './toolFilterStore.ts';

interface Chip {
  readonly key: string;
  readonly label: string;
  readonly remove: () => void;
}

interface FilterChipsProps {
  readonly index: BankIndex;
  readonly filters: BankFilters;
  /** Tool classes of the explicit (persisted) tool filter. */
  readonly explicit: readonly string[];
  readonly onReset: () => void;
}

/** One removable chip per active filter, plus a reset that also clears the search. */
export function FilterChips({ index, filters, explicit, onReset }: FilterChipsProps) {
  const { t, locale } = useI18n();
  const chips: Chip[] = [];
  if (filters.category !== null) {
    const category = index.categories.find((candidate) => candidate.id === filters.category);
    chips.push({
      key: 'category',
      label: category?.name[locale] ?? filters.category,
      remove: () => patchBankFilters({ category: null }),
    });
  }
  for (const id of explicit) {
    const toolClass = index.toolClasses.find((candidate) => candidate.id === id);
    chips.push({
      key: `toolClass:${id}`,
      label: toolClass?.name[locale] ?? id,
      remove: () =>
        dispatchToolFilter({
          type: 'setExplicit',
          classes: explicit.filter((other) => other !== id),
        }),
    });
  }
  if (filters.size !== null) {
    chips.push({
      key: 'size',
      label: t(SIZE_LABELS[filters.size]),
      remove: () => patchBankFilters({ size: null }),
    });
  }
  if (filters.origin !== 'all') {
    chips.push({
      key: 'origin',
      label: t(ORIGIN_LABELS[filters.origin]),
      remove: () => patchBankFilters({ origin: 'all' }),
    });
  }
  if (filters.redistributableOnly) {
    chips.push({
      key: 'redistributable',
      label: t('bank.filters.redistributable'),
      remove: () => patchBankFilters({ redistributableOnly: false }),
    });
  }

  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
      <legend className="sr-only">{t('bank.filters.active')}</legend>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={chip.remove}
          aria-label={t('bank.filters.remove', { name: chip.label })}
          className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-accent pr-1.5 pl-2.5 text-[11px] text-accent-foreground outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="truncate">{chip.label}</span>
          <XIcon className="size-3 shrink-0" aria-hidden />
        </button>
      ))}
      <Button variant="ghost" size="xs" onClick={onReset}>
        {t('bank.filters.reset')}
      </Button>
    </fieldset>
  );
}
