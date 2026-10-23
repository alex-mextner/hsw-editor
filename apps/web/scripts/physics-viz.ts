import { writeFileSync } from 'node:fs';
import type { Mat3, Vec3 } from '@hsw-editor/compat';
import {
  METALS,
  boundsOf,
  mergeBounds,
  plastic,
  transformMesh,
  type Mesh,
  type ToolModel,
  type Part,
} from '@hsw-editor/tools';
import { encodePng, render } from '@hsw-editor/tools/render';
import type { TriMesh } from '@hsw-editor/physics';

function toMesh(m: TriMesh): Mesh {
  return { positions: Array.from(m.positions), indices: Array.from(m.indices) };
}

export interface VizPart {
  mesh: TriMesh;
  rotation: Mat3;
  position: Vec3;
  color: string;
  metal?: boolean;
}

/** Renders parts (already posed in the wall frame) from the front (+Z) and the side (+X), side by side. */
export function vizScene(
  parts: VizPart[],
  file: string,
  opts: { center?: Vec3; sizeMm?: number } = {},
): void {
  const posed: Part[] = parts.map((p, i) => {
    const r = p.rotation;
    const mesh = transformMesh(toMesh(p.mesh), [
      r[0],
      r[1],
      r[2],
      p.position[0],
      r[3],
      r[4],
      r[5],
      p.position[1],
      r[6],
      r[7],
      r[8],
      p.position[2],
    ]);
    return {
      name: `p${i}`,
      role: 'body',
      material: p.metal ? METALS.steel : plastic(p.color),
      mesh,
    };
  });
  const bounds = mergeBounds(posed.map((p) => boundsOf(p.mesh)));
  const model = {
    classId: 'scene',
    params: {},
    lod: 1,
    parts: posed,
    bounds,
    holding: {} as never,
    triangles: 0,
  } as unknown as ToolModel;
  const c: Vec3 = opts.center ?? [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const w = 520,
    h = 620;
  const ppm =
    Math.min(w, h) /
    (opts.sizeMm ?? Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]) * 1.15);
  const front = render(model, {
    width: w,
    height: h,
    view: { eye: [0, 0, 1], up: [0, 1, 0] },
    background: '#20242a',
    center: c,
    pixelsPerMm: ppm,
  });
  const side = render(model, {
    width: w,
    height: h,
    view: { eye: [1, 0, 0], up: [0, 1, 0] },
    background: '#20242a',
    center: c,
    pixelsPerMm: ppm,
  });
  const out = new Uint8ClampedArray(w * 2 * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(front.rgba.subarray(y * w * 4, (y + 1) * w * 4), y * w * 8);
    out.set(side.rgba.subarray(y * w * 4, (y + 1) * w * 4), y * w * 8 + w * 4);
  }
  writeFileSync(file, encodePng(out, w * 2, h));
}
