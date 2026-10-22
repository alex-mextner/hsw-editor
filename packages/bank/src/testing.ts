import { BANK_CATEGORIES } from './categories.ts';
import type { BankElement, BankIndex, FitsTool } from './schema.ts';
import { TOOL_CLASSES } from './toolClasses.ts';

const ZERO_HASH = '0'.repeat(64);

export interface ElementSpec {
  id: string;
  ru: string;
  en: string;
  category: string;
  tagsRu?: string[];
  tagsEn?: string[];
  toolClasses?: string[];
  dims?: [number, number, number];
  generated?: boolean;
  family?: string;
  redistributable?: boolean;
  geometryHash?: string;
  fitsTool?: FitsTool[];
}

function hashOf(spec: ElementSpec): string {
  if (spec.geometryHash) return spec.geometryHash;
  let hex = '';
  for (const ch of spec.id) hex += ch.charCodeAt(0).toString(16).padStart(2, '0');
  return hex.padEnd(64, '0').slice(0, 64);
}

/** Test fixture builder for Bank elements; only the fields a test cares about need to be given. */
export function makeElement(spec: ElementSpec): BankElement {
  const [x, y, z] = spec.dims ?? [40, 30, 20];
  const generated = spec.generated ?? false;
  return {
    id: spec.id,
    name: { ru: spec.ru, en: spec.en },
    category: spec.category,
    tags: { ru: spec.tagsRu ?? [], en: spec.tagsEn ?? [] },
    toolClasses: spec.toolClasses ?? [],
    fitsTool: spec.fitsTool ?? (spec.toolClasses ?? []).map((toolClass) => ({ toolClass })),
    footprint: { cells: [{ dCol: 0, dRow2: 0 }], cols: 1, rows: 1 },
    bboxMm: { min: { x: -x / 2, y: -y / 2, z: 0 }, max: { x: x / 2, y: y / 2, z } },
    dimsMm: { x, y, z },
    mounting: { kind: 'hex-plug', cells: [{ dCol: 0, dRow2: 0 }] },
    ...(spec.family ? { family: spec.family } : {}),
    generated,
    assets: {
      lod0: { path: 'glb/0000000000000000.glb', bytes: 1000, sha256: ZERO_HASH },
      lod1: { path: 'glb/0000000000000000.glb', bytes: 1000, sha256: ZERO_HASH },
      thumbnail: { path: 'thumb/0000000000000000.webp', bytes: 1000, sha256: ZERO_HASH },
      triangles: { lod0: 100, lod1: 100 },
    },
    provenance: generated
      ? {
          origin: 'generated',
          orientation: 'generator',
          generator: { generator: 'families.scad', part: 'x', version: 1, values: {} },
          geometryHash: hashOf(spec),
          duplicates: [],
        }
      : {
          origin: 'source-file',
          orientation: 'auto',
          source: { site: 'hsw-project', file: `${spec.id}.stl`, sourceSha256: ZERO_HASH },
          geometryHash: hashOf(spec),
          duplicates: [],
        },
    license: {
      spdx: spec.redistributable === false ? 'CC-BY-NC-4.0' : 'CC-BY-4.0',
      observed: 'test',
      attribution: 'test',
      redistributable: spec.redistributable ?? true,
    },
  };
}

export function makeIndex(elements: BankElement[]): BankIndex {
  const generated = elements.filter((e) => e.generated).length;
  return {
    version: 1,
    contentHash: ZERO_HASH,
    grid: { colPitchMm: 20.4382, rowPitchMm: 23.6 },
    counts: {
      total: elements.length,
      generated,
      fromSources: elements.length - generated,
      redistributable: elements.filter((e) => e.license.redistributable).length,
    },
    categories: [...BANK_CATEGORIES],
    toolClasses: [...TOOL_CLASSES],
    elements,
  };
}
