/**
 * fzf-style fuzzy scoring. A query token matches a field when its characters occur in order;
 * matches that start words, follow each other, or sit at the beginning of the field score more,
 * and gaps cost. A multi-word query needs every word to match somewhere in the item.
 *
 * Russian and English are treated alike: the caller passes every language variant of a field,
 * and the query is also tried on the wrong keyboard layout and transliterated (see layout.ts).
 */
import { foldText, type QueryVariant, queryVariants } from './layout.ts';

const SCORE_MATCH = 16;
const BONUS_BOUNDARY = 8;
const BONUS_CAMEL = 6;
const BONUS_DIGIT = 3;
const BONUS_CONSECUTIVE = 4;
const FIRST_CHAR_MULTIPLIER = 2;
const GAP_START = 3;
const GAP_EXTENSION = 1;
export const BONUS_EXACT = 40;
const BONUS_PREFIX = 20;
const LENGTH_PENALTY = 0.25;
const TYPO_PENALTY = 25;
const MIN_TYPO_TOKEN_LENGTH = 4;
const TYPO_MIN_FIELD_WEIGHT = 0.5;
const LAYOUT_PENALTY = 8;
const TRANSLIT_PENALTY = 12;

const NO_MATCH = Number.NEGATIVE_INFINITY;

/** A query with its layout and transliteration readings worked out once, for scoring many items. */
export interface CompiledQuery {
  readonly variants: readonly QueryVariant[];
}

export function compileQuery(query: string): CompiledQuery {
  return { variants: queryVariants(query) };
}

export interface SearchField {
  readonly text: string;
  /** Multiplier of this field's score; the display title weighs 1. */
  readonly weight: number;
}

export interface MatchResult {
  readonly score: number;
  /** Matched character indexes in the FIRST field's text, for highlighting. */
  readonly positions: readonly number[];
}

interface TokenMatch {
  readonly score: number;
  readonly positions: readonly number[];
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

function boundaryBonuses(original: readonly string[], folded: readonly string[]): number[] {
  const useCase = original.length === folded.length;
  return folded.map((ch, index) => {
    if (!isWordChar(ch)) return 0;
    const prev = index === 0 ? undefined : (original[index - 1] ?? '');
    if (prev === undefined || !isWordChar(prev)) return BONUS_BOUNDARY;
    const current = useCase ? (original[index] ?? ch) : ch;
    if (current !== current.toLowerCase() && prev === prev.toLowerCase() && !/\d/.test(prev)) {
      return BONUS_CAMEL;
    }
    if (/\d/.test(ch) && !/\d/.test(prev)) return BONUS_DIGIT;
    return 0;
  });
}

function isSubsequence(pattern: readonly string[], text: readonly string[]): boolean {
  let at = 0;
  for (const ch of text) {
    if (ch === pattern[at]) {
      at += 1;
      if (at === pattern.length) return true;
    }
  }
  return pattern.length === 0;
}

/** Best alignment of `pattern` inside `text`; both are already folded. */
function scoreToken(
  pattern: readonly string[],
  text: readonly string[],
  bonus: readonly number[],
): TokenMatch | null {
  const n = pattern.length;
  const m = text.length;
  if (n === 0 || n > m || !isSubsequence(pattern, text)) return null;
  const score = new Float64Array(n * m).fill(NO_MATCH);
  const from = new Int32Array(n * m).fill(-1);
  for (let i = 0; i < n; i += 1) {
    let gapBest = NO_MATCH;
    let gapFrom = -1;
    for (let j = 0; j < m; j += 1) {
      if (i > 0) {
        gapBest -= GAP_EXTENSION;
        if (j >= 2) {
          const candidate = (score[(i - 1) * m + (j - 2)] ?? NO_MATCH) - GAP_START;
          if (candidate > gapBest) {
            gapBest = candidate;
            gapFrom = j - 2;
          }
        }
        // Earlier gap starts were decayed above but remember their origin.
        if (gapBest === NO_MATCH) gapFrom = -1;
      }
      if (text[j] !== pattern[i]) continue;
      const b = bonus[j] ?? 0;
      const index = i * m + j;
      if (i === 0) {
        score[index] = SCORE_MATCH + FIRST_CHAR_MULTIPLIER * b;
        continue;
      }
      const diagonal = j >= 1 ? (score[(i - 1) * m + (j - 1)] ?? NO_MATCH) : NO_MATCH;
      const consecutive =
        diagonal === NO_MATCH ? NO_MATCH : diagonal + Math.max(b, BONUS_CONSECUTIVE);
      const gapped = gapBest === NO_MATCH ? NO_MATCH : gapBest + b;
      if (consecutive === NO_MATCH && gapped === NO_MATCH) continue;
      if (consecutive >= gapped) {
        score[index] = consecutive + SCORE_MATCH;
        from[index] = j - 1;
      } else {
        score[index] = gapped + SCORE_MATCH;
        from[index] = gapFrom;
      }
    }
  }
  let bestEnd = -1;
  let best = NO_MATCH;
  for (let j = 0; j < m; j += 1) {
    const value = score[(n - 1) * m + j] ?? NO_MATCH;
    if (value > best) {
      best = value;
      bestEnd = j;
    }
  }
  if (bestEnd < 0) return null;
  const positions: number[] = [];
  let at = bestEnd;
  for (let i = n - 1; i >= 0; i -= 1) {
    positions.push(at);
    at = from[i * m + at] ?? -1;
  }
  positions.reverse();
  return { score: best, positions };
}

interface PreparedField {
  readonly folded: readonly string[];
  readonly bonus: readonly number[];
  readonly weight: number;
}

function prepare(field: SearchField): PreparedField {
  const original = Array.from(field.text);
  const folded = Array.from(foldText(field.text));
  return { folded, bonus: boundaryBonuses(original, folded), weight: field.weight };
}

function wholeFieldBonus(token: readonly string[], field: PreparedField): number {
  if (token.length === field.folded.length && token.every((ch, i) => ch === field.folded[i])) {
    return BONUS_EXACT;
  }
  if (token.every((ch, i) => ch === field.folded[i])) return BONUS_PREFIX;
  return 0;
}

interface FieldMatch {
  readonly score: number;
  readonly positions: readonly number[];
  /** Index of the field the token matched best. */
  readonly field: number;
}

function matchTokenInFields(
  token: readonly string[],
  fields: readonly PreparedField[],
): FieldMatch | null {
  let best: FieldMatch | null = null;
  for (const [index, field] of fields.entries()) {
    const found = scoreToken(token, field.folded, field.bonus);
    if (found === null) continue;
    const lengthPenalty = (field.folded.length - token.length) * LENGTH_PENALTY;
    const weighted = (found.score + wholeFieldBonus(token, field) - lengthPenalty) * field.weight;
    if (best === null || weighted > best.score) {
      best = { score: weighted, positions: found.positions, field: index };
    }
  }
  return best;
}

/** One deleted character is forgiven on longer tokens ('sorte' still finds 'sort'). */
function matchTokenTolerant(
  token: readonly string[],
  fields: readonly PreparedField[],
): FieldMatch | null {
  if (token.length < MIN_TYPO_TOKEN_LENGTH) return null;
  // Typo tolerance multiplies the work by the token length; weak fields (descriptions) skip it.
  // Filtering keeps the order, so the title stays at index 0.
  const strong = fields.filter((field) => field.weight >= TYPO_MIN_FIELD_WEIGHT);
  let best: FieldMatch | null = null;
  for (let skip = 0; skip < token.length; skip += 1) {
    const reduced = token.filter((_, index) => index !== skip);
    const found = matchTokenInFields(reduced, strong);
    if (found !== null && (best === null || found.score > best.score)) best = found;
  }
  return best === null ? null : { ...best, score: best.score - TYPO_PENALTY };
}

function scoreVariant(variant: QueryVariant, fields: readonly PreparedField[]): MatchResult | null {
  const tokens = variant.text.split(' ').filter((token) => token !== '');
  if (tokens.length === 0) return null;
  let total = 0;
  const positions = new Set<number>();
  for (const token of tokens) {
    const chars = Array.from(token);
    const found = matchTokenInFields(chars, fields) ?? matchTokenTolerant(chars, fields);
    if (found === null) return null;
    total += found.score;
    if (found.field === 0) for (const position of found.positions) positions.add(position);
  }
  const penalty =
    variant.kind === 'layout' ? LAYOUT_PENALTY : variant.kind === 'translit' ? TRANSLIT_PENALTY : 0;
  return { score: total - penalty, positions: [...positions].sort((a, b) => a - b) };
}

/**
 * Scores `query` against an item's fields. `null` means no match. Empty queries match everything
 * with score 0 (the caller then orders by recency).
 */
export function matchQuery(
  query: string | CompiledQuery,
  fields: readonly SearchField[],
): MatchResult | null {
  const variants = typeof query === 'string' ? queryVariants(query) : query.variants;
  if (variants.length === 0) return { score: 0, positions: [] };
  const prepared = fields.map(prepare);
  let best: MatchResult | null = null;
  for (const variant of variants) {
    const result = scoreVariant(variant, prepared);
    if (result !== null && (best === null || result.score > best.score)) best = result;
  }
  return best;
}
