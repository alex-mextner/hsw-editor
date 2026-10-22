#!/usr/bin/env bun
/**
 * Vendors the MIT-licensed rendering layer of oh-my-pi's `packages/collab-web`
 * (tool renderers, transcript, markdown, format helpers, design tokens) plus the
 * few `packages/utils` modules it needs (marked, marked-list, math-delimiters)
 * into `apps/web/src/features/omp/vendor/`.
 *
 * Why vendor: `@oh-my-pi/collab-web` is a private package and `@oh-my-pi/pi-utils`
 * pulls native binaries, so neither can be an npm dependency. The wire types come
 * from the published `@oh-my-pi/pi-wire` package.
 *
 * Usage:
 *   bun scripts/vendor-omp-render.ts [--source <oh-my-pi checkout>]
 *
 * Source resolution: `--source`, else `$OH_MY_PI_SOURCE`, else a sparse clone under
 * `~/.cache/hsw-editor/oh-my-pi-src` pinned to PINNED_COMMIT. The commit recorded in
 * VENDORED.md is the HEAD of whatever checkout was used.
 *
 * Transformations (everything else is byte-identical to upstream):
 *   1. Import specifiers: `../../lib/client` -> our `render-types.ts`;
 *      `@oh-my-pi/pi-utils/{marked,marked-list,math-delimiters}` -> the copied sources.
 *   2. CSS: every selector is scoped under `.omp-scope` (`:root` / `html` / `body`
 *      become the scope element itself), so vendored stylesheets and design tokens
 *      (`--border`, `--ring`, ...) cannot leak into or collide with the app.
 *      `@keyframes` bodies are untouched; the unnamespaced `rise` animation (defined in
 *      upstream's base.css, which we do not vendor) is renamed `omp-rise` and defined in
 *      `omp-render.css`.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { scopeCss } from './lib/scope-css';

const UPSTREAM_URL = 'https://github.com/can1357/oh-my-pi';
const PINNED_COMMIT = '0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0';
const SCOPE = '.omp-scope';

const repoRoot = resolve(import.meta.dir, '..');
const vendorRoot = join(repoRoot, 'apps/web/src/features/omp/vendor');
const outRoot = join(vendorRoot, 'omp-render');

/** Source path (relative to the oh-my-pi checkout) -> destination (relative to `outRoot`). */
const COPY: readonly (readonly [string, string])[] = [
  ['packages/collab-web/src/tool-render', 'tool-render'],
  ['packages/collab-web/src/components/transcript', 'components/transcript'],
  ['packages/collab-web/src/lib/format.ts', 'lib/format.ts'],
  ['packages/collab-web/src/styles/tokens.css', 'styles/tokens.css'],
  ['packages/utils/src/marked.ts', 'utils/marked.ts'],
  ['packages/utils/src/marked', 'utils/marked'],
  ['packages/utils/src/marked-list.ts', 'utils/marked-list.ts'],
  ['packages/utils/src/math-delimiters.ts', 'utils/math-delimiters.ts'],
];

const SPARSE_PATHS = [
  '/LICENSE',
  '/packages/collab-web/src/',
  '/packages/collab-web/package.json',
  '/packages/utils/src/marked.ts',
  '/packages/utils/src/marked/',
  '/packages/utils/src/marked-list.ts',
  '/packages/utils/src/math-delimiters.ts',
  '/packages/wire/package.json',
  '/packages/utils/package.json',
];

interface Rewrite {
  /** Files (relative to `outRoot`) the rewrite applies to. */
  file: string;
  from: string;
  to: string;
}

/**
 * Exact-string rewrites. Each must match at least once, so upstream drift fails loudly
 * instead of silently leaving an unresolvable import behind.
 */
const REWRITES: readonly Rewrite[] = [
  {
    file: 'components/transcript/Transcript.tsx',
    from: '"../../lib/client"',
    to: '"../../../../render-types"',
  },
  {
    file: 'components/transcript/Markdown.tsx',
    from: '"@oh-my-pi/pi-utils/marked-list"',
    to: '"../../utils/marked-list"',
  },
  {
    file: 'components/transcript/Markdown.tsx',
    from: '"@oh-my-pi/pi-utils/marked"',
    to: '"../../utils/marked"',
  },
  {
    file: 'components/transcript/math.ts',
    from: '"@oh-my-pi/pi-utils/marked"',
    to: '"../../utils/marked"',
  },
  {
    file: 'components/transcript/math.ts',
    from: '"@oh-my-pi/pi-utils/math-delimiters"',
    to: '"../../utils/math-delimiters"',
  },
];

function fail(message: string): never {
  console.error(`vendor-omp-render: ${message}`);
  process.exit(1);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim();
}

function parseSource(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf('--source');
  if (index >= 0) {
    const value = args[index + 1];
    if (!value) fail('--source needs a path');
    return resolve(value);
  }
  const fromEnv = process.env['OH_MY_PI_SOURCE'];
  if (fromEnv) return resolve(fromEnv);
  return ensureSparseClone();
}

function ensureSparseClone(): string {
  const dir = join(homedir(), '.cache/hsw-editor/oh-my-pi-src');
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dirname(dir), { recursive: true });
    execFileSync(
      'git',
      ['clone', '--filter=blob:none', '--no-checkout', '--sparse', UPSTREAM_URL, dir],
      { stdio: 'inherit' },
    );
  }
  git(dir, 'sparse-checkout', 'set', '--no-cone', ...SPARSE_PATHS);
  try {
    git(dir, 'cat-file', '-e', `${PINNED_COMMIT}^{commit}`);
  } catch {
    git(dir, 'fetch', 'origin', PINNED_COMMIT);
  }
  git(dir, 'checkout', '--quiet', '--detach', PINNED_COMMIT);
  return dir;
}

function listFiles(path: string): string[] {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((name) => listFiles(join(path, name)));
}

function readJson(path: string): { name?: string; version?: string } {
  return JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
}

const RISE = /(animation(?:-name)?\s*:[^;{}]*?)(?<![\w-])rise\b/g;

function transformCss(css: string): string {
  const scoped = scopeCss(css, SCOPE).replace(RISE, '$1omp-rise');
  if (/animation(?:-name)?\s*:[^;{}]*?(?<![\w-])rise\b/.test(scoped))
    fail('unrenamed `rise` animation reference');
  return `/* Generated by scripts/vendor-omp-render.ts: selectors scoped under ${SCOPE}. Do not hand-edit. */\n${scoped}`;
}

// ---------------------------------------------------------------------------

function main(): void {
  const source = parseSource();
  if (!existsSync(join(source, 'packages/collab-web/package.json'))) {
    fail(`not an oh-my-pi checkout (no packages/collab-web): ${source}`);
  }
  const commit = git(source, 'rev-parse', 'HEAD');
  const collabWeb = readJson(join(source, 'packages/collab-web/package.json'));
  const wire = readJson(join(source, 'packages/wire/package.json'));

  const license = readFileSync(join(source, 'LICENSE'), 'utf8').trimEnd();

  rmSync(outRoot, { recursive: true, force: true });
  const rewriteHits = new Map<Rewrite, number>();
  let count = 0;

  for (const [from, to] of COPY) {
    const base = join(source, from);
    if (!existsSync(base)) fail(`missing upstream path: ${from}`);
    for (const file of listFiles(base)) {
      const rel = join(to, relative(base, file));
      let text = readFileSync(file, 'utf8');
      if (rel.endsWith('.css')) {
        text = transformCss(text);
      } else {
        for (const rewrite of REWRITES) {
          if (rewrite.file !== rel || !text.includes(rewrite.from)) continue;
          text = text.split(rewrite.from).join(rewrite.to);
          rewriteHits.set(rewrite, (rewriteHits.get(rewrite) ?? 0) + 1);
        }
      }
      const dest = join(outRoot, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text);
      count++;
    }
  }
  for (const rewrite of REWRITES) {
    if (!rewriteHits.has(rewrite)) fail(`rewrite did not match: ${rewrite.file} ${rewrite.from}`);
  }

  writeFileSync(
    join(vendorRoot, 'NOTICE'),
    [
      'The files under omp-render/ are copied from oh-my-pi',
      `(${UPSTREAM_URL}, commit ${commit}) and are`,
      'used under the MIT License reproduced below.',
      '',
      license,
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(vendorRoot, 'VENDORED.md'),
    [
      '# Vendored from oh-my-pi',
      '',
      '**Do not hand-edit `omp-render/`, `NOTICE` or this file.** Regenerate with:',
      '',
      '```sh',
      'bun run vendor:omp-render            # or: bun scripts/vendor-omp-render.ts [--source <oh-my-pi checkout>]',
      '```',
      '',
      `- Upstream: ${UPSTREAM_URL}`,
      `- Commit: \`${commit}\``,
      `- Packages: \`packages/collab-web\` (${collabWeb.name} ${collabWeb.version}), \`packages/utils/src\` (marked, marked-list, math-delimiters)`,
      `- Wire types: the published \`${wire.name}@${wire.version}\` (an npm dependency, not vendored)`,
      '- License: MIT, see `NOTICE` (also listed in the repository `THIRD_PARTY_NOTICES.md`)',
      '',
      'The source checkout is `--source`, else `$OH_MY_PI_SOURCE`, else a sparse clone pinned to the commit above under',
      '`~/.cache/hsw-editor/oh-my-pi-src`.',
      '',
      '## Layout',
      '',
      '| Path | Upstream |',
      '| --- | --- |',
      ...COPY.map(([from, to]) => `| \`omp-render/${to}\` | \`${from}\` |`),
      '',
      'Hand-written, not generated: `index.ts` (barrel), `../render-types.ts`, `../omp-render.css` (token bridge).',
      '',
      '## Transformations',
      '',
      'Everything is byte-identical to upstream except:',
      '',
      '1. Import specifiers: `../../lib/client` -> `render-types.ts` (ours); `@oh-my-pi/pi-utils/{marked,marked-list,math-delimiters}` -> the copied `omp-render/utils/*`',
      `   (\`@oh-my-pi/pi-utils\` is not a dependency: it pulls native binaries).`,
      `2. CSS (\`*.css\`): selectors are scoped under \`${SCOPE}\`; \`:root\`/\`html\`/\`body\` become the scope element; \`animation: rise\` -> \`omp-rise\`.`,
      '   Render inside `<div class="omp-scope">` and import `../omp-render.css` for the token bridge.',
      '',
      '## Type checking',
      '',
      'Upstream compiles without `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`, which this repo enables.',
      'See `apps/web/tsconfig.json` (vendor excluded) and `apps/web/tsconfig.omp-vendor.json`.',
      '',
    ].join('\n'),
  );

  console.log(`vendored ${count} files from ${UPSTREAM_URL}@${commit.slice(0, 10)}`);
}

main();
