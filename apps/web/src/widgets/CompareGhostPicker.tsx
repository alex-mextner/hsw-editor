import type { ModelRef } from '@hsw-editor/core';
import { useT } from '@/i18n/index.ts';

interface CompareGhostPickerProps {
  readonly candidates: readonly ModelRef[];
  readonly colors: ReadonlyMap<string, string>;
  readonly selectedId: string | undefined;
  readonly onSelect: (id: string) => void;
}

/** Radio chips choosing which candidate the ghost view shows over the photo. */
export function CompareGhostPicker({
  candidates,
  colors,
  selectedId,
  onSelect,
}: CompareGhostPickerProps) {
  const t = useT();
  return (
    <fieldset className="flex flex-wrap gap-1.5">
      <legend className="sr-only">{t('compare.ghost.pick')}</legend>
      {candidates.map((model) => (
        <label
          key={model.id}
          className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted has-checked:border-primary has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
        >
          <input
            type="radio"
            name="compare-ghost"
            className="sr-only"
            checked={selectedId === model.id}
            onChange={() => onSelect(model.id)}
          />
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: colors.get(model.id) }}
          />
          <span className="truncate">{model.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
