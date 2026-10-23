import type { PaletteControl, SettingValue } from '@hsw-editor/commands';
import { labelText } from '@hsw-editor/commands';
import { useState } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { useI18n } from '@/i18n/index.ts';

interface SettingControlProps {
  readonly control: PaletteControl;
  readonly label: string;
  /** Only the highlighted row's control is in the Tab order, so Tab from the field lands on it. */
  readonly tabbable: boolean;
  readonly onChange: (value: SettingValue) => void;
}

/** Inline editor of one setting: operable by mouse, touch and keyboard (Tab, Enter, Space, arrows). */
export function SettingControl({ control, label, tabbable, onChange }: SettingControlProps) {
  const tabIndex = tabbable ? 0 : -1;
  switch (control.type) {
    case 'switch':
      return (
        <Switch
          size="default"
          checked={control.checked}
          aria-label={label}
          tabIndex={tabIndex}
          onCheckedChange={onChange}
        />
      );
    case 'choice':
      return (
        <ChoiceControl control={control} label={label} tabIndex={tabIndex} onChange={onChange} />
      );
    case 'number':
      return (
        <NumberControl control={control} label={label} tabIndex={tabIndex} onChange={onChange} />
      );
  }
}

function ChoiceControl({
  control,
  label,
  tabIndex,
  onChange,
}: {
  readonly control: Extract<PaletteControl, { type: 'choice' }>;
  readonly label: string;
  readonly tabIndex: number;
  readonly onChange: (value: SettingValue) => void;
}) {
  const { locale } = useI18n();
  return (
    <select
      value={control.value}
      aria-label={label}
      tabIndex={tabIndex}
      onChange={(event) => onChange(event.target.value)}
      className="h-8 max-w-40 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 max-sm:h-11 dark:bg-input/30"
    >
      {control.options.map((option) => (
        <option
          key={option.value}
          value={option.value}
          className="bg-popover text-popover-foreground"
        >
          {labelText(option.label, locale)}
        </option>
      ))}
    </select>
  );
}

function NumberControl({
  control,
  label,
  tabIndex,
  onChange,
}: {
  readonly control: Extract<PaletteControl, { type: 'number' }>;
  readonly label: string;
  readonly tabIndex: number;
  readonly onChange: (value: SettingValue) => void;
}) {
  // `null` while the field is not being edited: it then shows the stored value, so an external
  // change (the setting toggled elsewhere) never needs an effect to sync.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      type="number"
      inputMode="decimal"
      value={draft ?? String(control.value)}
      min={control.min}
      max={control.max}
      step={control.step}
      aria-label={label}
      tabIndex={tabIndex}
      className="w-24 max-sm:h-11"
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = event.target.valueAsNumber;
        if (Number.isFinite(parsed)) onChange(parsed);
      }}
      onBlur={() => setDraft(null)}
    />
  );
}
