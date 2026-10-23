/**
 * Tool ghosts: what the vision job `vision.photo_to_objects` found in a wall photo, kept as proposals drawn over
 * the photo until the user accepts (the tool is added at the detected spot) or discards each one. The result
 * shape is the `objects.json` of `docs/vision.md`; the web app never imports server code, so the fields this
 * feature reads are described here and parsed leniently (extra fields are ignored, a bad object is skipped).
 */
import { createValueStore } from '#state-backend';
import { z } from 'zod';
import { presetDims, type Dims3 } from '@/wall/toolPresets.ts';

const Point = z.tuple([z.number(), z.number()]);

const ObjectSchema = z.looseObject({
  id: z.number().int(),
  bboxXywh: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Simplified outer contour of the mask, original photo pixels (y down). */
  polygon: z.array(Point).optional(),
  axis: z.looseObject({ centerPx: Point.optional() }).optional(),
  class: z.looseObject({
    toolClass: z.string().nullable(),
    label: z.string().nullable().optional(),
    prob: z.number().nullable().optional(),
  }),
  confidence: z.number(),
  status: z.enum(['ok', 'needs_confirmation', 'no_scale', 'fit_failed']),
  dimensionsMm: z.record(z.string(), z.number().nullable()).nullable().optional(),
});

const ResultSchema = z.looseObject({
  image: z.looseObject({ w: z.number().positive(), h: z.number().positive() }),
  objects: z.array(z.unknown()),
});

export interface ToolGhost {
  /** Segmentation instance id; stable for a given photo. */
  readonly id: number;
  /** Bank tool-class id the recogniser chose. */
  readonly toolClass: string;
  /** The recogniser's own label (a fallback while the bank does not name the class). */
  readonly label: string;
  /** Recognition confidence in [0, 1] (the class softmax share), or the object's fit confidence without one. */
  readonly confidence: number;
  /** The fit is unverified or low: the user should look twice. */
  readonly needsConfirmation: boolean;
  /** Mask outline in photo pixels. */
  readonly polygonPx: readonly (readonly [number, number])[];
  /** Where the object is in the photo: the middle of its principal axis, else of its box. */
  readonly centrePx: readonly [number, number];
  /** Measured width / length / thickness as the tool item's box; the class preset when nothing was measured. */
  readonly dimsMm: Dims3;
  readonly measured: boolean;
}

export interface ParsedGhosts {
  readonly image: { readonly width: number; readonly height: number };
  readonly ghosts: readonly ToolGhost[];
  /** Objects the recogniser could not name: no ghost is drawn for them. */
  readonly unrecognised: number;
}

function boxOutline(box: readonly [number, number, number, number]): [number, number][] {
  const [x, y, w, h] = box;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

function measuredDims(
  record: Readonly<Record<string, number | null>> | null | undefined,
  toolClass: string,
): { readonly dims: Dims3; readonly measured: boolean } {
  const length = record?.['length'];
  const width = record?.['width'];
  const thickness = record?.['thickness'];
  if (
    typeof length === 'number' &&
    typeof width === 'number' &&
    typeof thickness === 'number' &&
    length > 0 &&
    width > 0 &&
    thickness > 0
  ) {
    return { dims: { x: width, y: length, z: thickness }, measured: true };
  }
  return { dims: presetDims(toolClass), measured: false };
}

/** The ghosts of a `vision.photo_to_objects` job result; null when it is not one. */
export function parseToolGhosts(result: unknown): ParsedGhosts | null {
  const parsed = ResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const ghosts: ToolGhost[] = [];
  let unrecognised = 0;
  for (const raw of parsed.data.objects) {
    const object = ObjectSchema.safeParse(raw);
    if (!object.success || object.data.status === 'fit_failed') continue;
    const { class: recognised, bboxXywh, polygon, axis } = object.data;
    if (recognised.toolClass === null) {
      unrecognised += 1;
      continue;
    }
    const [x, y, w, h] = bboxXywh;
    const { dims, measured } = measuredDims(object.data.dimensionsMm, recognised.toolClass);
    ghosts.push({
      id: object.data.id,
      toolClass: recognised.toolClass,
      label: recognised.label ?? recognised.toolClass,
      confidence: Math.min(1, Math.max(0, recognised.prob ?? object.data.confidence)),
      needsConfirmation: object.data.status !== 'ok',
      polygonPx: polygon !== undefined && polygon.length >= 3 ? polygon : boxOutline(bboxXywh),
      centrePx: axis?.centerPx ?? [x + w / 2, y + h / 2],
      dimsMm: dims,
      measured,
    });
  }
  ghosts.sort((a, b) => b.confidence - a.confidence);
  return {
    image: { width: parsed.data.image.w, height: parsed.data.image.h },
    ghosts,
    unrecognised,
  };
}

export interface GhostState {
  /** The photo the ghosts were found in; they are not shown over another photo. */
  readonly photoId: string | null;
  readonly ghosts: readonly ToolGhost[];
}

export const ghostStore = createValueStore<GhostState>({ photoId: null, ghosts: [] });

export function setGhosts(photoId: string, ghosts: readonly ToolGhost[]): void {
  ghostStore.set({ photoId, ghosts });
}

export function discardGhost(id: number): void {
  const state = ghostStore.get();
  ghostStore.set({ ...state, ghosts: state.ghosts.filter((ghost) => ghost.id !== id) });
}

export function discardAllGhosts(): void {
  ghostStore.set({ photoId: null, ghosts: [] });
}

/**
 * The ghosts in the pixels of a photo of size `to`, when the vision result was made for size `from`. Null when the
 * two have different shapes (more than 2 % apart in aspect ratio): the result is for another picture.
 */
export function scaleGhosts(
  ghosts: readonly ToolGhost[],
  from: { readonly width: number; readonly height: number },
  to: { readonly width: number; readonly height: number },
): readonly ToolGhost[] | null {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  // Written so that a zero or non-finite size (NaN fails every comparison) is refused too.
  if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) return null;
  if (Math.abs(sx / sy - 1) > 0.02) return null;
  if (sx === 1 && sy === 1) return ghosts;
  return ghosts.map((ghost) => ({
    ...ghost,
    polygonPx: ghost.polygonPx.map(([x, y]) => [x * sx, y * sy] as const),
    centrePx: [ghost.centrePx[0] * sx, ghost.centrePx[1] * sy],
  }));
}

export interface BoardSplit {
  /** Ghosts whose spot maps onto the board: the ones worth proposing for the wall. */
  readonly onBoard: readonly ToolGhost[];
  /** Ghosts elsewhere in the photo (printers, shelves, the room); not drawn. */
  readonly offBoard: number;
}

/** Keeps the ghosts that sit on the board; `toWall` maps photo pixels to wall mm (null: not on the wall plane). */
export function splitByBoard(
  ghosts: readonly ToolGhost[],
  toWall: (px: readonly [number, number]) => readonly [number, number] | null,
  board: { readonly widthMm: number; readonly heightMm: number },
): BoardSplit {
  const onBoard: ToolGhost[] = [];
  for (const ghost of ghosts) {
    const at = toWall(ghost.centrePx);
    if (
      at !== null &&
      at[0] >= 0 &&
      at[0] <= board.widthMm &&
      at[1] >= 0 &&
      at[1] <= board.heightMm
    ) {
      onBoard.push(ghost);
    }
  }
  return { onBoard, offBoard: ghosts.length - onBoard.length };
}
