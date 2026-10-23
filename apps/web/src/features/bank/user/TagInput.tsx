import { useState, type KeyboardEvent } from 'react';
import { XIcon } from 'lucide-react';
import { Input } from '@/components/ui/input.tsx';
import { useI18n } from '@/i18n/index.ts';
import { addTags, MAX_TAG_LENGTH, MAX_TAGS, removeTag } from './formModel.ts';

interface TagInputProps {
  readonly tags: readonly string[];
  readonly onChange: (tags: readonly string[]) => void;
  readonly label: string;
  readonly testId: string;
  readonly disabled: boolean;
}

/** Chips plus a text field: Enter / comma / leaving the field commits the typed text, Backspace removes the last chip. */
export function TagInput({ tags, onChange, label, testId, disabled }: TagInputProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  const commit = (): void => {
    if (draft.trim() === '') return;
    onChange(addTags(tags, draft));
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter must not submit the surrounding form.
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && draft === '') {
      const last = tags[tags.length - 1];
      if (last !== undefined) onChange(removeTag(tags, last));
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      {tags.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
          {tags.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(removeTag(tags, tag))}
                aria-label={t('bank.user.tags.remove', { tag })}
                className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-accent pr-1.5 pl-2.5 text-[11px] text-accent-foreground outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
              >
                <span className="truncate">{tag}</span>
                <XIcon className="size-3 shrink-0" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        data-testid={testId}
        value={draft}
        disabled={disabled || tags.length >= MAX_TAGS}
        maxLength={MAX_TAG_LENGTH}
        aria-label={label}
        placeholder={t('bank.user.tags.placeholder')}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    </div>
  );
}
