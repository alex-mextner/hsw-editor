/**
 * Query rewriting for bilingual search: a query typed on the wrong keyboard layout ('ыщкеу' is
 * 'sorte' typed on the Russian layout) and transliteration in both directions ('тема' <-> 'tema').
 */

/** Lowercase and ё to е: the form every comparison uses. */
export function foldText(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е');
}

const EN_ROWS = "qwertyuiop[]asdfghjkl;'zxcvbnm,.`";
const RU_ROWS = 'йцукенгшщзхъфывапролджэячсмитьбюё';

function pairMap(from: string, to: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < from.length; i += 1) map.set(from.charAt(i), to.charAt(i));
  return map;
}

const EN_TO_RU = pairMap(EN_ROWS, RU_ROWS);
const RU_TO_EN = pairMap(RU_ROWS, EN_ROWS);

const CYRILLIC = /[а-яё]/;
const LATIN = /[a-z]/;

export function hasCyrillic(text: string): boolean {
  return CYRILLIC.test(text);
}

export function hasLatin(text: string): boolean {
  return LATIN.test(text);
}

/** foldText plus collapsed whitespace: the form of a query. */
export function normalizeText(text: string): string {
  return foldText(text).replace(/\s+/g, ' ').trim();
}

function mapChars(text: string, map: ReadonlyMap<string, string>): string {
  let out = '';
  for (const ch of text) out += map.get(ch) ?? ch;
  return out;
}

/** Re-types a Cyrillic string as if the Latin layout had been active. */
export function ruLayoutToEn(text: string): string {
  return mapChars(text, RU_TO_EN);
}

/** Re-types a Latin string as if the Russian layout had been active. */
export function enLayoutToRu(text: string): string {
  return mapChars(text, EN_TO_RU);
}

const RU_TRANSLIT: ReadonlyMap<string, string> = new Map([
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['ё', 'yo'],
  ['ж', 'zh'],
  ['з', 'z'],
  ['и', 'i'],
  ['й', 'y'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
  ['х', 'h'],
  ['ц', 'ts'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['щ', 'sch'],
  ['ъ', ''],
  ['ы', 'y'],
  ['ь', ''],
  ['э', 'e'],
  ['ю', 'yu'],
  ['я', 'ya'],
]);

/** Cyrillic to Latin by sound, the way people type Russian words in Latin letters. */
export function transliterateRuToEn(text: string): string {
  return mapChars(text, RU_TRANSLIT);
}

/** Longest first so 'shch' wins over 'sh'. 'yo' maps to plain 'е': ё is folded to е before matching. */
const EN_DIGRAPHS: readonly (readonly [string, string])[] = [
  ['shch', 'щ'],
  ['sch', 'щ'],
  ['sh', 'ш'],
  ['ch', 'ч'],
  ['zh', 'ж'],
  ['yu', 'ю'],
  ['ya', 'я'],
  ['yo', 'е'],
  ['ts', 'ц'],
  ['kh', 'х'],
];

const EN_SINGLES: ReadonlyMap<string, string> = new Map([
  ['a', 'а'],
  ['b', 'б'],
  ['c', 'к'],
  ['d', 'д'],
  ['e', 'е'],
  ['f', 'ф'],
  ['g', 'г'],
  ['h', 'х'],
  ['i', 'и'],
  ['j', 'й'],
  ['k', 'к'],
  ['l', 'л'],
  ['m', 'м'],
  ['n', 'н'],
  ['o', 'о'],
  ['p', 'п'],
  ['q', 'к'],
  ['r', 'р'],
  ['s', 'с'],
  ['t', 'т'],
  ['u', 'у'],
  ['v', 'в'],
  ['w', 'в'],
  ['x', 'кс'],
  ['y', 'ы'],
  ['z', 'з'],
]);

/** Latin to Cyrillic by sound ('tema' to 'тема'), longest digraph first. */
export function transliterateEnToRu(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const digraph = EN_DIGRAPHS.find(([latin]) => text.startsWith(latin, i));
    if (digraph !== undefined) {
      out += digraph[1];
      i += digraph[0].length;
      continue;
    }
    const ch = text.charAt(i);
    out += EN_SINGLES.get(ch) ?? ch;
    i += 1;
  }
  return out;
}

export type VariantKind = 'original' | 'layout' | 'translit';

export interface QueryVariant {
  readonly text: string;
  readonly kind: VariantKind;
}

/**
 * The query as typed plus every plausible reading of it. Only letters decide which rewrites
 * apply: a Cyrillic query may be Latin typed on the wrong layout or Russian words to transliterate;
 * a Latin query may be Russian typed on the wrong layout or Russian transliteration.
 */
export function queryVariants(query: string): readonly QueryVariant[] {
  const text = normalizeText(query);
  if (text === '') return [];
  const variants: QueryVariant[] = [{ text, kind: 'original' }];
  const add = (variant: string, kind: VariantKind): void => {
    if (variant !== '' && variant !== text && !variants.some((entry) => entry.text === variant)) {
      variants.push({ text: variant, kind });
    }
  };
  if (hasCyrillic(text) && !hasLatin(text)) {
    add(normalizeText(ruLayoutToEn(text)), 'layout');
    add(transliterateRuToEn(text), 'translit');
  } else if (hasLatin(text) && !hasCyrillic(text)) {
    add(normalizeText(enLayoutToRu(text)), 'layout');
    add(normalizeText(transliterateEnToRu(text)), 'translit');
  }
  return variants;
}
