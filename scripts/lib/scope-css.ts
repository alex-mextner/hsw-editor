/**
 * Minimal CSS rule scoper for scripts/vendor-omp-render.ts: prefixes every style-rule
 * selector with a scope class. Handles comments, strings, nested @media/@supports/@layer/
 * @container, and leaves other at-rules (@keyframes, @font-face, ...) untouched. Native CSS
 * nesting is rejected rather than guessed at.
 */

// ---------------------------------------------------------------------------

/** Index just past the end of the comment that starts at `start`. */
function commentEnd(css: string, start: number): number {
  const close = css.indexOf('*/', start + 2);
  return close < 0 ? failCss('unterminated comment') : close + 2;
}

/** Index of the end of a `"..."`/`'...'` string starting at `start`. */
function skipString(css: string, start: number): number {
  const quote = css[start];
  let i = start + 1;
  while (i < css.length && css[i] !== quote) i += css[i] === '\\' ? 2 : 1;
  return i + 1;
}

/** Index just past the `}` matching the `{` at `open`. */
function matchingBrace(css: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      i = skipString(css, i);
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      i = commentEnd(css, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
    i++;
  }
  return failCss('unbalanced braces in CSS');
}

/** Split a selector list on top-level commas. */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '"' || ch === "'") i = skipString(list, i) - 1;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function scopeSelector(scope: string, selector: string): string[] {
  const root = /^(?::root|html|body)(?![\w-])/.exec(selector);
  if (root) return [scope + selector.slice(root[0].length)];
  // `[data-theme="light"]` on <html>: the attribute may sit on the scope element
  // itself or on any ancestor of it.
  if (selector.startsWith('[data-theme')) return [`${scope}${selector}`, `${selector} ${scope}`];
  return [`${scope} ${selector}`];
}

export function scopeCss(css: string, scope: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const rest = css.slice(i);
    const ws = /^\s+/.exec(rest);
    if (ws) {
      out += ws[0];
      i += ws[0].length;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = commentEnd(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    let j = i;
    while (j < css.length && css[j] !== '{' && css[j] !== ';') {
      j = css[j] === '"' || css[j] === "'" ? skipString(css, j) : j + 1;
    }
    if (j >= css.length) failCss(`dangling CSS: ${css.slice(i, i + 60)}`);
    const prelude = css.slice(i, j);
    if (css[j] === ';') {
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const end = matchingBrace(css, j);
    const body = css.slice(j + 1, end - 1);
    const name = /^@([\w-]+)/.exec(prelude.trim())?.[1];
    if (name === 'media' || name === 'supports' || name === 'layer' || name === 'container') {
      out += `${prelude}{${scopeCss(body, scope)}}`;
    } else if (name !== undefined) {
      out += css.slice(i, end); // @keyframes, @font-face, ...
    } else {
      if (body.includes('{')) failCss(`nested CSS rule under "${prelude.trim()}" is not supported`);
      const selectors = splitSelectors(prelude).flatMap((selector) =>
        scopeSelector(scope, selector),
      );
      out += `${selectors.join(',\n')} {${body}}`;
    }
    i = end;
  }
  return out;
}

function failCss(message: string): never {
  throw new Error(`scope-css: ${message}`);
}
