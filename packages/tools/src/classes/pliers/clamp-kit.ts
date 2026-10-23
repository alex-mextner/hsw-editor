/**
 * Shared clamp geometry: cast I-section frames (rim + web) and threaded rods.
 */
import { type V2, polygonArea } from '../../math.ts';
import { extrude, insetLoop, lathe } from '../../build/primitives.ts';
import type { Mesh } from '../../mesh.ts';
import { type Pt, roundedOutline } from './kit.ts';

/** I-section casting: rim of `rim` mm width at full thickness, web at `webT` thickness. */
export function iFrame(
  outline: readonly Pt[],
  zHalf: number,
  webHalf: number,
  rim: number,
  steps: number,
  detail: boolean,
): Mesh[] {
  const loop = roundedOutline(outline, steps);
  const ccw = polygonArea(loop) > 0 ? loop : loop.slice().reverse();
  const web = extrude(ccw, -webHalf, webHalf);
  if (!detail) return [extrude(ccw, -zHalf, zHalf, { bevel: 0.8 })];
  const hole = insetLoop(ccw, rim);
  return [web, extrude(ccw, -zHalf, zHalf, { holes: [hole], bevel: 0.8 })];
}

/** Threaded rod along +Y from y0 to y1; thread hint as rings at LOD0. */
export function threadedRod(
  r: number,
  y0: number,
  y1: number,
  pitch: number,
  seg: number,
  detail: boolean,
): Mesh {
  if (!detail)
    return lathe(
      [
        [r, y0],
        [r, y1],
      ],
      seg,
    );
  const prof: V2[] = [[r * 0.82, y0]];
  const n = Math.max(2, Math.floor((y1 - y0) / pitch));
  for (let i = 0; i < n; i++) {
    const y = y0 + ((y1 - y0) * (i + 0.5)) / n;
    prof.push([r, y - pitch * 0.22], [r * 0.9, y]);
  }
  prof.push([r, y1 - 0.1], [r * 0.82, y1]);
  return lathe(prof, seg);
}
