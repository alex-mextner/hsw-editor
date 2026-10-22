import type { BankCategory } from './schema.ts';

/** The fixed category tree of the bank (two levels). Elements reference leaf or top-level ids. */
export const BANK_CATEGORIES: readonly BankCategory[] = [
  { id: 'holders', name: { ru: 'Держатели', en: 'Holders' }, order: 10 },
  {
    id: 'holders/screwdrivers',
    parent: 'holders',
    name: { ru: 'Отвёртки', en: 'Screwdriver holders' },
    order: 11,
  },
  {
    id: 'holders/pliers',
    parent: 'holders',
    name: { ru: 'Плоскогубцы и кусачки', en: 'Pliers and cutters' },
    order: 12,
  },
  {
    id: 'holders/wrenches',
    parent: 'holders',
    name: { ru: 'Ключи', en: 'Wrench holders' },
    order: 13,
  },
  {
    id: 'holders/hex-keys',
    parent: 'holders',
    name: { ru: 'Шестигранники', en: 'Hex key holders' },
    order: 14,
  },
  {
    id: 'holders/drills',
    parent: 'holders',
    name: { ru: 'Дрели и шуруповёрты', en: 'Drill holders' },
    order: 15,
  },
  {
    id: 'holders/measuring',
    parent: 'holders',
    name: { ru: 'Измерительные', en: 'Measuring tools' },
    order: 16,
  },
  {
    id: 'holders/tape',
    parent: 'holders',
    name: { ru: 'Скотч и изолента', en: 'Tape holders' },
    order: 17,
  },
  {
    id: 'holders/hammers',
    parent: 'holders',
    name: { ru: 'Молотки', en: 'Hammer holders' },
    order: 18,
  },
  {
    id: 'holders/cutting',
    parent: 'holders',
    name: { ru: 'Ножницы и ножи', en: 'Scissors and knives' },
    order: 19,
  },
  {
    id: 'holders/clamps',
    parent: 'holders',
    name: { ru: 'Струбцины', en: 'Clamp holders' },
    order: 20,
  },
  {
    id: 'holders/small-parts',
    parent: 'holders',
    name: { ru: 'Биты и мелочь', en: 'Bits and small parts' },
    order: 21,
  },
  {
    id: 'holders/other',
    parent: 'holders',
    name: { ru: 'Прочие инструменты', en: 'Other tools' },
    order: 22,
  },
  { id: 'hooks', name: { ru: 'Крючки и штыри', en: 'Hooks and pegs' }, order: 30 },
  { id: 'hooks/hooks', parent: 'hooks', name: { ru: 'Крючки', en: 'Hooks' }, order: 31 },
  { id: 'hooks/pegs', parent: 'hooks', name: { ru: 'Штыри', en: 'Pegs' }, order: 32 },
  { id: 'bins', name: { ru: 'Контейнеры', en: 'Bins' }, order: 40 },
  { id: 'bins/boxes', parent: 'bins', name: { ru: 'Коробки', en: 'Boxes' }, order: 41 },
  { id: 'bins/cups', parent: 'bins', name: { ru: 'Стаканы', en: 'Cups' }, order: 42 },
  { id: 'bins/trays', parent: 'bins', name: { ru: 'Лотки', en: 'Trays' }, order: 43 },
  { id: 'shelves', name: { ru: 'Полки', en: 'Shelves' }, order: 50 },
  { id: 'inserts', name: { ru: 'Вставки и крепёж', en: 'Inserts and fasteners' }, order: 60 },
  { id: 'inserts/plugs', parent: 'inserts', name: { ru: 'Вставки', en: 'Inserts' }, order: 61 },
  {
    id: 'inserts/connectors',
    parent: 'inserts',
    name: { ru: 'Соединители', en: 'Connectors' },
    order: 62,
  },
  { id: 'inserts/clips', parent: 'inserts', name: { ru: 'Клипсы', en: 'Clips' }, order: 63 },
  { id: 'accessories', name: { ru: 'Аксессуары', en: 'Accessories' }, order: 70 },
  {
    id: 'accessories/cables',
    parent: 'accessories',
    name: { ru: 'Кабели и катушки', en: 'Cables and spools' },
    order: 71,
  },
  {
    id: 'accessories/electronics',
    parent: 'accessories',
    name: { ru: 'Электроника и карты', en: 'Electronics and cards' },
    order: 72,
  },
  {
    id: 'accessories/household',
    parent: 'accessories',
    name: { ru: 'Быт', en: 'Household' },
    order: 73,
  },
  { id: 'panels', name: { ru: 'Панели стены', en: 'Wall panels' }, order: 80 },
];

const BY_ID = new Map(BANK_CATEGORIES.map((c) => [c.id, c]));

export function getCategory(id: string): BankCategory | undefined {
  return BY_ID.get(id);
}

/** True if `id` is `ancestor` itself or lies below it in the tree. */
export function isInCategory(id: string, ancestor: string): boolean {
  return id === ancestor || id.startsWith(`${ancestor}/`);
}
