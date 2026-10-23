import type { PaletteResults, RankedItem, SettingValue } from '@hsw-editor/commands';
import { useI18n } from '@/i18n/index.ts';
import { PaletteRow } from './PaletteRow.tsx';

export const LIST_ID = 'command-palette-list';

export function rowDomId(index: number): string {
  return `command-palette-row-${index}`;
}

interface PaletteListProps {
  readonly results: PaletteResults;
  readonly active: number;
  readonly onHover: (index: number) => void;
  readonly onRun: (row: RankedItem) => void;
  readonly onSetting: (settingId: string, value: SettingValue) => void;
}

/** Result sections in display order; the flat row index matches `results.rows` for keyboard use. */
export function PaletteList({ results, active, onHover, onRun, onSetting }: PaletteListProps) {
  const { t } = useI18n();
  return (
    // A combobox popup: the search field drives it through aria-activedescendant, no native tag fits.
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <div
      id={LIST_ID}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="listbox"
      aria-label={t('palette.title')}
      className="max-h-[min(24rem,60dvh)] overflow-y-auto p-1.5"
    >
      {results.sections.map((section, sectionIndex) => {
        const firstRow = results.sections
          .slice(0, sectionIndex)
          .reduce((count, earlier) => count + earlier.items.length, 0);
        return (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          <div key={section.kind} role="group" aria-label={t(`palette.section.${section.kind}`)}>
            <h3 className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t(`palette.section.${section.kind}`)}
            </h3>
            {section.items.map((row, offset) => (
              <PaletteRow
                key={row.item.id}
                domId={rowDomId(firstRow + offset)}
                row={row}
                active={firstRow + offset === active}
                onHover={() => onHover(firstRow + offset)}
                onRun={() => onRun(row)}
                onSetting={onSetting}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
