import type { BankElement } from '@hsw-editor/bank';

/**
 * Generated stand-in for a missing thumbnail: the element's honeycomb footprint drawn as hexagons
 * over its bounding box proportions, tinted by a hash of its id. Pure data; `ElementGlyph` renders it.
 */

export interface HexGrid {
  readonly colPitchMm: number;
  readonly rowPitchMm: number;
}

/** A regular flat-top lattice (column pitch 1.5 R, row pitch sqrt(3) R) for when the index is not at hand. */
export const DEFAULT_GRID: HexGrid = { colPitchMm: 20, rowPitchMm: 23.094 };

export interface GlyphRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface GlyphModel {
  /** Always the same square canvas; shapes are scaled to fit it. */
  readonly size: number;
  /** SVG `points` of every footprint cell. */
  readonly hexes: readonly string[];
  /** Outline of the element's bounding box in the wall plane (x right, y up on screen). */
  readonly bbox: GlyphRect;
  /** 0-359, from the id. */
  readonly hue: number;
}

export const GLYPH_SIZE = 100;
const PADDING = 12;

/** FNV-1a: stable across runs and platforms, unlike anything involving Math.random. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

type GlyphSource = Pick<BankElement, 'id' | 'footprint' | 'bboxMm' | 'dimsMm'>;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function glyphModel(element: GlyphSource, grid: HexGrid = DEFAULT_GRID): GlyphModel {
  const radius = grid.rowPitchMm / Math.sqrt(3);
  // Millimetres, y up: cell centre of an offset from the anchor.
  const centres = element.footprint.cells.map((cell) => ({
    x: cell.dCol * grid.colPitchMm,
    y: (cell.dRow2 * grid.rowPitchMm) / 2,
  }));
  const width = Math.max(element.dimsMm.x, 1);
  const height = Math.max(element.dimsMm.y, 1);
  const box = {
    minX: (element.bboxMm.min.x + element.bboxMm.max.x) / 2 - width / 2,
    maxX: (element.bboxMm.min.x + element.bboxMm.max.x) / 2 + width / 2,
    minY: (element.bboxMm.min.y + element.bboxMm.max.y) / 2 - height / 2,
    maxY: (element.bboxMm.min.y + element.bboxMm.max.y) / 2 + height / 2,
  };

  let minX = box.minX;
  let maxX = box.maxX;
  let minY = box.minY;
  let maxY = box.maxY;
  for (const centre of centres) {
    minX = Math.min(minX, centre.x - radius);
    maxX = Math.max(maxX, centre.x + radius);
    minY = Math.min(minY, centre.y - radius);
    maxY = Math.max(maxY, centre.y + radius);
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const scale = (GLYPH_SIZE - 2 * PADDING) / extent;
  const offsetX = (GLYPH_SIZE - (maxX - minX) * scale) / 2;
  const offsetY = (GLYPH_SIZE - (maxY - minY) * scale) / 2;
  // Wall y points up, SVG y points down.
  const toX = (x: number) => round(offsetX + (x - minX) * scale);
  const toY = (y: number) => round(offsetY + (maxY - y) * scale);

  const hexes = centres.map((centre) =>
    Array.from({ length: 6 }, (_, corner) => {
      const angle = (Math.PI / 3) * corner;
      return `${toX(centre.x + radius * Math.cos(angle))},${toY(centre.y + radius * Math.sin(angle))}`;
    }).join(' '),
  );

  return {
    size: GLYPH_SIZE,
    hexes,
    bbox: {
      x: toX(box.minX),
      y: toY(box.maxY),
      width: round((box.maxX - box.minX) * scale),
      height: round((box.maxY - box.minY) * scale),
    },
    hue: hashString(element.id) % 360,
  };
}
