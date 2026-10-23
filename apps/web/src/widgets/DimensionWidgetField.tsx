import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { ParamDef } from '@hsw-editor/bank';
import { IconButton } from '@/components/IconButton.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Slider } from '@/components/ui/slider.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { formatNumber, parseLength, parseNumber, type LengthUnit } from './units.ts';

export type StepSize = 1 | 10 | 0.1;

/** Shift steps coarsely, Alt finely. */
function stepSizeOf(event: { shiftKey: boolean; altKey: boolean }): StepSize {
  return event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
}

/** Number shown in the field for a param value: millimetres follow the unit, others stay as they are. */
export function fieldText(def: ParamDef, value: number, unit: LengthUnit): string {
  return formatNumber(value, def.unit === 'mm' ? unit : 'mm');
}

/** Value (in the param's own unit, i.e. mm for lengths) typed into the field; null when it is not a number. */
export function parseField(def: ParamDef, text: string, unit: LengthUnit): number | null {
  return def.unit === 'mm' ? parseLength(text, unit) : parseNumber(text);
}

function unitSuffix(def: ParamDef, unit: LengthUnit): string {
  return def.unit === 'mm' ? unit : def.unit === 'deg' ? '°' : '×';
}

/** Alt/Ctrl + wheel over the focused field steps it; plain wheel keeps scrolling the panel. */
function useModifierWheel(
  ref: { readonly current: HTMLInputElement | null },
  onStep: (direction: 1 | -1, size: StepSize) => void,
): void {
  const latest = useRef(onStep);
  // Updated after render so the native listener below always calls the newest handler.
  useEffect(() => {
    latest.current = onStep;
  });
  useEffect(() => {
    const input = ref.current;
    if (!input) return undefined;
    // Native non-passive listener: React's own wheel handlers are passive and cannot preventDefault.
    const onWheel = (event: WheelEvent): void => {
      if (!(event.altKey || event.ctrlKey) || document.activeElement !== input) return;
      event.preventDefault();
      if (event.deltaY !== 0) latest.current(event.deltaY < 0 ? 1 : -1, event.shiftKey ? 10 : 1);
    };
    input.addEventListener('wheel', onWheel, { passive: false });
    return () => input.removeEventListener('wheel', onWheel);
  }, [ref]);
}

interface DimensionWidgetFieldProps {
  readonly def: ParamDef;
  readonly value: number;
  readonly overridden: boolean;
  readonly unit: LengthUnit;
  readonly disabled: boolean;
  /** Text being typed, or null while the field shows the formatted value. */
  readonly text: string | null;
  readonly onText: (text: string) => void;
  /** Live change from the slider; committed on release. */
  readonly onSlide: (value: number) => void;
  readonly onSlideEnd: () => void;
  /** Arrow keys / wheel: draft only. Buttons pass `commit` to apply at once. */
  readonly onStep: (direction: 1 | -1, size: StepSize, commit: boolean) => void;
  /** Enter or blur. */
  readonly onCommit: () => void;
  /** Escape; returns true when there was something to revert (the key is then consumed). */
  readonly onRevert: () => boolean;
  readonly onReset: () => void;
}

export function DimensionWidgetField({
  def,
  value,
  overridden,
  unit,
  disabled,
  text,
  onText,
  onSlide,
  onSlideEnd,
  onStep,
  onCommit,
  onRevert,
  onReset,
}: DimensionWidgetFieldProps) {
  const { locale, t } = useI18n();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useModifierWheel(inputRef, (direction, size) => onStep(direction, size, false));

  const name = def.label[locale];
  const typed = text === null ? null : parseField(def, text, unit);
  const invalid = typed !== null ? typed < def.min || typed > def.max : text !== null;
  const range = `${fieldText(def, def.min, unit)}–${fieldText(def, def.max, unit)}`;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onCommit();
    } else if (event.key === 'Escape') {
      if (onRevert()) event.stopPropagation();
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      onStep(event.key === 'ArrowUp' ? 1 : -1, stepSizeOf(event), false);
    }
  };

  return (
    <div className="grid gap-1" data-slot="dimension-field">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', overridden ? 'bg-primary' : 'bg-border')}
        />
        <Label htmlFor={inputId} className="min-w-0 flex-1 truncate text-xs">
          {name}
        </Label>
        <span className="font-mono text-[10px] text-muted-foreground">{range}</span>
        <IconButton
          label={t('widgets.dimensions.reset', {
            name,
            value: `${fieldText(def, def.default, unit)} ${unitSuffix(def, unit)}`,
          })}
          size="icon-xs"
          disabled={disabled || !overridden}
          onClick={onReset}
        >
          <RotateCcw />
        </IconButton>
      </div>
      <div className="flex items-center gap-2">
        <Slider
          aria-label={name}
          className="min-w-12 flex-1"
          value={[value]}
          min={def.min}
          max={def.max}
          step={def.step}
          disabled={disabled}
          onValueChange={(next) => {
            const first = typeof next === 'number' ? next : next[0];
            if (first !== undefined) onSlide(first);
          }}
          onValueCommitted={onSlideEnd}
        />
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={t('widgets.dimensions.decrease', { name })}
            size="icon-xs"
            disabled={disabled || value <= def.min}
            onClick={() => onStep(-1, 1, true)}
          >
            <Minus />
          </IconButton>
          <Input
            id={inputId}
            ref={inputRef}
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            aria-invalid={invalid}
            title={invalid ? t('widgets.dimensions.invalid', { range }) : undefined}
            value={text ?? fieldText(def, value, unit)}
            onChange={(event) => onText(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={onCommit}
            onFocus={(event) => event.target.select()}
            className="h-7 w-[4.25rem] px-1.5 text-right font-mono text-xs md:text-xs"
          />
          <span className="w-4 text-[10px] text-muted-foreground">{unitSuffix(def, unit)}</span>
          <IconButton
            label={t('widgets.dimensions.increase', { name })}
            size="icon-xs"
            disabled={disabled || value >= def.max}
            onClick={() => onStep(1, 1, true)}
          >
            <Plus />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
