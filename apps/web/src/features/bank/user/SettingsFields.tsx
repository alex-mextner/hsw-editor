import { useMemo, type ReactNode } from 'react';
import {
  ANCHOR_MODES,
  MESH_UNITS,
  type BankCategory,
  type MeshFormat,
  type MeshPart,
  type Orientation,
  type SignedAxis,
} from '@hsw-editor/bank';
import { Button } from '@/components/ui/button.tsx';
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
import { useI18n, type MessageKey } from '@/i18n/index.ts';
import { categoryPathNames } from '../detailModel.ts';
import { buildCategoryTree } from '../filters.ts';
import { axisLabel, OUT_CHOICES, upChoices, withOut, withUp } from './orientation.ts';

const pressedClass = 'data-pressed:bg-accent data-pressed:text-accent-foreground';

export const ALL_PARTS = '*';

export function FieldRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const ANCHOR_LABELS: Readonly<Record<(typeof ANCHOR_MODES)[number], MessageKey>> = {
  'back-bbox': 'bank.user.anchor.back-bbox',
  origin: 'bank.user.anchor.origin',
  panel: 'bank.user.anchor.panel',
};

const UNIT_LABELS: Readonly<Record<(typeof MESH_UNITS)[number], MessageKey>> = {
  auto: 'bank.user.unit.auto',
  mm: 'bank.user.unit.mm',
  cm: 'bank.user.unit.cm',
  m: 'bank.user.unit.m',
  in: 'bank.user.unit.in',
};

// --- category ----------------------------------------------------------------------------------

interface CategorySelectProps {
  readonly categories: readonly BankCategory[];
  readonly value: string;
  readonly onChange: (category: string) => void;
  readonly disabled: boolean;
  readonly invalid: boolean;
}

/** Category select over the whole tree, the nested ones labelled `Parent › Child`. */
export function CategorySelect({
  categories,
  value,
  onChange,
  disabled,
  invalid,
}: CategorySelectProps) {
  const { t, locale } = useI18n();
  const items = useMemo(() => {
    const out: { value: string; label: string }[] = [];
    for (const node of buildCategoryTree(categories)) {
      for (const category of [node.category, ...node.children.map((child) => child.category)]) {
        out.push({
          value: category.id,
          label: categoryPathNames(categories, category.id, locale).join(' › '),
        });
      }
    }
    return out;
  }, [categories, locale]);
  return (
    <Select
      items={items}
      value={value === '' ? null : value}
      disabled={disabled}
      onValueChange={(next) => onChange(next ?? '')}
    >
      <SelectTrigger
        className="w-full"
        data-testid="add-element-category"
        aria-label={t('bank.user.category')}
        aria-invalid={invalid}
      >
        <SelectValue placeholder={t('bank.user.categoryPlaceholder')} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// --- part --------------------------------------------------------------------------------------

interface PartPickerProps {
  readonly parts: readonly MeshPart[];
  readonly value: string;
  readonly onChange: (partId: string) => void;
  readonly disabled: boolean;
}

/** Only shown for files with several parts (3MF objects, glTF meshes): one of them, or all merged. */
export function PartPicker({ parts, value, onChange, disabled }: PartPickerProps) {
  const { t, tn } = useI18n();
  const items = [
    { value: ALL_PARTS, label: t('bank.user.part.all') },
    ...parts.map((part) => ({
      value: part.partId,
      label: `${part.partId} · ${tn('bank.user.part.triangles', part.triangles)}`,
    })),
  ];
  return (
    <Select
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger
        className="w-full"
        data-testid="add-element-part"
        aria-label={t('bank.user.part.label')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// --- orientation -------------------------------------------------------------------------------

interface OrientationPickerProps {
  readonly format: MeshFormat;
  readonly orient: Orientation;
  /** The user has chosen it (otherwise it is the detected guess); offers going back to automatic. */
  readonly chosen: boolean;
  readonly onChange: (orient: Orientation | null) => void;
  readonly disabled: boolean;
}

function AxisToggles({
  axes,
  value,
  format,
  onPick,
  disabled,
  testId,
  label,
}: {
  readonly axes: readonly SignedAxis[];
  readonly value: SignedAxis;
  readonly format: MeshFormat;
  readonly onPick: (axis: SignedAxis) => void;
  readonly disabled: boolean;
  readonly testId: string;
  readonly label: string;
}) {
  const t = useI18n().t;
  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      spacing={1}
      className="flex-wrap"
      aria-label={label}
      disabled={disabled}
      value={[value]}
      onValueChange={(next) => {
        const axis = axes.find((candidate) => candidate === next[0]);
        if (axis !== undefined) onPick(axis);
      }}
    >
      {axes.map((axis) => {
        const { axis: text, role } = axisLabel(axis, format);
        return (
          <ToggleGroupItem
            key={axis}
            value={axis}
            className={pressedClass}
            data-testid={`${testId}-${axis}`}
          >
            {text}
            {role === null
              ? ''
              : ` ${t(role === 'top' ? 'bank.user.axis.top' : 'bank.user.axis.bottom')}`}
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}

export function OrientationPicker({
  format,
  orient,
  chosen,
  onChange,
  disabled,
}: OrientationPickerProps) {
  const t = useI18n().t;
  return (
    <div className="flex flex-col gap-3" data-testid="add-element-orientation">
      <FieldRow label={t('bank.user.orient.out')} hint={t('bank.user.orient.outHint')}>
        <AxisToggles
          axes={OUT_CHOICES}
          value={orient.out}
          format={format}
          disabled={disabled}
          testId="add-element-out"
          label={t('bank.user.orient.out')}
          onPick={(out) => onChange(withOut(out, orient.up))}
        />
      </FieldRow>
      <FieldRow label={t('bank.user.orient.up')} hint={t('bank.user.orient.upHint')}>
        <AxisToggles
          axes={upChoices(orient.out)}
          value={orient.up}
          format={format}
          disabled={disabled}
          testId="add-element-up"
          label={t('bank.user.orient.up')}
          onPick={(up) => onChange(withUp(orient.out, up))}
        />
      </FieldRow>
      {chosen ? (
        <Button
          variant="ghost"
          size="xs"
          className="self-start"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          {t('bank.user.orient.auto')}
        </Button>
      ) : (
        <p className="text-[11px] text-muted-foreground">{t('bank.user.orient.detected')}</p>
      )}
    </div>
  );
}

// --- anchor / unit / repair --------------------------------------------------------------------

interface ConvertOptionsProps {
  readonly anchor: (typeof ANCHOR_MODES)[number];
  readonly unit: (typeof MESH_UNITS)[number];
  readonly repair: boolean;
  readonly onAnchor: (anchor: (typeof ANCHOR_MODES)[number]) => void;
  readonly onUnit: (unit: (typeof MESH_UNITS)[number]) => void;
  readonly onRepair: (repair: boolean) => void;
  readonly disabled: boolean;
}

export function ConvertOptions({
  anchor,
  unit,
  repair,
  onAnchor,
  onUnit,
  onRepair,
  disabled,
}: ConvertOptionsProps) {
  const t = useI18n().t;
  const anchorItems = ANCHOR_MODES.map((mode) => ({ value: mode, label: t(ANCHOR_LABELS[mode]) }));
  const unitItems = MESH_UNITS.map((option) => ({ value: option, label: t(UNIT_LABELS[option]) }));
  return (
    <div className="flex flex-col gap-3">
      <FieldRow label={t('bank.user.anchor.label')} hint={t('bank.user.anchor.hint')}>
        <Select
          items={anchorItems}
          value={anchor}
          disabled={disabled}
          onValueChange={(next) => {
            const mode = ANCHOR_MODES.find((candidate) => candidate === next);
            if (mode !== undefined) onAnchor(mode);
          }}
        >
          <SelectTrigger
            className="w-full"
            data-testid="add-element-anchor"
            aria-label={t('bank.user.anchor.label')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {anchorItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <FieldRow label={t('bank.user.unit.label')} hint={t('bank.user.unit.hint')}>
        <Select
          items={unitItems}
          value={unit}
          disabled={disabled}
          onValueChange={(next) => {
            const option = MESH_UNITS.find((candidate) => candidate === next);
            if (option !== undefined) onUnit(option);
          }}
        >
          <SelectTrigger
            className="w-full"
            data-testid="add-element-unit"
            aria-label={t('bank.user.unit.label')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {unitItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldRow>
      <Label className="justify-between gap-3 text-xs font-normal">
        <span className="flex flex-col gap-0.5">
          {t('bank.user.repair.label')}
          <span className="text-[11px] text-muted-foreground">{t('bank.user.repair.hint')}</span>
        </span>
        <Switch
          size="sm"
          data-testid="add-element-repair"
          checked={repair}
          disabled={disabled}
          onCheckedChange={onRepair}
        />
      </Label>
    </div>
  );
}
