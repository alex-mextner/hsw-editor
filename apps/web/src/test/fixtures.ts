import type { BankElement, BankIndex } from '@hsw-editor/bank';
import type { BankState, UnavailableElement } from '@/bank/client.ts';

const HEX64 = '0'.repeat(64);

function asset(path: string) {
  return { path, bytes: 1, sha256: HEX64 };
}

/** A complete, valid-shaped bank element; `patch` overrides any field. */
export function bankElement(id: string, patch: Partial<BankElement> = {}): BankElement {
  const hex = Array.from(id)
    .map((char) => char.charCodeAt(0).toString(16))
    .join('')
    .padEnd(16, '0')
    .slice(0, 16);
  return {
    id,
    name: { ru: `Элемент ${id}`, en: `Element ${id}` },
    category: 'holders',
    tags: { ru: [], en: [] },
    toolClasses: [],
    fitsTool: [],
    footprint: {
      cells: [
        { dCol: 0, dRow2: 0 },
        { dCol: 1, dRow2: 1 },
        { dCol: 0, dRow2: 2 },
      ],
      cols: 2,
      rows: 2,
    },
    bboxMm: { min: { x: -10, y: -20, z: 0 }, max: { x: 30, y: 40, z: 15 } },
    dimsMm: { x: 40, y: 60, z: 15 },
    mounting: { kind: 'hex-plug', cells: [{ dCol: 0, dRow2: 0 }] },
    generated: false,
    assets: {
      lod0: asset(`glb/${hex}.glb`),
      lod1: asset(`glb/${hex}.glb`),
      thumbnail: asset(`thumb/${hex}.webp`),
      triangles: { lod0: 1, lod1: 1 },
    },
    provenance: {
      origin: 'project-original',
      orientation: 'curated',
      geometryHash: HEX64,
      duplicates: [],
    },
    license: { spdx: 'MIT', observed: 'MIT', attribution: 'test', redistributable: true },
    ...patch,
  };
}

/** A bank index around `elements`; `unavailable` mirrors the optional list the server may add. */
export function bankIndex(
  elements: readonly BankElement[],
  options: { readonly hash?: string; readonly unavailable?: readonly UnavailableElement[] } = {},
): BankIndex {
  return {
    version: 1,
    contentHash: options.hash ?? HEX64,
    grid: { colPitchMm: 20, rowPitchMm: 23.094 },
    counts: {
      total: elements.length,
      fromSources: elements.length,
      generated: 0,
      redistributable: elements.length,
    },
    categories: [],
    toolClasses: [],
    elements: [...elements],
    ...(options.unavailable === undefined ? {} : { unavailable: options.unavailable }),
  };
}

export function readyBankState(index: BankIndex): BankState {
  return {
    status: 'ready',
    index,
    byId: new Map(index.elements.map((element) => [element.id, element])),
  };
}
