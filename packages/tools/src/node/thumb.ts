import type { ToolModel } from '../model.ts';
import { encodePng } from '../render/png.ts';
import { VIEWS, render } from '../render/raster.ts';

/** 256 px isometric thumbnail on a transparent background, WebP (Bun's built-in encoder). */
export async function renderThumbWebp(model: ToolModel, size = 256): Promise<Uint8Array> {
  const [sx, sy] = [
    model.bounds.max[0] - model.bounds.min[0],
    model.bounds.max[1] - model.bounds.min[1],
  ];
  // long thin tools are shown from the front, lying down diagonally reads poorly in a square thumbnail
  const view = sy / Math.max(sx, 1e-6) > 3 ? VIEWS.front : VIEWS.iso;
  const r = render(model, {
    width: size,
    height: size,
    view,
    ssaa: 2,
    background: null,
    margin: 0.08,
  });
  const png = encodePng(r.rgba, r.width, r.height);
  return new Bun.Image(png).webp({ quality: 85 }).bytes();
}
