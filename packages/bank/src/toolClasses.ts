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
    ['плоскогубцы', 'пассатижи', 'длинногубцы', 'утконосы', 'обжимка', 'клещи'],
    ['pliers', 'long nose pliers', 'crimper', 'stripper'],
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
    ['нож', 'канцелярский нож', 'стамеска'],
    ['knife', 'utility knife', 'box cutter', 'chisel'],
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
  tc('saw', 'Ножовка', 'Saw', ['ножовка', 'пила', 'лобзик'], ['saw', 'hand saw', 'hacksaw']),
  tc('brush', 'Кисть / щётка', 'Brush', ['кисть', 'щетка', 'щётка'], ['brush', 'paint brush']),
  tc(
    'pen',
    'Ручка / маркер',
    'Pen / marker',
    ['ручка', 'маркер', 'карандаш'],
    ['pen', 'marker', 'pencil'],
  ),
  tc('ruler', 'Линейка', 'Ruler', ['линейка', 'угольник'], ['ruler', 'square', 'straight edge']),
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
  tc(
    'battery-pack',
    'Аккумулятор инструмента',
    'Tool battery pack',
    ['аккумулятор', 'акб'],
    ['battery pack', 'power tool battery'],
  ),
];

function tc(id: string, ru: string, en: string, synRu: string[], synEn: string[]): ToolClass {
  return { id, name: { ru, en }, synonyms: { ru: synRu, en: synEn } };
}

const BY_ID = new Map(TOOL_CLASSES.map((t) => [t.id, t]));
/** The tool classes an index declares; the built-in list when it declares none. */
export function toolClassVocabulary(declared: readonly ToolClass[]): readonly ToolClass[] {
  return declared.length > 0 ? declared : TOOL_CLASSES;
}

export function getToolClass(id: string): ToolClass | undefined {
  return BY_ID.get(id);
}
