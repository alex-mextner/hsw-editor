/**
 * Light ru/en text normalisation for the bank search index. No dictionary: lowercase, ё→е, a short
 * list of Russian inflection endings and English plural/-ing endings are stripped. Prefix matching in
 * the index covers the remaining stem differences (e.g. "отвертка" ~ "отвертки" ~ "отверток").
 */
const RU_ENDINGS = [
  'иями',
  'ями',
  'ами',
  'ого',
  'его',
  'ому',
  'ему',
  'ыми',
  'ими',
  'ией',
  'ой',
  'ей',
  'ий',
  'ый',
  'ов',
  'ев',
  'ах',
  'ях',
  'ом',
  'ем',
  'ам',
  'ям',
  'ую',
  'юю',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ых',
  'их',
  'ок',
  'ек',
  'а',
  'я',
  'ы',
  'и',
  'у',
  'ю',
  'е',
  'о',
  'ь',
  'й',
].sort((a, b) => b.length - a.length);

const STOP_WORDS = new Set([
  'для',
  'и',
  'на',
  'под',
  'с',
  'со',
  'в',
  'во',
  'по',
  'из',
  'к',
  'от',
  'или',
  'for',
  'the',
  'and',
  'of',
  'a',
  'an',
  'to',
  'with',
  'on',
  'in',
  'or',
  'hsw',
]);

const CYRILLIC = /[\u0400-\u04ff]/;

export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/й/g, '\uE000') // keep й: NFKD would split off its breve and turn it into и
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\uE000/g, 'й');
}

function stemRussian(word: string): string {
  for (const ending of RU_ENDINGS) {
    if (word.length - ending.length >= 4 && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

function stemEnglish(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Normalises and stems one token; returns null for stop words. */
export function stemTerm(raw: string): string | null {
  const word = normalizeText(raw);
  if (word.length === 0 || STOP_WORDS.has(word)) return null;
  return CYRILLIC.test(word) ? stemRussian(word) : stemEnglish(word);
}

/** Splits on everything that is not a letter or digit; digits stay attached ("m3", "6x8"). */
export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}
