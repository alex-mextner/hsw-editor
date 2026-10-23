/**
 * Zoom/pan of the calibration photo. A view maps image pixels to screen pixels of the viewer:
 * `screen = image * scale + (x, y)`. Every operation returns a new view.
 */
export type Point2 = readonly [number, number];

export interface ViewTransform {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Picking a point precisely needs well beyond 1:1; beyond this the photo is just big blocks. */
export const MAX_SCALE = 40;
/** Below the fitted size the photo only gets lost in the viewer. */
const MIN_FIT_FRACTION = 0.5;

export function imageToScreen(view: ViewTransform, point: Point2): Point2 {
  return [point[0] * view.scale + view.x, point[1] * view.scale + view.y];
}

export function screenToImage(view: ViewTransform, point: Point2): Point2 {
  return [(point[0] - view.x) / view.scale, (point[1] - view.y) / view.scale];
}

/** The whole photo centred in the viewer with `margin` screen pixels around it. */
export function fitView(viewer: Size, image: Size, margin = 8): ViewTransform {
  const scale = Math.max(
    Math.min(
      (viewer.width - 2 * margin) / image.width,
      (viewer.height - 2 * margin) / image.height,
    ),
    1e-6,
  );
  return {
    scale,
    x: (viewer.width - image.width * scale) / 2,
    y: (viewer.height - image.height * scale) / 2,
  };
}

export function scaleLimits(
  viewer: Size,
  image: Size,
): { readonly min: number; readonly max: number } {
  const fit = fitView(viewer, image).scale;
  return { min: fit * MIN_FIT_FRACTION, max: Math.max(MAX_SCALE, fit) };
}

/** Zooms by `factor` keeping the image point under `anchor` (screen pixels) where it is. */
export function zoomAt(
  view: ViewTransform,
  anchor: Point2,
  factor: number,
  limits: { readonly min: number; readonly max: number },
): ViewTransform {
  const scale = Math.min(Math.max(view.scale * factor, limits.min), limits.max);
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor[0] - (anchor[0] - view.x) * ratio,
    y: anchor[1] - (anchor[1] - view.y) * ratio,
  };
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** A two-finger gesture: zoom by the change of finger distance, follow the midpoint. */
export function pinch(
  start: ViewTransform,
  from: { readonly mid: Point2; readonly distance: number },
  to: { readonly mid: Point2; readonly distance: number },
  limits: { readonly min: number; readonly max: number },
): ViewTransform {
  const zoomed = zoomAt(start, from.mid, to.distance / Math.max(from.distance, 1e-6), limits);
  return panBy(zoomed, to.mid[0] - from.mid[0], to.mid[1] - from.mid[1]);
}
