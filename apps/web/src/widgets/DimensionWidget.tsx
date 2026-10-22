import { useRef, useState } from 'react';
import { Link2, Link2Off } from 'lucide-react';
import type { BankElement, ParamDef } from '@hsw-editor/bank';
import type { LeafOp, WallItem } from '@hsw-editor/core';
import { IconButton } from '@/components/IconButton.tsx';
import { Button } from '@/components/ui/button.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useT } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { toolBaseDims } from '@/wall/toolPresets.ts';
import { aspectLockStore } from './draft.ts';
import {
  diffParams,
  stepValue,
  valueOf,
  withValue,
  withoutValue,
  type ParamMap,
} from './draftEdits.ts';
import { useDraftPreview } from './draftPreview.ts';
import { DimensionWidgetField, parseField, type StepSize } from './DimensionWidgetField.tsx';
import { DimensionWidgetProvenance } from './DimensionWidgetProvenance.tsx';
import { toolParamDefs } from './toolDimensions.ts';
import { formatLength, isLengthUnit, LENGTH_UNITS, unitStore, type LengthUnit } from './units.ts';

export interface DimensionWidgetProps {
  readonly item: WallItem;
  /** Bank element of the item. Tools have none and are edited through their box dimensions instead. */
  readonly element?: BankElement | undefined;
}

/** Editable dimensions of one wall item, with a live 3D preview until the edit is committed. */
export function DimensionWidget({ item, element }: DimensionWidgetProps) {
  // Keyed by item so a selection change never carries half-typed edits over to another item.
  if (element) {
    return (
      <DimensionForm key={item.id} item={item} element={element} defs={element.params ?? []} />
    );
  }
  if (item.kind === 'tool') return <ToolDimensions key={item.id} item={item} />;
  return null;
}

/** Tools are boxes: width / length / thickness in `item.params`, defaulting to the reference model's size. */
function ToolDimensions({ item }: { readonly item: WallItem }) {
  const t = useT();
  const wall = useStore(sessionStore)?.wall ?? null;
  const base = wall ? toolBaseDims(item, wall) : null;
  if (!base) return null;
  return <DimensionForm item={item} element={undefined} defs={toolParamDefs(base, t)} />;
}

function toOp(itemId: string, set: Record<string, number>, unset: string[]): LeafOp {
  return {
    type: 'setParams',
    id: itemId,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
  };
}

function UnitToggle({ unit }: { readonly unit: LengthUnit }) {
  const t = useT();
  return (
    <ToggleGroup
      value={[unit]}
      onValueChange={(next) => {
        const [chosen] = next;
        if (chosen !== undefined && isLengthUnit(chosen)) unitStore.set(chosen);
      }}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label={t('widgets.dimensions.unit')}
    >
      {LENGTH_UNITS.map((option) => (
        <ToggleGroupItem key={option} value={option} className="h-6 min-w-8 px-1.5 text-[11px]">
          {t(`widgets.unit.${option}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function FixedDimensions({
  element,
  unit,
}: {
  readonly element: BankElement;
  readonly unit: LengthUnit;
}) {
  const t = useT();
  const rows = [
    { key: 'x', label: t('widgets.dimensions.width'), value: element.dimsMm.x },
    { key: 'y', label: t('widgets.dimensions.height'), value: element.dimsMm.y },
    { key: 'z', label: t('widgets.dimensions.depth'), value: element.dimsMm.z },
  ] as const;
  return (
    <div className="grid gap-1.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        {rows.map((row) => (
          <div key={row.key} className="col-span-2 grid grid-cols-subgrid">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="text-right font-mono">{formatLength(row.value, unit)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-muted-foreground">{t('widgets.dimensions.fixed')}</p>
    </div>
  );
}

function DimensionForm({
  item,
  element,
  defs,
}: {
  readonly item: WallItem;
  readonly element: BankElement | undefined;
  readonly defs: readonly ParamDef[];
}) {
  const t = useT();
  const unit = useStore(unitStore);
  const aspect = useStore(aspectLockStore);

  // `working` is the would-be override map (null = no edit). The ref mirrors it synchronously so
  // slider-release and blur handlers, which fire before React re-renders, never read a stale edit.
  const [working, setWorkingState] = useState<ParamMap | null>(null);
  const workingRef = useRef<ParamMap | null>(null);
  const [typing, setTyping] = useState<{ readonly key: string; readonly text: string } | null>(
    null,
  );
  const setWorking = (next: ParamMap | null): void => {
    workingRef.current = next;
    setWorkingState(next);
  };

  useDraftPreview(item.id, element?.id ?? null, working);

  const params = working ?? item.params;
  const dirty = working !== null && diffParams(item.params, working) !== null;
  const disabled = item.locked;
  const current = (): ParamMap => workingRef.current ?? item.params;

  const commit = (next: ParamMap | null = workingRef.current): void => {
    const change = next ? diffParams(item.params, next) : null;
    setWorking(null);
    setTyping(null);
    if (change) submitOps([toOp(item.id, change.set, change.unset)], 'set-params');
  };

  const revert = (): boolean => {
    const had = workingRef.current !== null || typing !== null;
    setWorking(null);
    setTyping(null);
    return had;
  };

  const edit = (def: ParamDef, value: number): ParamMap => {
    const next = withValue(defs, current(), def, value, aspect, item.params);
    setWorking(next);
    return next;
  };

  const commitTyped = (def: ParamDef): void => {
    const pending = typing?.key === def.key ? typing.text : null;
    const parsed = pending === null ? null : parseField(def, pending, unit);
    commit(
      parsed === null
        ? workingRef.current
        : withValue(defs, current(), def, parsed, aspect, item.params),
    );
  };

  const onText = (def: ParamDef, text: string): void => {
    setTyping({ key: def.key, text });
    const parsed = parseField(def, text, unit);
    // Only in-range numbers preview live, so typing "1" on the way to "150" does not jump to the minimum.
    if (parsed !== null && parsed >= def.min && parsed <= def.max) edit(def, parsed);
  };

  const onStep = (def: ParamDef, direction: 1 | -1, size: StepSize, apply: boolean): void => {
    const next = edit(def, stepValue(def, valueOf(def, current()), direction, size));
    setTyping(null);
    if (apply) commit(next);
  };

  return (
    <section
      className="grid gap-2.5"
      data-slot="dimension-widget"
      aria-label={t('widgets.dimensions.title')}
    >
      <header className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t('widgets.dimensions.title')}
        </h3>
        {defs.some((def) => def.unit === 'mm') ? (
          <IconButton
            label={t('widgets.dimensions.aspectLock')}
            pressed={aspect}
            onClick={() => aspectLockStore.set(!aspect)}
          >
            {aspect ? <Link2 /> : <Link2Off />}
          </IconButton>
        ) : null}
        <UnitToggle unit={unit} />
      </header>

      <DimensionWidgetProvenance item={item} />

      {defs.length === 0 && element ? (
        <FixedDimensions element={element} unit={unit} />
      ) : (
        <div className="grid gap-2.5">
          {defs.map((def) => (
            <DimensionWidgetField
              key={def.key}
              def={def}
              value={valueOf(def, params)}
              overridden={def.key in params}
              unit={unit}
              disabled={disabled}
              text={typing?.key === def.key ? typing.text : null}
              onText={(text) => onText(def, text)}
              onSlide={(value) => {
                setTyping(null);
                edit(def, value);
              }}
              onSlideEnd={() => commit()}
              onStep={(direction, size, apply) => onStep(def, direction, size, apply)}
              onCommit={() => commitTyped(def)}
              onRevert={revert}
              onReset={() => commit(withoutValue(current(), def.key))}
            />
          ))}
          {dirty ? (
            <div className="flex items-center justify-end gap-1.5">
              {/* Keep focus in the field: its blur would otherwise commit the edit before Revert runs. */}
              <Button
                variant="ghost"
                size="xs"
                onMouseDown={(event) => event.preventDefault()}
                onClick={revert}
              >
                {t('widgets.dimensions.revert')}
              </Button>
              <Button size="xs" onClick={() => commit()}>
                {t('widgets.dimensions.apply')}
              </Button>
            </div>
          ) : (
            <p className="text-[10px] text-muted-foreground">{t('widgets.dimensions.keys')}</p>
          )}
        </div>
      )}
    </section>
  );
}
