import { ChevronRightIcon } from 'lucide-react';
import { useT, type Locale } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { categoryChain, type CategoryNode } from './filters.ts';
import { patchBankFilters, patchBankPanel } from './panelState.ts';

interface CategoryTreeProps {
  readonly tree: readonly CategoryNode[];
  /** Matching elements per category id under every filter except the category itself. */
  readonly counts: ReadonlyMap<string, number>;
  readonly total: number;
  readonly selected: string | null;
  readonly expanded: readonly string[];
  readonly locale: Locale;
}

interface RowProps {
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function SelectRow({ label, count, selected, onSelect }: RowProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={count === 0 && !selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40',
        selected && 'bg-accent font-medium text-accent-foreground',
      )}
    >
      <span className="truncate">{label}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{count}</span>
    </button>
  );
}

/** Two-level category filter; picking a node includes everything below it. */
export function CategoryTree({
  tree,
  counts,
  total,
  selected,
  expanded,
  locale,
}: CategoryTreeProps) {
  const t = useT();

  const select = (id: string | null): void => {
    if (id !== null) {
      const open = new Set([...expanded, ...categoryChain(id).slice(0, -1)]);
      patchBankPanel({ expanded: [...open] });
    }
    patchBankFilters({ category: id === selected ? null : id });
  };

  const toggle = (id: string): void => {
    patchBankPanel({
      expanded: expanded.includes(id) ? expanded.filter((open) => open !== id) : [...expanded, id],
    });
  };

  return (
    <ul
      className="flex max-h-52 flex-col gap-px overflow-y-auto pr-1"
      aria-label={t('bank.filters.category')}
    >
      <li className="flex items-center">
        <span className="w-6 shrink-0" />
        <SelectRow
          label={t('bank.filters.categoryAll')}
          count={total}
          selected={selected === null}
          onSelect={() => patchBankFilters({ category: null })}
        />
      </li>
      {tree.map((node) => {
        const { id, name } = node.category;
        const isOpen = expanded.includes(id);
        return (
          <li key={id}>
            <div className="flex items-center">
              {node.children.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-label={t('bank.filters.categoryToggle', { name: name[locale] })}
                  onClick={() => toggle(id)}
                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <ChevronRightIcon
                    className={cn('size-3.5 transition-transform', isOpen && 'rotate-90')}
                    aria-hidden
                  />
                </button>
              ) : (
                <span className="w-6 shrink-0" />
              )}
              <SelectRow
                label={name[locale]}
                count={counts.get(id) ?? 0}
                selected={selected === id}
                onSelect={() => select(id)}
              />
            </div>
            {isOpen && node.children.length > 0 ? (
              <ul className="flex flex-col gap-px pl-6">
                {node.children.map((child) => (
                  <li key={child.category.id} className="flex">
                    <SelectRow
                      label={child.category.name[locale]}
                      count={counts.get(child.category.id) ?? 0}
                      selected={selected === child.category.id}
                      onSelect={() => select(child.category.id)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
