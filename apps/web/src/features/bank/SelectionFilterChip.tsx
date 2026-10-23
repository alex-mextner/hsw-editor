import { XIcon } from 'lucide-react';
import type { BankIndex } from '@hsw-editor/bank';
import { useI18n } from '@/i18n/index.ts';
import { dispatchToolFilter } from './toolFilterStore.ts';

interface SelectionFilterChipProps {
  readonly index: BankIndex;
  /** Tool classes of the selected tool items (the override). */
  readonly classes: readonly string[];
}

/** "Filter: <tools> x": the selected tools override the bank's tool filter; X brings the previous one back. */
export function SelectionFilterChip({ index, classes }: SelectionFilterChipProps) {
  const { t, locale } = useI18n();
  const tools = classes
    .map((id) => index.toolClasses.find((candidate) => candidate.id === id)?.name[locale] ?? id)
    .join(', ');
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        data-testid="selection-filter-chip"
        onClick={() => dispatchToolFilter({ type: 'dismissOverride' })}
        aria-label={t('bank.filters.selectionReset', { tools })}
        className="inline-flex h-6 max-w-full items-center gap-1 self-start rounded-full bg-primary/15 pr-1.5 pl-2.5 text-[11px] text-foreground outline-none hover:bg-primary/25 focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="truncate">{t('bank.filters.selection', { tools })}</span>
        <XIcon className="size-3 shrink-0" aria-hidden />
      </button>
      <p className="text-[10px] text-muted-foreground">{t('bank.filters.selectionHint')}</p>
    </div>
  );
}
