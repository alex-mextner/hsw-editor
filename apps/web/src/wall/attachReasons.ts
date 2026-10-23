import type { Reason } from '@hsw-editor/compat';
import type { BankState } from '@/bank/client.ts';
import type { Translate } from '@/i18n/index.ts';
import type { Locale } from '@/i18n/locale.ts';

const DIM_KEYS = [
  'width',
  'diameter',
  'bladeThickness',
  'jawThickness',
  'boreDiameter',
  'neckWidth',
  'handleWidth',
  'beamWidth',
  'shaftDiameter',
  'coreDiameter',
  'headWidth',
] as const;

type DimKey = (typeof DIM_KEYS)[number];

function isDimKey(key: string): key is DimKey {
  return (DIM_KEYS as readonly string[]).includes(key);
}

function dimName(t: Translate, key: string): string {
  return isDimKey(key) ? t(`attach.dim.${key}`) : key;
}

type Params = Reason['params'];

function list(value: Params[string] | undefined): readonly string[] {
  if (Array.isArray(value)) return value;
  return value === undefined ? [] : [String(value)];
}

const num = (params: Params, key: string): number => Number(params[key]);
const str = (params: Params, key: string): string => String(params[key] ?? '');

/** One sentence (current locale) for why a mount does not take a tool; `className` names a tool class id. */
export function reasonText(
  t: Translate,
  reason: Reason,
  className: (toolClassId: string) => string,
): string {
  const { params } = reason;
  switch (reason.code) {
    case 'not_a_mount':
      return t('attach.reason.not_a_mount');
    case 'class_mismatch':
      return t('attach.reason.class_mismatch', {
        tool: className(str(params, 'toolClass')),
        accepts: list(params['accepts']).map(className).join(', '),
      });
    case 'dim_too_large':
      return t('attach.reason.dim_too_large', {
        dim: dimName(t, str(params, 'key')),
        valueMm: num(params, 'valueMm'),
        maxMm: num(params, 'maxMm'),
      });
    case 'dim_too_small':
      return t('attach.reason.dim_too_small', {
        dim: dimName(t, str(params, 'key')),
        valueMm: num(params, 'valueMm'),
        minMm: num(params, 'minMm'),
      });
    case 'slots_full':
      return t('attach.reason.slots_full', { capacity: num(params, 'capacity') });
    case 'slot_out_of_range':
      return t('attach.reason.slot_out_of_range', {
        slot: num(params, 'slot'),
        slots: num(params, 'slots'),
      });
    case 'slot_taken':
      return t('attach.reason.slot_taken', { slot: num(params, 'slot') });
    case 'overload':
      return t('attach.reason.overload', {
        massG: num(params, 'massG'),
        maxLoadG: num(params, 'maxLoadG'),
      });
    case 'dim_unknown':
      return t('attach.reason.dim_unknown', { dim: dimName(t, str(params, 'key')) });
  }
}

/** Name of a bank tool class in `locale`; the id itself while the bank is not loaded or does not know it. */
export function toolClassName(bank: BankState, locale: Locale, id: string): string {
  if (bank.status !== 'ready') return id;
  return bank.index.toolClasses.find((candidate) => candidate.id === id)?.name[locale] ?? id;
}
