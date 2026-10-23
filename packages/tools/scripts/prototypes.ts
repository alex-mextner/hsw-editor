/**
 * Render per-class visual prototypes for recognition: every class x preset x colour variant x several views,
 * on the CLIP letterbox grey of masked photo crops. Output (default `$HSW_EDITOR_HOME/tools-prototypes`, the directory
 * the daemon loads):
 * `img/*.png`, `manifest.json` ([{ file, classId, preset, variant, view }]) and `classes.json` (text prompts).
 *
 *   bun packages/tools/scripts/prototypes.ts [--out DIR] [--size 224] [--classes a,b] [--variants 2]
 * Embeddings: `scripts/py/embed_prototypes.py` (sidecar CLIP image encoder).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ParamValue,
  TOOL_COLORS,
  generate,
  listToolClasses,
  presetValues,
  recognitionCategories,
} from '../src/index.ts';
import { type ViewSpec, VIEWS, encodePng, render } from '../src/render/index.ts';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const home = process.env['HSW_EDITOR_HOME'] ?? join(homedir(), '.local/share/hsw-editor');
const out = flag('out', join(home, 'tools-prototypes'));
const size = Number(flag('size', '224'));
const variants = Number(flag('variants', '2'));
const only = flag('classes', '')
  .split(',')
  .filter((s) => s.length > 0);
mkdirSync(join(out, 'img'), { recursive: true });

/** Photo background of masked crops (CLIP-mean grey used by the sidecar letterbox). */
const BG = '#7c7468';

function rotatedFront(deg: number): ViewSpec {
  const a = (deg * Math.PI) / 180;
  return { eye: [0, 0, 1], up: [-Math.sin(a), Math.cos(a), 0] };
}

const PROTOTYPE_VIEWS: readonly { name: string; spec: ViewSpec }[] = [
  { name: 'top0', spec: rotatedFront(0) },
  { name: 'top40', spec: rotatedFront(40) },
  { name: 'top90', spec: rotatedFront(90) },
  { name: 'top-50', spec: rotatedFront(-50) },
  { name: 'iso', spec: VIEWS.iso },
  { name: 'iso2', spec: VIEWS.iso2 },
  { name: 'iso3', spec: VIEWS.iso3 },
  { name: 'side', spec: VIEWS.side },
];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const palette = Object.values(TOOL_COLORS);
const manifest: { file: string; classId: string; preset: string; variant: number; view: string }[] =
  [];

for (const cls of listToolClasses()) {
  if (only.length > 0 && !only.includes(cls.id)) continue;
  for (const preset of cls.presets) {
    for (let variant = 0; variant < variants; variant++) {
      const values: Record<string, ParamValue> = { ...presetValues(cls.id, preset.id) };
      if (variant > 0) {
        const r = rng(variant * 7919 + cls.id.length * 131 + preset.id.length);
        for (const [key, spec] of Object.entries(cls.schema)) {
          if (spec.kind === 'color') {
            values[key] = palette[Math.floor(r() * palette.length)] ?? spec.def;
          }
        }
      }
      const model = generate(cls.id, values, 1);
      for (const v of PROTOTYPE_VIEWS) {
        const r = render(model, {
          width: size,
          height: size,
          view: v.spec,
          ssaa: 2,
          margin: 0.09,
          background: BG,
        });
        const file = `${cls.id}__${preset.id}__v${variant}__${v.name}.png`;
        writeFileSync(join(out, 'img', file), encodePng(r.rgba, r.width, r.height));
        manifest.push({ file, classId: cls.id, preset: preset.id, variant, view: v.name });
      }
    }
  }
  console.log(cls.id);
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
writeFileSync(join(out, 'classes.json'), JSON.stringify(recognitionCategories(), null, 1));
console.log(`${manifest.length} prototype images -> ${out}`);
