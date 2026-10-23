import { useId, useState } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n, type Locale } from '@/i18n/index.ts';
import type { ParamSpec, ParamValues } from './api.ts';
import { formatValue } from './paramValues.ts';

interface ParamFieldsProps {
  readonly schema: Readonly<Record<string, ParamSpec>>;
  readonly values: ParamValues;
  readonly onChange: (key: string, value: number | string) => void;
  readonly disabled?: boolean;
}

const UNIT_LABEL = { mm: 'mm', deg: '°', count: '', ratio: '' } as const;

function NumField({
  id,
  spec,
  value,
  label,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly spec: Extract<ParamSpec, { kind: 'num' }>;
  readonly value: number;
  readonly label: string;
  readonly onChange: (value: number) => void;
  readonly disabled: boolean;
}) {
  const unit = UNIT_LABEL[spec.unit];
  // What the user is typing; the value only changes while the text is a number inside the range, and the field
  // snaps back to the (clamped) value when it loses focus, so "150" can be typed through "1" and "15".
  const [typing, setTyping] = useState<string | null>(null);
  return (
    <div className="grid grid-cols-[1fr_5.5rem] items-center gap-x-2 gap-y-1">
      <label htmlFor={id} className="truncate text-xs text-muted-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={typing ?? formatValue(value)}
          disabled={disabled}
          onChange={(event) => {
            setTyping(event.target.value);
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next) && next >= spec.min && next <= spec.max) onChange(next);
          }}
          onBlur={(event) => {
            const next = event.target.valueAsNumber;
            // Only a changed value is reported: leaving a field untouched must not refit anything.
            const clamped = Math.min(spec.max, Math.max(spec.min, next));
            if (Number.isFinite(next) && clamped !== value) onChange(clamped);
            setTyping(null);
          }}
          className="h-7 pr-7 text-right font-mono text-xs"
        />
        {unit === '' ? null : (
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      <Slider
        className="col-span-2 [&_[data-slot=slider-track]]:bg-foreground/15"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={[value]}
        disabled={disabled}
        aria-label={label}
        onValueChange={(next) => {
          const [first] = Array.isArray(next) ? next : [next];
          if (first !== undefined) onChange(first);
        }}
      />
    </div>
  );
}

function labelOf(spec: ParamSpec, locale: Locale): string {
  return spec.label[locale] || spec.label.en;
}

/** Widgets for the parameter schema of a tool class: sliders with numeric fields, option groups, colour pickers. */
export function ParamFields({ schema, values, onChange, disabled = false }: ParamFieldsProps) {
  const { locale } = useI18n();
  const base = useId();
  return (
    <div className="grid gap-3" data-testid="param-fields">
      {Object.entries(schema).map(([key, spec]) => {
        const id = `${base}-${key}`;
        const text = labelOf(spec, locale);
        const value = values[key] ?? spec.def;
        if (spec.kind === 'num') {
          return (
            <NumField
              key={key}
              id={id}
              spec={spec}
              value={typeof value === 'number' ? value : spec.def}
              label={text}
              disabled={disabled}
              onChange={(next) => onChange(key, next)}
            />
          );
        }
        if (spec.kind === 'choice') {
          return (
            <div key={key} className="grid gap-1">
              <span id={id} className="text-xs text-muted-foreground">
                {text}
              </span>
              <ToggleGroup
                aria-labelledby={id}
                variant="outline"
                size="sm"
                spacing={1}
                className="flex-wrap"
                value={[String(value)]}
                disabled={disabled}
                onValueChange={(next) => {
                  const [chosen] = next;
                  if (chosen !== undefined) onChange(key, chosen);
                }}
              >
                {spec.options.map((option) => (
                  <ToggleGroupItem key={option} value={option} className="h-6 px-2 text-[11px]">
                    {option}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          );
        }
        return (
          <div key={key} className="flex items-center justify-between gap-2">
            <label htmlFor={id} className="truncate text-xs text-muted-foreground">
              {text}
            </label>
            <input
              id={id}
              type="color"
              value={String(value)}
              disabled={disabled}
              onChange={(event) => onChange(key, event.target.value)}
              className="h-6 w-10 cursor-pointer rounded border border-input bg-transparent p-0"
            />
          </div>
        );
      })}
    </div>
  );
}
