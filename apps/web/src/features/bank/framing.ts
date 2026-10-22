import type { BboxMm, Vec3 } from '@hsw-editor/bank';
import { MM } from '@/scene/units.ts';

export const PREVIEW_FOV_DEG = 32;
/** Slight three-quarter view from the front (+z, out of the wall), from above and the right. */
const VIEW_DIRECTION: readonly [number, number, number] = [0.55, 0.4, 1];
/** Breathing room so the silhouette does not touch the canvas edge. */
const MARGIN = 1.15;

export interface PreviewFrame {
  /** Bounding-box centre in the GLB's own frame (mm): the model is shifted by its negative. */
  readonly centreMm: Vec3;
  /** Camera position in metres, looking at the origin. */
  readonly position: readonly [number, number, number];
  readonly radius: number;
  readonly near: number;
  readonly far: number;
}

/**
 * Camera that fits the element's bounding sphere. The GLB is in bank mm, so `dimsMm` / `bboxMm` are
 * used directly instead of measuring the loaded scene (the frame is known before the download ends).
 */
export function frameModel(bbox: BboxMm, dims: Vec3): PreviewFrame {
  const centreMm = {
    x: (bbox.min.x + bbox.max.x) / 2,
    y: (bbox.min.y + bbox.max.y) / 2,
    z: (bbox.min.z + bbox.max.z) / 2,
  };
  const radius = Math.max(Math.hypot(dims.x, dims.y, dims.z) / 2, 1) * MM;
  const distance = (radius / Math.sin((PREVIEW_FOV_DEG / 2) * (Math.PI / 180))) * MARGIN;
  const [dx, dy, dz] = VIEW_DIRECTION;
  const length = Math.hypot(dx, dy, dz);
  return {
    centreMm,
    position: [(dx / length) * distance, (dy / length) * distance, (dz / length) * distance],
    radius,
    near: distance * 0.05,
    far: distance * 10,
  };
}
