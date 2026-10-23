import { describe, expect, test } from 'bun:test';
import type { Reason } from '@hsw-editor/compat';
import { translate } from '@/i18n/index.ts';
import { reasonText } from './attachReasons.ts';

const names: Record<string, { en: string; ru: string }> = {
  screwdriver: { en: 'screwdriver', ru: 'отвёртка' },
  'tape-measure': { en: 'tape measure', ru: 'рулетка' },
};

const cases: readonly { reason: Reason; en: string; ru: string }[] = [
  {
    reason: { code: 'not_a_mount', params: {} },
    en: 'This element has no mounts for tools.',
    ru: 'У этого элемента нет креплений для инструмента.',
  },
  {
    reason: {
      code: 'class_mismatch',
      params: { toolClass: 'screwdriver', accepts: ['tape-measure'] },
    },
    en: 'It takes tape measure, not screwdriver.',
    ru: 'Подходит: рулетка. отвёртка — нет.',
  },
  {
    reason: {
      code: 'dim_too_large',
      params: { key: 'shaftDiameter', valueMm: 8.3, maxMm: 6, overMm: 2.3 },
    },
    en: 'The tool’s shaft diameter is 8.3 mm; the mount takes up to 6 mm.',
    ru: 'У инструмента диаметр стержня 8.3 мм, крепление берёт до 6 мм.',
  },
  {
    reason: { code: 'dim_too_small', params: { key: 'width', valueMm: 3, minMm: 5, underMm: 2 } },
    en: 'The tool’s width is 3 mm; the mount needs at least 5 mm.',
    ru: 'У инструмента ширина 3 мм, крепление берёт от 5 мм.',
  },
  {
    reason: { code: 'slots_full', params: { capacity: 3, occupied: 3 } },
    en: 'All 3 places are taken.',
    ru: 'Все места (3) заняты.',
  },
  {
    reason: { code: 'slot_out_of_range', params: { slot: 5, slots: 3 } },
    en: 'Place 5 does not exist; the mount has 3.',
    ru: 'Места 5 нет: в креплении их 3.',
  },
  {
    reason: { code: 'slot_taken', params: { slot: 1 } },
    en: 'Place 1 is already taken.',
    ru: 'Место 1 уже занято.',
  },
  {
    reason: { code: 'overload', params: { massG: 900, maxLoadG: 500 } },
    en: 'The tool weighs 900 g; a place holds 500 g.',
    ru: 'Инструмент весит 900 г, место держит 500 г.',
  },
  {
    reason: { code: 'dim_unknown', params: { key: 'handleWidth' } },
    en: 'The tool’s handle width is not measured.',
    ru: 'У инструмента не измерено: ширина рукоятки.',
  },
];

describe('reasonText', () => {
  for (const locale of ['en', 'ru'] as const) {
    for (const { reason, ...expected } of cases) {
      test(`${reason.code} reads right in ${locale}`, () => {
        const text = reasonText(
          (key, params) => translate(locale, key, params),
          reason,
          (id) => names[id]?.[locale] ?? id,
        );
        expect(text).toBe(expected[locale]);
      });
    }
  }
});
