/**
 * Contact sheets for visual review: `bun packages/tools/scripts/sheet.ts [classId|family ...] [--out dir]
 * [--lod 1] [--tile 260] [--views front,side,iso]`. One PNG per class with a row per preset (the default
 * first), written to ~/.cache/hsw-editor/proofs/tools/ unless --out is given.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Lod,
  type ViewName,
  VIEWS,
  contactSheet,
  generate,
  listToolClasses,
  presetValues,
} from '../src/index.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const out = flag('out', join(homedir(), '.cache/hsw-editor/proofs/tools'));
const lod = Number(flag('lod', '0')) as Lod;
const tile = Number(flag('tile', '260'));
const views = flag('views', 'front,side,iso')
  .split(',')
  .filter((v): v is ViewName => v in VIEWS);
const names = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
mkdirSync(out, { recursive: true });

const selected = listToolClasses().filter(
  (c) => names.length === 0 || names.includes(c.id) || names.includes(c.family),
);
for (const cls of selected) {
  const rows = cls.presets.map((p) => ({
    label: `${cls.id} / ${p.id}`,
    model: generate(cls.id, presetValues(cls.id, p.id), lod),
  }));
  const file = join(out, `${cls.id}${lod ? '-lod1' : ''}.png`);
  writeFileSync(file, contactSheet(rows, { tile, views, columns: 1 }));
  console.log(file);
}
