/**
 * Contact sheets: one row per tool variant, columns = views. Each tile fits its own object and is
 * captioned with the class id, the preset, the overall size in mm and the triangle count, so a reviewer
 * can judge shape and size at a glance.
 */
import { type V3, cross, norm, sizeOf } from '../math.ts';
import type { ToolModel } from '../model.ts';
import { type Canvas, blit, drawText, encodePng, newCanvas } from './png.ts';
import { type ViewName, type ViewSpec, VIEWS, render } from './raster.ts';

export interface SheetRow {
  label: string;
  model: ToolModel;
}

export interface SheetOptions {
  tile?: number;
  views?: readonly ViewName[];
  columns?: number;
  title?: string;
}

/** Same camera, image rotated so the tool's axis (+Y) runs left to right (tip right). */
export function landscape(view: ViewSpec): ViewSpec {
  const back = norm(view.eye);
  const right = norm(cross(view.up, back));
  const up: V3 = [-right[0], -right[1], -right[2]];
  return { eye: view.eye, up };
}

export function renderTile(
  model: ToolModel,
  view: ViewName,
  width: number,
  height: number,
): Canvas {
  const spec = height / width < 0.8 ? landscape(VIEWS[view]) : VIEWS[view];
  const r = render(model, { width, height, view: spec, ssaa: 2, margin: 0.07 });
  return { width: r.width, height: r.height, rgba: r.rgba };
}

/** Close-up of the working end (last max(24 mm, 16 %) of the axis) in a three-quarter view. */
export function renderDetail(model: ToolModel, size: number): Canvas {
  const [, ymin] = model.bounds.min;
  const ymax = model.bounds.max[1];
  const window = Math.max(24, (ymax - ymin) * 0.16);
  const c: V3 = [
    (model.bounds.min[0] + model.bounds.max[0]) / 2,
    ymax - window * 0.4,
    (model.bounds.min[2] + model.bounds.max[2]) / 2,
  ];
  const r = render(model, {
    width: size,
    height: size,
    view: VIEWS.iso,
    ssaa: 2,
    center: c,
    pixelsPerMm: (size * 0.9) / window,
  });
  return { width: r.width, height: r.height, rgba: r.rgba };
}

/**
 * Rows of `views.length` tiles (+ a working-end close-up) each, laid out in `columns` blocks side by side.
 * Tools more than 2.2x longer than wide are drawn lying down (tip right) in wide tiles.
 */
export function contactSheet(rows: readonly SheetRow[], options: SheetOptions = {}): Uint8Array {
  const tile = options.tile ?? 260;
  const views = options.views ?? (['front', 'side', 'iso'] as const);
  const blocks = Math.max(1, options.columns ?? 1);
  const perBlock = Math.ceil(rows.length / blocks);
  const labelH = 28;
  const tall = rows.some((r) => {
    const [w, h] = sizeOf(r.model.bounds);
    return h / Math.max(w, 1e-6) > 2.2;
  });
  const tw = tall ? Math.round(tile * 1.8) : tile;
  const th = tall ? Math.round(tile * 0.8) : tile;
  const blockW = tw * views.length + th + 8;
  const rowH = th + labelH;
  const titleH = options.title ? 26 : 0;
  const canvas = newCanvas(blockW * blocks, perBlock * rowH + titleH, [226, 230, 236]);
  if (options.title) drawText(canvas, options.title, 8, 6, [20, 24, 30], 1);
  rows.forEach((row, i) => {
    const block = Math.floor(i / perBlock);
    const idx = i % perBlock;
    const x0 = block * blockW;
    const y0 = titleH + idx * rowH;
    const [w, h, d] = sizeOf(row.model.bounds);
    drawText(canvas, row.label, x0 + 6, y0 + 3, [20, 24, 30]);
    drawText(
      canvas,
      `${w.toFixed(0)}x${h.toFixed(0)}x${d.toFixed(0)} mm  ${row.model.parts.length} parts  ${row.model.triangles} tris`,
      x0 + 6,
      y0 + 15,
      [90, 98, 110],
    );
    views.forEach((v, k) => {
      blit(canvas, renderTile(row.model, v, tw, th), x0 + k * tw, y0 + labelH);
    });
    blit(canvas, renderDetail(row.model, th), x0 + views.length * tw, y0 + labelH);
  });
  return encodePng(canvas.rgba, canvas.width, canvas.height);
}
