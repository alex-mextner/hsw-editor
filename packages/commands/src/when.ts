/**
 * When-clauses: a tiny boolean language over context keys deciding whether a command or a key
 * binding is active (`selection && !inputFocus`, `mode == 'photo' || dialog`).
 *
 * Grammar:
 *   expr    := or
 *   or      := and ('||' and)*
 *   and     := unary ('&&' unary)*
 *   unary   := '!' unary | primary
 *   primary := '(' expr ')' | key (('==' | '!=') literal)?
 *   literal := 'quoted' | "quoted" | bare-word | number
 *
 * Besides evaluation this module decides whether two clauses can hold at the same time, which the
 * keymap uses to tell a real key conflict from two bindings that never compete.
 */

export type ContextValue = boolean | number | string | undefined;
export type Context = Readonly<Record<string, ContextValue>>;

export type WhenExpr =
  | { readonly t: 'key'; readonly key: string }
  | { readonly t: 'eq'; readonly key: string; readonly value: string; readonly negated: boolean }
  | { readonly t: 'not'; readonly operand: WhenExpr }
  | { readonly t: 'and'; readonly left: WhenExpr; readonly right: WhenExpr }
  | { readonly t: 'or'; readonly left: WhenExpr; readonly right: WhenExpr };

export type WhenParseResult =
  | { readonly ok: true; readonly expr: WhenExpr }
  | { readonly ok: false; readonly error: string };

type Token =
  | { readonly t: 'word'; readonly text: string }
  | { readonly t: 'string'; readonly text: string }
  | { readonly t: 'op'; readonly text: '!' | '&&' | '||' | '(' | ')' | '==' | '!=' };

const WORD_CHAR = /[\w.:-]/;

function tokenize(source: string): readonly Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '==' || two === '!=') {
      tokens.push({ t: 'op', text: two });
      i += 2;
      continue;
    }
    if (ch === '!' || ch === '(' || ch === ')') {
      tokens.push({ t: 'op', text: ch });
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) return `unterminated string at ${i}`;
      tokens.push({ t: 'string', text: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      let end = i;
      while (end < source.length && WORD_CHAR.test(source.charAt(end))) end += 1;
      tokens.push({ t: 'word', text: source.slice(i, end) });
      i = end;
      continue;
    }
    return `unexpected '${ch}' at ${i}`;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  parse(): WhenExpr | string {
    const expr = this.or();
    if (typeof expr === 'string') return expr;
    if (this.pos < this.tokens.length) return `unexpected token ${describe(this.peek())}`;
    return expr;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private isOp(text: string): boolean {
    const token = this.peek();
    return token?.t === 'op' && token.text === text;
  }

  private or(): WhenExpr | string {
    let left = this.and();
    while (typeof left !== 'string' && this.isOp('||')) {
      this.pos += 1;
      const right = this.and();
      if (typeof right === 'string') return right;
      left = { t: 'or', left, right };
    }
    return left;
  }

  private and(): WhenExpr | string {
    let left = this.unary();
    while (typeof left !== 'string' && this.isOp('&&')) {
      this.pos += 1;
      const right = this.unary();
      if (typeof right === 'string') return right;
      left = { t: 'and', left, right };
    }
    return left;
  }

  private unary(): WhenExpr | string {
    if (this.isOp('!')) {
      this.pos += 1;
      const operand = this.unary();
      return typeof operand === 'string' ? operand : { t: 'not', operand };
    }
    return this.primary();
  }

  private primary(): WhenExpr | string {
    const token = this.peek();
    if (token === undefined) return 'unexpected end of expression';
    if (token.t === 'op' && token.text === '(') {
      this.pos += 1;
      const inner = this.or();
      if (typeof inner === 'string') return inner;
      if (!this.isOp(')')) return "missing ')'";
      this.pos += 1;
      return inner;
    }
    if (token.t !== 'word') return `unexpected token ${describe(token)}`;
    this.pos += 1;
    const next = this.peek();
    if (next?.t === 'op' && (next.text === '==' || next.text === '!=')) {
      this.pos += 1;
      const literal = this.peek();
      if (literal === undefined || literal.t === 'op') return `missing value after ${next.text}`;
      this.pos += 1;
      return { t: 'eq', key: token.text, value: literal.text, negated: next.text === '!=' };
    }
    return { t: 'key', key: token.text };
  }
}

function describe(token: Token | undefined): string {
  if (token === undefined) return 'end of input';
  return token.t === 'string' ? `"${token.text}"` : `'${token.text}'`;
}

const parseCache = new Map<string, WhenParseResult>();
const PARSE_CACHE_LIMIT = 512;

export function parseWhen(source: string): WhenParseResult {
  const cached = parseCache.get(source);
  if (cached !== undefined) return cached;
  const tokens = tokenize(source);
  let result: WhenParseResult;
  if (typeof tokens === 'string') {
    result = { ok: false, error: tokens };
  } else if (tokens.length === 0) {
    result = { ok: false, error: 'empty when-clause' };
  } else {
    const parsed = new Parser(tokens).parse();
    result = typeof parsed === 'string' ? { ok: false, error: parsed } : { ok: true, expr: parsed };
  }
  if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
  parseCache.set(source, result);
  return result;
}

function truthy(value: ContextValue): boolean {
  return value !== undefined && value !== false && value !== '' && value !== 0;
}

export function evaluateWhen(expr: WhenExpr, context: Context): boolean {
  switch (expr.t) {
    case 'key':
      return truthy(context[expr.key]);
    case 'eq': {
      const value = context[expr.key];
      const equal = value !== undefined && String(value) === expr.value;
      return expr.negated ? !equal : equal;
    }
    case 'not':
      return !evaluateWhen(expr.operand, context);
    case 'and':
      return evaluateWhen(expr.left, context) && evaluateWhen(expr.right, context);
    case 'or':
      return evaluateWhen(expr.left, context) || evaluateWhen(expr.right, context);
  }
}

/**
 * An absent clause is always true. A clause that does not parse is never true: a broken binding
 * must not fire in a context its author did not intend.
 */
export function matchesWhen(source: string | undefined, context: Context): boolean {
  if (source === undefined) return true;
  const parsed = parseWhen(source);
  return parsed.ok && evaluateWhen(parsed.expr, context);
}

export function whenKeys(expr: WhenExpr): ReadonlySet<string> {
  const keys = new Set<string>();
  const visit = (node: WhenExpr): void => {
    switch (node.t) {
      case 'key':
      case 'eq':
        keys.add(node.key);
        return;
      case 'not':
        visit(node.operand);
        return;
      case 'and':
      case 'or':
        visit(node.left);
        visit(node.right);
        return;
    }
  };
  visit(expr);
  return keys;
}

// ---- Overlap analysis ---------------------------------------------------------------------------

type Literal =
  | { readonly kind: 'truthy' | 'falsy'; readonly key: string }
  | { readonly kind: 'eq' | 'neq'; readonly key: string; readonly value: string };

type Conjunction = readonly Literal[];

const MAX_DNF_TERMS = 64;

/** Negation normal form pushed into a list of OR-ed conjunctions; `null` when the form explodes. */
function toDnf(expr: WhenExpr, negate: boolean): readonly Conjunction[] | null {
  switch (expr.t) {
    case 'key':
      return [[{ kind: negate ? 'falsy' : 'truthy', key: expr.key }]];
    case 'eq':
      return [
        [
          {
            kind: expr.negated !== negate ? 'neq' : 'eq',
            key: expr.key,
            value: expr.value,
          },
        ],
      ];
    case 'not':
      return toDnf(expr.operand, !negate);
    case 'and':
    case 'or': {
      const left = toDnf(expr.left, negate);
      const right = toDnf(expr.right, negate);
      if (left === null || right === null) return null;
      const conjunctive = (expr.t === 'and') !== negate;
      if (!conjunctive) {
        return left.length + right.length > MAX_DNF_TERMS ? null : [...left, ...right];
      }
      if (left.length * right.length > MAX_DNF_TERMS) return null;
      return left.flatMap((l) => right.map((r) => [...l, ...r]));
    }
  }
}

/** A conjunction is contradictory only when a key is demanded both true and false, or two values. */
function satisfiable(conjunction: Conjunction): boolean {
  const truthyKeys = new Set<string>();
  const falsyKeys = new Set<string>();
  const equals = new Map<string, string>();
  const notEquals = new Map<string, Set<string>>();
  for (const literal of conjunction) {
    switch (literal.kind) {
      case 'truthy':
        truthyKeys.add(literal.key);
        break;
      case 'falsy':
        falsyKeys.add(literal.key);
        break;
      case 'eq': {
        const previous = equals.get(literal.key);
        if (previous !== undefined && previous !== literal.value) return false;
        equals.set(literal.key, literal.value);
        break;
      }
      case 'neq': {
        const set = notEquals.get(literal.key) ?? new Set<string>();
        set.add(literal.value);
        notEquals.set(literal.key, set);
        break;
      }
    }
  }
  for (const key of truthyKeys) if (falsyKeys.has(key)) return false;
  for (const [key, value] of equals) if (notEquals.get(key)?.has(value) === true) return false;
  return true;
}

/**
 * Whether two clauses can be true in the same context. Errs on the side of "yes": only a proven
 * contradiction (`a` vs `!a`, `m == 'x'` vs `m == 'y'`) reports false, so a real conflict is never
 * hidden.
 */
export function whenMayOverlap(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return true;
  const left = parseWhen(a);
  const right = parseWhen(b);
  if (!left.ok || !right.ok) return true;
  const leftDnf = toDnf(left.expr, false);
  const rightDnf = toDnf(right.expr, false);
  if (leftDnf === null || rightDnf === null) return true;
  return leftDnf.some((l) => rightDnf.some((r) => satisfiable([...l, ...r])));
}
