/**
 * Cheap, deterministic CV gate for generated views. It rejects images that cannot be used for
 * silhouette fitting: non-white background / shadows, object cut by the frame, missing object,
 * wrong canvas aspect, converging edges (perspective). Pure functions over decoded RGBA pixels;
 * decoding lives in the server so this package has no native dependencies.
 */

export interface RawImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, 8 bit, row-major, length = width * height * 4. */
  readonly data: Uint8Array;
}

export const QUALITY_ISSUES = [
  'aspect_mismatch',
  'background_not_white',
  'object_missing',
  'object_cut',
  'shadow',
  'perspective',
  'proportion_mismatch',
] as const;
export type QualityIssueCode = (typeof QUALITY_ISSUES)[number];

export interface QualityIssue {
  readonly code: QualityIssueCode;
  readonly severity: 'reject' | 'warn';
  readonly message: string;
}

export interface QualityMetrics {
  readonly aspect: number;
  readonly borderWhiteFraction: number;
  readonly borderForegroundFraction: number;
  readonly foregroundFraction: number;
  readonly shadowFraction: number;
  /** Silhouette bbox width/height; 0 when no object. */
  readonly objectAspect: number;
  /** Relative width change top→bottom of the straight-edged silhouette; 0 when not convergent. */
  readonly convergence: number;
}

export interface QualityReport {
  /** True when no `reject` issue exists. Warnings do not fail the gate. */
  readonly ok: boolean;
  readonly issues: readonly QualityIssue[];
  readonly metrics: QualityMetrics;
}

export interface QualityExpectation {
  /** Requested canvas width/height. */
  readonly aspect: number;
  /** Silhouette bbox width/height from the fit, when known (e.g. from dimsMm for this view). */
  readonly objectAspect?: number;
  /** Treat converging edges as a rejection instead of a warning (boxlike objects only). */
  readonly strictPerspective?: boolean;
}

const WHITE_MIN = 240; // every channel at least this = background white
const FOREGROUND_MIN = 225; // darkest channel below this = object pixel
const STRONG_MIN = 150; // darkest channel below this (or saturated) = solid object colour
const GRAY_SATURATION = 14;

interface Planes {
  /** Per pixel darkest channel after compositing alpha over white. */
  readonly dark: Uint8Array;
  /** Per pixel channel spread (max-min). */
  readonly spread: Uint8Array;
}

function planes(img: RawImage): Planes {
  const count = img.width * img.height;
  const dark = new Uint8Array(count);
  const spread = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const a = (img.data[i * 4 + 3] ?? 255) / 255;
    const r = 255 - a * (255 - (img.data[i * 4] ?? 255));
    const g = 255 - a * (255 - (img.data[i * 4 + 1] ?? 255));
    const b = 255 - a * (255 - (img.data[i * 4 + 2] ?? 255));
    dark[i] = Math.round(Math.min(r, g, b));
    spread[i] = Math.round(Math.max(r, g, b) - Math.min(r, g, b));
  }
  return { dark, spread };
}

/** Summed-area table so "any strong pixel within radius" is O(1) per pixel. */
function integral(mask: Uint8Array, w: number, h: number): Uint32Array {
  const sat = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x] ?? 0;
      sat[(y + 1) * (w + 1) + x + 1] = (sat[y * (w + 1) + x + 1] ?? 0) + row;
    }
  }
  return sat;
}

function boxSum(sat: Uint32Array, w: number, x0: number, y0: number, x1: number, y1: number) {
  const stride = w + 1;
  return (
    (sat[(y1 + 1) * stride + x1 + 1] ?? 0) -
    (sat[y0 * stride + x1 + 1] ?? 0) -
    (sat[(y1 + 1) * stride + x0] ?? 0) +
    (sat[y0 * stride + x0] ?? 0)
  );
}

interface Silhouette {
  readonly bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  readonly left: Int32Array;
  readonly right: Int32Array;
}

function silhouette(dark: Uint8Array, w: number, h: number): Silhouette {
  const left = new Int32Array(h).fill(-1);
  const right = new Int32Array(h).fill(-1);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((dark[y * w + x] ?? 255) >= FOREGROUND_MIN) continue;
      if (left[y] === -1) left[y] = x;
      right[y] = x;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return { bbox: x1 < 0 ? null : { x0, y0, x1, y1 }, left, right };
}

interface LineFit {
  readonly slope: number;
  readonly rmse: number;
}

function fitLine(ys: readonly number[], xs: readonly number[]): LineFit {
  const n = ys.length;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((ys[i] ?? 0) - my) * ((xs[i] ?? 0) - mx);
    syy += ((ys[i] ?? 0) - my) ** 2;
  }
  const slope = syy === 0 ? 0 : sxy / syy;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += ((xs[i] ?? 0) - (mx + slope * ((ys[i] ?? 0) - my))) ** 2;
  return { slope, rmse: Math.sqrt(sse / n) };
}

/** Relative top→bottom width change when both silhouette edges are straight and converge/diverge. */
function convergence(sil: Silhouette): number {
  const { bbox } = sil;
  if (!bbox) return 0;
  const height = bbox.y1 - bbox.y0 + 1;
  const width = bbox.x1 - bbox.x0 + 1;
  if (height < 32 || width < 32) return 0;
  const from = bbox.y0 + Math.floor(height * 0.1);
  const to = bbox.y1 - Math.floor(height * 0.1);
  const ys: number[] = [];
  const ls: number[] = [];
  const rs: number[] = [];
  for (let y = from; y <= to; y++) {
    const l = sil.left[y] ?? -1;
    const r = sil.right[y] ?? -1;
    if (l < 0) return 0; // holes in the silhouette rows: not a simple convex outline
    ys.push(y);
    ls.push(l);
    rs.push(r);
  }
  const lf = fitLine(ys, ls);
  const rf = fitLine(ys, rs);
  const straight = lf.rmse < width * 0.012 && rf.rmse < width * 0.012;
  const opposing = lf.slope * rf.slope < 0;
  if (!straight || !opposing) return 0;
  const span = to - from;
  const topWidth = (rs[0] ?? 0) - (ls[0] ?? 0);
  const bottomWidth = (rs.at(-1) ?? 0) - (ls.at(-1) ?? 0);
  const mean = (topWidth + bottomWidth) / 2;
  if (mean <= 0 || span <= 0) return 0;
  return Math.abs(topWidth - bottomWidth) / mean;
}

export function analyzeImage(img: RawImage, expect: QualityExpectation): QualityReport {
  const { width: w, height: h } = img;
  const issues: QualityIssue[] = [];
  const add = (code: QualityIssueCode, severity: QualityIssue['severity'], message: string) => {
    issues.push({ code, severity, message });
  };
  if (w < 64 || h < 64 || img.data.length !== w * h * 4) {
    throw new RangeError('analyzeImage: image must be at least 64x64 RGBA');
  }
  const aspect = w / h;
  if (Math.abs(aspect - expect.aspect) / expect.aspect > 0.03) {
    add(
      'aspect_mismatch',
      'reject',
      `canvas aspect ${aspect.toFixed(3)} differs from requested ${expect.aspect.toFixed(3)}`,
    );
  }

  const { dark, spread } = planes(img);
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.015));
  let borderTotal = 0;
  let borderWhite = 0;
  let borderForeground = 0;
  let foreground = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = dark[y * w + x] ?? 255;
      if (d < FOREGROUND_MIN) foreground++;
      if (x < ring || y < ring || x >= w - ring || y >= h - ring) {
        borderTotal++;
        if (d >= WHITE_MIN) borderWhite++;
        if (d < STRONG_MIN) borderForeground++;
      }
    }
  }
  const borderWhiteFraction = borderWhite / borderTotal;
  const borderForegroundFraction = borderForeground / borderTotal;
  const foregroundFraction = foreground / (w * h);

  // A cut object leaves most of the border white; a non-white background leaves little of it.
  if (borderWhiteFraction >= 0.75 && borderForegroundFraction > 0.005) {
    add('object_cut', 'reject', 'the object touches the image border (cropped)');
  } else if (borderWhiteFraction < 0.97) {
    add(
      'background_not_white',
      'reject',
      `only ${(borderWhiteFraction * 100).toFixed(1)}% of the frame border is white`,
    );
  }
  if (foregroundFraction < 0.015) {
    add('object_missing', 'reject', 'no object found on the white background');
  } else if (foregroundFraction > 0.85) {
    add('background_not_white', 'reject', 'the image is mostly non-white');
  }

  // Shadow/gradient: soft low-saturation gray farther than `reach` px from any solid object pixel.
  const strong = new Uint8Array(w * h);
  for (let i = 0; i < strong.length; i++) {
    strong[i] = (dark[i] ?? 255) < STRONG_MIN || (spread[i] ?? 0) > GRAY_SATURATION * 3 ? 1 : 0;
  }
  const sat = integral(strong, w, h);
  const reach = Math.max(3, Math.round(Math.min(w, h) * 0.006));
  let soft = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = dark[y * w + x] ?? 255;
      if (d >= WHITE_MIN || d < STRONG_MIN || (spread[y * w + x] ?? 0) > GRAY_SATURATION) continue;
      const near = boxSum(
        sat,
        w,
        Math.max(0, x - reach),
        Math.max(0, y - reach),
        Math.min(w - 1, x + reach),
        Math.min(h - 1, y + reach),
      );
      if (near === 0) soft++;
    }
  }
  const shadowFraction = soft / Math.max(1, foreground);
  if (foregroundFraction >= 0.015 && shadowFraction > 0.06) {
    add(
      'shadow',
      'reject',
      `soft gray shadow/gradient around the object (${(shadowFraction * 100).toFixed(0)}% of object area)`,
    );
  }

  const sil = silhouette(dark, w, h);
  const objectAspect = sil.bbox
    ? (sil.bbox.x1 - sil.bbox.x0 + 1) / (sil.bbox.y1 - sil.bbox.y0 + 1)
    : 0;
  const converge = convergence(sil);
  if (converge > 0.12) {
    add(
      'perspective',
      expect.strictPerspective ? 'reject' : 'warn',
      `silhouette edges converge by ${(converge * 100).toFixed(0)}% (perspective instead of orthographic)`,
    );
  }
  if (expect.objectAspect !== undefined && objectAspect > 0) {
    const ratio = objectAspect / expect.objectAspect;
    if (ratio < 0.75 || ratio > 1.33) {
      add(
        'proportion_mismatch',
        'reject',
        `object bbox aspect ${objectAspect.toFixed(2)} vs expected ${expect.objectAspect.toFixed(2)}`,
      );
    }
  }

  return {
    ok: issues.every((issue) => issue.severity !== 'reject'),
    issues,
    metrics: {
      aspect,
      borderWhiteFraction,
      borderForegroundFraction,
      foregroundFraction,
      shadowFraction,
      objectAspect,
      convergence: converge,
    },
  };
}
