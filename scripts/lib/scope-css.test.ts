import { describe, expect, test } from 'bun:test';
import { scopeCss } from './scope-css';

const S = '.s';

describe('scopeCss', () => {
  test('prefixes plain selectors and every member of a list', () => {
    expect(scopeCss('.a, .b > c { color: red; }', S)).toBe('.s .a,\n.s .b > c { color: red; }');
  });

  test('turns :root / html / body into the scope element', () => {
    expect(scopeCss(':root { --x: 1; }', S)).toBe('.s { --x: 1; }');
    expect(scopeCss(':root:not([data-theme]) { --x: 1; }', S)).toBe(
      '.s:not([data-theme]) { --x: 1; }',
    );
    expect(scopeCss('body { margin: 0; }', S)).toBe('.s { margin: 0; }');
    expect(scopeCss('html.dark .a { margin: 0; }', S)).toBe('.s.dark .a { margin: 0; }');
  });

  test('lets [data-theme] sit on the scope element or an ancestor', () => {
    expect(scopeCss('[data-theme="light"] { --x: 1; }', S)).toBe(
      '.s[data-theme="light"],\n[data-theme="light"] .s { --x: 1; }',
    );
  });

  test('recurses into @media but leaves @keyframes alone', () => {
    const css =
      '@media (max-width: 1px) { .a { top: 0; } }\n@keyframes k { from { top: 0; } to { top: 1px; } }';
    expect(scopeCss(css, S)).toBe(
      '@media (max-width: 1px) { .s .a { top: 0; } }\n@keyframes k { from { top: 0; } to { top: 1px; } }',
    );
  });

  test('ignores commas and braces inside strings, attribute selectors and comments', () => {
    expect(scopeCss('a[title="x, {y}"] { content: "}"; } /* .c { } */', S)).toBe(
      '.s a[title="x, {y}"] { content: "}"; } /* .c { } */',
    );
    expect(scopeCss(':is(.a, .b) { top: 0; }', S)).toBe('.s :is(.a, .b) { top: 0; }');
  });

  test('rejects native nesting instead of mis-scoping it', () => {
    expect(() => scopeCss('.a { .b { top: 0; } }', S)).toThrow('nested CSS rule');
  });

  test('keeps a comment between selector and block inside the rule prelude', () => {
    expect(scopeCss('.a /* ; */ { top: 0; }', S)).toBe('.s .a /* ; */ { top: 0; }');
  });

  test('fails loudly on an unterminated comment', () => {
    expect(() => scopeCss('.a { top: 0; } /* oops', S)).toThrow('unterminated comment');
    expect(() => scopeCss('.a { top: /* oops', S)).toThrow('unterminated comment');
  });

  test('passes statement at-rules through', () => {
    expect(scopeCss('@import "x.css";\n.a { top: 0; }', S)).toBe(
      '@import "x.css";\n.s .a { top: 0; }',
    );
  });
});
