import { useId, useMemo } from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import type { BankElement, ToolClass } from '@hsw-editor/bank';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.tsx';
import { useI18n } from '@/i18n/index.ts';
import {
  capacityIssue,
  dimKeySuggestions,
  dimRowIssue,
  newUid,
  type DimRow,
  type DimRowIssue,
  type FitsEntry,
} from './formModel.ts';

interface FitsToolEditorProps {
  readonly entries: readonly FitsEntry[];
  readonly toolClasses: readonly ToolClass[];
  /** Existing bank elements: the dimension keys they use are offered as suggestions. */
  readonly elements: readonly BankElement[];
  readonly onChange: (entries: readonly FitsEntry[]) => void;
  readonly disabled: boolean;
}

const ISSUE_KEYS = {
  key: 'bank.user.fits.issueKey',
  number: 'bank.user.fits.issueNumber',
  order: 'bank.user.fits.issueOrder',
} as const satisfies Record<NonNullable<DimRowIssue>, string>;

function replaceAt<T>(items: readonly T[], position: number, next: T): T[] {
  return items.map((item, at) => (at === position ? next : item));
}

interface EntryRowProps {
  readonly entry: FitsEntry;
  readonly toolClassItems: readonly { value: string; label: string }[];
  readonly suggestions: readonly string[];
  readonly onChange: (entry: FitsEntry) => void;
  readonly onRemove: () => void;
  readonly disabled: boolean;
}

function EntryRow({
  entry,
  toolClassItems,
  suggestions,
  onChange,
  onRemove,
  disabled,
}: EntryRowProps) {
  const { t } = useI18n();
  const listId = useId();
  const capacityBad = capacityIssue(entry.capacity) !== null;
  const setDim = (position: number, next: DimRow): void =>
    onChange({ ...entry, dims: replaceAt(entry.dims, position, next) });
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2"
      data-testid="add-element-fits-entry"
    >
      <div className="flex items-center gap-1.5">
        <Select
          items={toolClassItems}
          value={entry.toolClass === '' ? null : entry.toolClass}
          disabled={disabled}
          onValueChange={(value) => onChange({ ...entry, toolClass: value ?? '' })}
        >
          <SelectTrigger className="min-w-0 flex-1" aria-label={t('bank.user.fits.toolClass')}>
            <SelectValue placeholder={t('bank.user.fits.toolClassPlaceholder')} />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {toolClassItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          className="w-20 shrink-0"
          value={entry.capacity}
          disabled={disabled}
          aria-label={t('bank.user.fits.capacity')}
          aria-invalid={capacityBad}
          placeholder={t('bank.user.fits.capacity')}
          onChange={(event) => onChange({ ...entry, capacity: event.target.value })}
        />
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          aria-label={t('bank.user.fits.removeEntry')}
          onClick={onRemove}
        >
          <Trash2Icon aria-hidden />
        </Button>
      </div>
      <datalist id={listId}>
        {suggestions.map((key) => (
          <option key={key} value={key}>
            {key}
          </option>
        ))}
      </datalist>
      {entry.dims.map((row, position) => {
        const issue = dimRowIssue(row);
        return (
          <div key={position} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <Input
                list={listId}
                className="min-w-0 flex-1 font-mono"
                value={row.key}
                disabled={disabled}
                aria-label={t('bank.user.fits.dimKey')}
                aria-invalid={issue !== null}
                placeholder={t('bank.user.fits.dimKey')}
                onChange={(event) => setDim(position, { ...row, key: event.target.value })}
              />
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                className="w-[4.5rem] shrink-0"
                value={row.min}
                disabled={disabled}
                aria-label={t('bank.user.fits.min')}
                aria-invalid={issue === 'number' || issue === 'order'}
                placeholder={t('bank.user.fits.min')}
                onChange={(event) => setDim(position, { ...row, min: event.target.value })}
              />
              <Input
                type="number"
                inputMode="decimal"
                step="any"
                className="w-[4.5rem] shrink-0"
                value={row.max}
                disabled={disabled}
                aria-label={t('bank.user.fits.max')}
                aria-invalid={issue === 'number' || issue === 'order'}
                placeholder={t('bank.user.fits.max')}
                onChange={(event) => setDim(position, { ...row, max: event.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={t('bank.user.fits.removeDim')}
                onClick={() =>
                  onChange({ ...entry, dims: entry.dims.filter((_, at) => at !== position) })
                }
              >
                <Trash2Icon aria-hidden />
              </Button>
            </div>
            {issue !== null ? (
              <p role="alert" className="text-[11px] text-destructive">
                {t(ISSUE_KEYS[issue])}
              </p>
            ) : null}
          </div>
        );
      })}
      <Button
        variant="outline"
        size="xs"
        className="self-start"
        disabled={disabled}
        onClick={() => onChange({ ...entry, dims: [...entry.dims, { key: '', min: '', max: '' }] })}
      >
        <PlusIcon aria-hidden />
        {t('bank.user.fits.addDim')}
      </Button>
    </li>
  );
}

/** "Holds" hints: which tool classes the element is for, with capacity and dimension ranges in mm. */
export function FitsToolEditor({
  entries,
  toolClasses,
  elements,
  onChange,
  disabled,
}: FitsToolEditorProps) {
  const { t, locale } = useI18n();
  const toolClassItems = useMemo(
    () =>
      toolClasses
        .map((toolClass) => ({ value: toolClass.id, label: toolClass.name[locale] }))
        .sort((a, b) => a.label.localeCompare(b.label, locale)),
    [toolClasses, locale],
  );
  return (
    <div className="flex flex-col gap-2" data-testid="add-element-fits">
      {entries.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {entries.map((entry, position) => (
            <EntryRow
              key={entry.uid}
              entry={entry}
              toolClassItems={toolClassItems}
              suggestions={dimKeySuggestions(elements, entry.toolClass)}
              disabled={disabled}
              onChange={(next) => onChange(replaceAt(entries, position, next))}
              onRemove={() => onChange(entries.filter((_, at) => at !== position))}
            />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('bank.user.fits.empty')}</p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={disabled}
        onClick={() =>
          onChange([...entries, { uid: newUid(), toolClass: '', capacity: '', dims: [] }])
        }
      >
        <PlusIcon aria-hidden />
        {t('bank.user.fits.add')}
      </Button>
    </div>
  );
}
