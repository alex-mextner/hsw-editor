import type { ToolClass } from './schema.ts';

/**
 * Object classes the bank can hold. The recogniser maps its detector labels onto these ids; the
 * fitter picks bank elements whose `fitsTool` lists the class and whose dims range contains the object.
 */
export const TOOL_CLASSES: readonly ToolClass[] = [
  tc(
    'screwdriver',
    'Отвёртка',
    'Screwdriver',
    ['отвертка', 'отвёртка', 'отвертки'],
    ['screwdriver', 'driver', 'phillips', 'flathead'],
  ),
  tc(
    'pliers',
    'Плоскогубцы',
    'Pliers',
    ['плоскогубцы', 'пассатижи', 'клещи'],
    ['pliers', 'combination pliers'],
  ),
  tc(
    'snips',
    'Кусачки',
    'Snips and cutters',
    ['кусачки', 'бокорезы', 'ножницы по металлу'],
    ['snips', 'side cutters', 'wire cutters', 'nippers'],
  ),
  tc(
    'wrench',
    'Гаечный ключ',
    'Wrench',
    ['ключ', 'гаечный ключ', 'разводной ключ', 'рожковый ключ'],
    ['wrench', 'spanner', 'adjustable wrench'],
  ),
  tc(
    'hex-key',
    'Шестигранник',
    'Hex key',
    ['шестигранник', 'имбусовый ключ', 'г-образный ключ'],
    ['hex key', 'allen key', 'allen wrench'],
  ),
  tc(
    'drill',
    'Дрель / шуруповёрт',
    'Drill / driver',
    ['дрель', 'шуруповерт', 'шуруповёрт', 'перфоратор'],
    ['drill', 'cordless drill', 'driver drill', 'impact driver'],
  ),
  tc(
    'caliper',
    'Штангенциркуль',
    'Caliper',
    ['штангенциркуль', 'штангель', 'суппорт'],
    ['caliper', 'calipers', 'vernier'],
  ),
  tc('tape-measure', 'Рулетка', 'Tape measure', ['рулетка'], ['tape measure', 'measuring tape']),
  tc(
    'tape-roll',
    'Скотч / изолента',
    'Tape roll',
    ['скотч', 'изолента', 'лента', 'малярная лента', 'рулон'],
    ['tape', 'tape roll', 'duct tape', 'masking tape', 'electrical tape'],
  ),
  tc('hammer', 'Молоток', 'Hammer', ['молоток', 'киянка', 'кувалда'], ['hammer', 'mallet']),
  tc('scissors', 'Ножницы', 'Scissors', ['ножницы'], ['scissors', 'shears']),
  tc(
    'knife',
    'Нож',
    'Utility knife',
    ['нож', 'канцелярский нож'],
    ['knife', 'utility knife', 'box cutter'],
  ),
  tc(
    'clamp',
    'Струбцина',
    'Clamp',
    ['струбцина', 'зажим', 'прищепка'],
    ['clamp', 'spring clamp', 'c-clamp'],
  ),
  tc(
    'bit-set',
    'Набор бит',
    'Bit set',
    ['биты', 'набор бит', 'насадки'],
    ['bits', 'bit set', 'bit case', 'driver bits'],
  ),
  tc(
    'multimeter',
    'Мультиметр',
    'Multimeter',
    ['мультиметр', 'тестер'],
    ['multimeter', 'meter', 'tester'],
  ),
  tc(
    'file',
    'Напильник',
    'File / rasp',
    ['напильник', 'надфиль', 'рашпиль'],
    ['file', 'rasp', 'needle file'],
  ),
  tc('saw', 'Ножовка', 'Saw', ['ножовка', 'пила', 'лобзик'], ['saw', 'hand saw']),
  tc('brush', 'Кисть / щётка', 'Brush', ['кисть', 'щетка', 'щётка'], ['brush', 'paint brush']),
  tc(
    'pen',
    'Ручка / маркер',
    'Pen / marker',
    ['ручка', 'маркер', 'карандаш'],
    ['pen', 'marker', 'pencil'],
  ),
  tc('ruler', 'Линейка', 'Ruler', ['линейка'], ['ruler', 'straight edge']),
  tc(
    'spool',
    'Катушка',
    'Spool',
    ['катушка', 'бобина', 'моток'],
    ['spool', 'reel', 'filament spool', 'wire spool'],
  ),
  tc('cable', 'Кабель', 'Cable', ['кабель', 'провод', 'шнур'], ['cable', 'wire', 'cord']),
  tc(
    'usb-stick',
    'USB-флешка',
    'USB stick',
    ['флешка', 'юсб', 'usb'],
    ['usb stick', 'flash drive', 'usb'],
  ),
  tc(
    'sd-card',
    'SD-карта',
    'SD card',
    ['сд карта', 'карта памяти', 'microsd'],
    ['sd card', 'micro sd', 'memory card'],
  ),
  tc(
    'spray-can',
    'Баллончик',
    'Spray can',
    ['баллончик', 'аэрозоль', 'смазка'],
    ['spray can', 'aerosol', 'lubricant'],
  ),
  tc('toothbrush', 'Зубная щётка', 'Toothbrush', ['зубная щетка', 'зубная щётка'], ['toothbrush']),
  tc(
    'screws',
    'Крепёж',
    'Screws and small parts',
    ['саморез', 'винт', 'крепеж', 'шуруп', 'мелочь'],
    ['screws', 'fasteners', 'small parts'],
  ),
  // Tool-library classes that had no honest home among the classes above (each has its own holder shape).
  tc(
    'nut-driver',
    'Торцевая отвёртка',
    'Nut driver',
    ['торцевая отвертка', 'ключ-отвертка'],
    ['nut driver'],
  ),
  tc(
    'socket',
    'Торцевая головка',
    'Socket',
    ['торцевая головка', 'сокет'],
    ['socket', 'impact socket'],
  ),
  tc(
    'ratchet',
    'Трещотка',
    'Ratchet',
    ['трещотка', 'трещоточный ключ'],
    ['ratchet', 'ratchet handle', 'socket wrench'],
  ),
  tc('drill-bit', 'Сверло', 'Drill bit', ['сверло', 'сверла'], ['drill bit', 'twist drill']),
  tc(
    'drill-bit-case',
    'Набор свёрл',
    'Drill bit case',
    ['набор сверл', 'кассета со сверлами'],
    ['drill bit case', 'drill bit set', 'drill index'],
  ),
  tc(
    'soldering-iron',
    'Паяльник',
    'Soldering iron',
    ['паяльник', 'паяльная станция'],
    ['soldering iron', 'soldering station'],
  ),
  tc('flashlight', 'Фонарик', 'Flashlight', ['фонарик', 'фонарь'], ['flashlight', 'headlamp']),
  tc(
    'glue-gun',
    'Клеевой пистолет',
    'Glue gun',
    ['клеевой пистолет', 'термоклей'],
    ['glue gun', 'hot glue gun'],
  ),
  // Finer classes of the tools above. `broader` names the coarser class they stay compatible with, so a holder
  // that lists only the coarse class (a knife block, a pliers rack) still takes and suggests them.
  tc(
    'chisel',
    'Стамеска',
    'Chisel',
    ['стамеска', 'стамески', 'долото'],
    ['chisel', 'wood chisel', 'cold chisel'],
    'knife',
  ),
  tc(
    'punch',
    'Бородок',
    'Punch',
    ['бородок', 'кернер', 'пробойник'],
    ['punch', 'pin punch', 'center punch'],
    'screwdriver',
  ),
  tc(
    'hacksaw',
    'Ножовка по металлу',
    'Hacksaw',
    ['ножовка по металлу', 'слесарная ножовка'],
    ['hacksaw', 'metal saw'],
    'saw',
  ),
  tc(
    'level',
    'Уровень',
    'Spirit level',
    ['уровень', 'пузырьковый уровень', 'ватерпас'],
    ['level', 'spirit level', 'bubble level'],
    'ruler',
  ),
  tc(
    'square',
    'Угольник',
    'Square',
    ['угольник', 'столярный угольник', 'слесарный угольник'],
    ['square', 'try square', 'combination square'],
    'ruler',
  ),
  tc(
    'long-nose-pliers',
    'Длинногубцы',
    'Long-nose pliers',
    ['длинногубцы', 'утконосы', 'тонкогубцы'],
    ['long nose pliers', 'needle nose pliers'],
    'pliers',
  ),
  tc(
    'locking-pliers',
    'Зажимные плоскогубцы',
    'Locking pliers',
    ['зажимные плоскогубцы', 'самозажимные клещи', 'вайс-грипс'],
    ['locking pliers', 'vise grips', 'vice grips'],
    'pliers',
  ),
  tc(
    'water-pump-pliers',
    'Переставные клещи',
    'Water-pump pliers',
    ['переставные клещи', 'сантехнические клещи'],
    ['water pump pliers', 'slip joint pliers', 'tongue and groove pliers'],
    'pliers',
  ),
  tc(
    'crimper',
    'Обжимные клещи',
    'Crimper / stripper',
    ['обжимка', 'обжимные клещи', 'стриппер'],
    ['crimper', 'crimping pliers', 'wire stripper', 'stripper'],
    'pliers',
  ),
  tc(
    'hex-key-set',
    'Набор шестигранников',
    'Hex key set',
    ['набор шестигранников', 'набор имбусовых ключей'],
    ['hex key set', 'allen key set'],
    'hex-key',
  ),
  tc(
    'battery-pack',
    'Аккумулятор инструмента',
    'Tool battery pack',
    ['аккумулятор', 'акб'],
    ['battery pack', 'power tool battery'],
  ),
];

function tc(
  id: string,
  ru: string,
  en: string,
  synRu: string[],
  synEn: string[],
  broader?: string,
): ToolClass {
  const base: ToolClass = { id, name: { ru, en }, synonyms: { ru: synRu, en: synEn } };
  return broader === undefined ? base : { ...base, broader };
}

const BY_ID = new Map(TOOL_CLASSES.map((t) => [t.id, t]));
type VocabularyEntry = Pick<ToolClass, 'id' | 'broader'>;

/**
 * One rule for every vocabulary lookup, the same as `toolClassVocabulary`: the classes an index declares win,
 * a class it does not declare (an index written before the class existed) comes from the built-in list.
 */
function entryOf(id: string, vocabulary: readonly VocabularyEntry[]): VocabularyEntry | undefined {
  return vocabulary.find((t) => t.id === id) ?? BY_ID.get(id);
}

/** Coarser class ids a tool of `toolClass` also fits (empty when the class has none; links are never chained). */
export function broaderToolClasses(
  toolClass: string,
  vocabulary?: readonly VocabularyEntry[],
): string[] {
  const broader = entryOf(toolClass, vocabulary ?? TOOL_CLASSES)?.broader;
  return broader === undefined ? [] : [broader];
}

/** `toolClass` itself first, then the coarser classes: every class whose holders take a tool of `toolClass`. */
export function acceptedToolClasses(
  toolClass: string,
  vocabulary?: readonly VocabularyEntry[],
): string[] {
  return [toolClass, ...broaderToolClasses(toolClass, vocabulary)];
}

/** The classes plus the coarser classes they refine, deduplicated, in first-seen order. */
export function expandToolClasses(
  classes: readonly string[],
  vocabulary?: readonly VocabularyEntry[],
): string[] {
  return [...new Set(classes.flatMap((id) => acceptedToolClasses(id, vocabulary)))];
}

/**
 * The finer classes by the coarse class they refine (`knife` -> [`chisel`]): what a holder of that class also
 * holds. Built once per vocabulary, not per element.
 */
export function finerToolClasses(
  declared: readonly ToolClass[],
): ReadonlyMap<string, readonly ToolClass[]> {
  const finer = new Map<string, ToolClass[]>();
  for (const toolClass of toolClassVocabulary(declared)) {
    if (toolClass.broader === undefined) continue;
    const list = finer.get(toolClass.broader) ?? [];
    list.push(toolClass);
    finer.set(toolClass.broader, list);
  }
  return finer;
}

/** Every word that names the class: both names and all synonyms. */
export function toolClassWords(toolClass: ToolClass): string[] {
  return [toolClass.name.ru, toolClass.name.en, ...toolClass.synonyms.ru, ...toolClass.synonyms.en];
}

/**
 * The tool classes an index works with: the ones it declares, then the built-in classes it does not
 * declare. An index that declares none gets the built-in list.
 */
export function toolClassVocabulary(declared: readonly ToolClass[]): readonly ToolClass[] {
  if (declared.length === 0) return TOOL_CLASSES;
  const known = new Set(declared.map((t) => t.id));
  const missing = TOOL_CLASSES.filter((t) => !known.has(t.id));
  return missing.length === 0 ? declared : [...declared, ...missing];
}

export function getToolClass(id: string): ToolClass | undefined {
  return BY_ID.get(id);
}
