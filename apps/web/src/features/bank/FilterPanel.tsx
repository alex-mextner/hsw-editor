import { useMemo, type ReactNode } from 'react';
import type { BankIndex } from '@hsw-editor/bank';
import { Label } from '@/components/ui/label.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n } from '@/i18n/index.ts';
import { CategoryTree } from './CategoryTree.tsx';
import { buildCategoryTree, ORIGIN_FILTERS, SIZE_BUCKETS, type BankFilters } from './filters.ts';
import { ORIGIN_LABELS, SIZE_LABELS } from './labels.ts';
import { patchBankFilters } from './panelState.ts';

/** Select values are strings; this one stands for "no tool-class filter" and cannot be a kebab-case id. */
const ANY_TOOL_CLASS = '*';

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

const pressedClass = 'data-pressed:bg-accent data-pressed:text-accent-foreground';

interface FilterPanelProps {
  readonly index: BankIndex;
  readonly filters: BankFilters;
  readonly categoryCounts: ReadonlyMap<string, number>;
  readonly total: number;
  /** Tool classes at least one element holds; the select lists nothing the bank cannot deliver. */
  readonly toolClassIds: ReadonlySet<string>;
  readonly expanded: readonly string[];
}

export function FilterPanel({
  index,
  filters,
  categoryCounts,
  total,
  toolClassIds,
  expanded,
}: FilterPanelProps) {
  const { t, locale } = useI18n();
  const tree = useMemo(() => buildCategoryTree(index.categories), [index.categories]);
  const toolClassItems = useMemo(
    () => [
      { value: ANY_TOOL_CLASS, label: t('bank.filters.toolClassAll') },
      ...index.toolClasses
        .filter((toolClass) => toolClassIds.has(toolClass.id))
        .map((toolClass) => ({ value: toolClass.id, label: toolClass.name[locale] }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    ],
    [index.toolClasses, toolClassIds, locale, t],
  );

  return (
    <div className="flex flex-col gap-3 border-b border-border bg-panel px-3 py-2.5">
      <Field label={t('bank.filters.category')}>
        <CategoryTree
          tree={tree}
          counts={categoryCounts}
          total={total}
          selected={filters.category}
          expanded={expanded}
          locale={locale}
        />
      </Field>
      <Field label={t('bank.filters.toolClass')}>
        <Select
          items={toolClassItems}
          value={filters.toolClass ?? ANY_TOOL_CLASS}
          onValueChange={(value) =>
            patchBankFilters({
              toolClass: value === null || value === ANY_TOOL_CLASS ? null : value,
            })
          }
        >
          <SelectTrigger size="sm" className="w-full" aria-label={t('bank.filters.toolClass')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {toolClassItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t('bank.filters.size')}>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          className="flex-wrap"
          value={filters.size === null ? [] : [filters.size]}
          onValueChange={(value) =>
            patchBankFilters({ size: SIZE_BUCKETS.find((bucket) => bucket === value[0]) ?? null })
          }
        >
          {SIZE_BUCKETS.map((bucket) => (
            <ToggleGroupItem key={bucket} value={bucket} className={pressedClass}>
              {t(SIZE_LABELS[bucket])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Field label={t('bank.filters.origin')}>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={1}
          className="flex-wrap"
          value={[filters.origin]}
          onValueChange={(value) =>
            patchBankFilters({
              origin: ORIGIN_FILTERS.find((origin) => origin === value[0]) ?? 'all',
            })
          }
        >
          {ORIGIN_FILTERS.map((origin) => (
            <ToggleGroupItem key={origin} value={origin} className={pressedClass}>
              {t(ORIGIN_LABELS[origin])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      <Label className="justify-between gap-3 text-xs font-normal">
        {t('bank.filters.redistributable')}
        <Switch
          size="sm"
          checked={filters.redistributableOnly}
          onCheckedChange={(checked) => patchBankFilters({ redistributableOnly: checked })}
        />
      </Label>
    </div>
  );
}
