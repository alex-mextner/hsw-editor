import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';

interface TagChipsProps {
  readonly tags: ReadonlyArray<readonly [string, number]>;
  readonly selected: readonly string[];
  readonly onToggle: (tag: string) => void;
}

/** Toggle chips of the tags in use on the user's tools; the selected ones narrow the list. */
export function TagChips({ tags, selected, onToggle }: TagChipsProps) {
  const t = useI18n().t;
  if (tags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label={t('toolLib.tags')} data-testid="tool-tags">
      {tags.map(([tag, count]) => {
        const on = selected.includes(tag);
        return (
          <li key={tag}>
            <button
              type="button"
              aria-pressed={on}
              title={t('toolLib.tag.toggle', { tag, count })}
              onClick={() => onToggle(tag)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                on
                  ? 'border-primary bg-primary/15 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              <span>{tag}</span>
              <span className="font-mono text-[10px] opacity-70">{count}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
