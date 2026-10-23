/**
 * Cleaning the wall photo under the board (pure, no I/O). The board footprint (calibration -> polygon in photo
 * pixels, plus a margin) is a mask; `fillWall` replaces what is inside it with a plausible clean wall: a smooth
 * illumination surface fitted to the wall around the mask, plus the boundary residual relaxed inward so the patch
 * meets the wall without a seam, plus matched sensor grain. It is the "basic" clean: instant, offline, no model.
 * An AI edit (draw backend) can replace it later; the original photo is never touched.
 */
import type { BoardExtent } from './calibration.ts';
import type { ImageSize, PhotoMap } from './photo-map.ts';
import type { Vec2 } from './matrix.ts';

/** Margin around the board footprint that is cleaned too, mm of wall: just the board edge and its soft shadow. */
export const CLEAN_MARGIN_MM = 12;

/** Photo-px polygon of the board (plus `marginMm` of wall on every side), lower-left first; null off the wall plane. */
export function boardFootprintPx(
  map: PhotoMap,
  extent: BoardExtent,
  marginMm: number = CLEAN_MARGIN_MM,
): Vec2[] | null {
  const corners: Vec2[] = [
    [-marginMm, -marginMm],
    [extent.widthMm + marginMm, -marginMm],
    [extent.widthMm + marginMm, extent.heightMm + marginMm],
    [-marginMm, extent.heightMm + marginMm],
  ];
  const out: Vec2[] = [];
  for (const corner of corners) {
    const px = map.wallToPx(corner);
    if (px === null) return null;
    out.push(px);
  }
  return out;
}

/** A footprint as text, kept with the cleaned photo: `1152x1536@12:240,340;620,336;...` (photo size, margin mm, pixels). */
export function footprintSignature(
  polygon: readonly Vec2[],
  image: ImageSize,
  marginMm: number = CLEAN_MARGIN_MM,
): string {
  return `${image.width}x${image.height}@${marginMm}:${polygon.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(';')}`;
}

/**
 * How far a footprint has moved from the one a cleaned photo was made for: the largest distance between matching
 * corners, px. Infinity when the signature is unreadable, belongs to another photo size, or has another corner count.
 */
export function footprintDrift(
  signature: string,
  polygon: readonly Vec2[],
  image: ImageSize,
): number {
  const [size, points] = signature.split(':');
  // The size and the margin the footprint was made with: a variant cleaned with another margin is another footprint.
  if (size !== `${image.width}x${image.height}@${CLEAN_MARGIN_MM}` || points === undefined)
    return Infinity;
  const corners = points.split(';').map((pair) => pair.split(',').map(Number));
  if (corners.length !== polygon.length) return Infinity;
  let worst = 0;
  for (let i = 0; i < corners.length; i += 1) {
    const [sx, sy] = corners[i] ?? [];
    const corner = polygon[i];
    if (
      sx === undefined ||
      sy === undefined ||
      !Number.isFinite(sx) ||
      !Number.isFinite(sy) ||
      !corner
    )
      return Infinity;
    worst = Math.max(worst, Math.hypot(corner[0] - sx, corner[1] - sy));
  }
  return worst;
}

/** The footprint moved materially when a corner is more than this far off: 1.5 % of the photo's longer side. */
export function materialDrift(image: ImageSize): number {
  return Math.max(image.width, image.height) * 0.015;
}

/** 1 inside the polygon (even-odd), 0 outside, one byte per pixel of a `width` x `height` photo. */
export function rasterisePolygon(
  polygon: readonly Vec2[],
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const count = polygon.length;
  if (count < 3) return mask;
  for (let y = 0; y < height; y += 1) {
    const yc = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % count];
      if (a === undefined || b === undefined) continue;
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
        crossings.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil((crossings[i] ?? 0) - 0.5));
      const to = Math.min(width - 1, Math.floor((crossings[i + 1] ?? 0) - 0.5));
      for (let x = from; x <= to; x += 1) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** How many mask pixels are set. */
export function maskArea(mask: Uint8Array): number {
  let n = 0;
  for (const value of mask) n += value;
  return n;
}

// ---- the basic fill ----------------------------------------------------------------------------

export interface FillOptions {
  /** Longest side of the working grid the surface and the relaxation run on. Default 192. */
  readonly workSide?: number;
  /** Gauss-Seidel sweeps of the boundary residual. Default 500. */
  readonly sweeps?: number;
  /** Width of the seam feather, px of the full photo. Default 0.4 % of the longest side. */
  readonly featherPx?: number;
  /** Grain amplitude as a fraction of the grain measured around the mask. Default 0.8; 0 turns it off. */
  readonly grain?: number;
  readonly seed?: number;
}

const QUADRATIC_TERMS = 6;

/** Solves the normal equations of the weighted quadratic fit; null when the system is singular. */
function fitQuadratic(
  xs: Float64Array,
  ys: Float64Array,
  zs: Float64Array,
  weights: Float64Array,
  count: number,
): Float64Array | null {
  const a = new Float64Array(QUADRATIC_TERMS * (QUADRATIC_TERMS + 1));
  const row = new Float64Array(QUADRATIC_TERMS);
  for (let i = 0; i < count; i += 1) {
    const w = weights[i] ?? 0;
    if (w === 0) continue;
    const x = xs[i] ?? 0;
    const y = ys[i] ?? 0;
    row[0] = 1;
    row[1] = x;
    row[2] = y;
    row[3] = x * x;
    row[4] = x * y;
    row[5] = y * y;
    for (let r = 0; r < QUADRATIC_TERMS; r += 1) {
      for (let c = 0; c < QUADRATIC_TERMS; c += 1) {
        a[r * (QUADRATIC_TERMS + 1) + c] =
          (a[r * (QUADRATIC_TERMS + 1) + c] ?? 0) + w * (row[r] ?? 0) * (row[c] ?? 0);
      }
      a[r * (QUADRATIC_TERMS + 1) + QUADRATIC_TERMS] =
        (a[r * (QUADRATIC_TERMS + 1) + QUADRATIC_TERMS] ?? 0) + w * (row[r] ?? 0) * (zs[i] ?? 0);
    }
  }
  const width = QUADRATIC_TERMS + 1;
  for (let col = 0; col < QUADRATIC_TERMS; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < QUADRATIC_TERMS; r += 1) {
      if (Math.abs(a[r * width + col] ?? 0) > Math.abs(a[pivot * width + col] ?? 0)) pivot = r;
    }
    if (Math.abs(a[pivot * width + col] ?? 0) < 1e-9) return null;
    if (pivot !== col) {
      for (let c = 0; c < width; c += 1) {
        const tmp = a[col * width + c] ?? 0;
        a[col * width + c] = a[pivot * width + c] ?? 0;
        a[pivot * width + c] = tmp;
      }
    }
    const diag = a[col * width + col] ?? 1;
    for (let r = 0; r < QUADRATIC_TERMS; r += 1) {
      if (r === col) continue;
      const factor = (a[r * width + col] ?? 0) / diag;
      if (factor === 0) continue;
      for (let c = col; c < width; c += 1) {
        a[r * width + c] = (a[r * width + c] ?? 0) - factor * (a[col * width + c] ?? 0);
      }
    }
  }
  const out = new Float64Array(QUADRATIC_TERMS);
  for (let r = 0; r < QUADRATIC_TERMS; r += 1)
    out[r] = (a[r * width + QUADRATIC_TERMS] ?? 0) / (a[r * width + r] ?? 1);
  return out;
}

function evalQuadratic(c: Float64Array, x: number, y: number): number {
  return (
    (c[0] ?? 0) +
    (c[1] ?? 0) * x +
    (c[2] ?? 0) * y +
    (c[3] ?? 0) * x * x +
    (c[4] ?? 0) * x * y +
    (c[5] ?? 0) * y * y
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((p, q) => p - q);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Robust quadratic surfaces through the samples, one per colour channel. Outliers (a box, a cap, the edge of a shelf
 * at the rim) are dropped after a few passes, and a sample that is off in ANY channel goes from all of them together:
 * a red object is not a wall that happens to be a little redder.
 */
function robustSurfaces(
  xs: Float64Array,
  ys: Float64Array,
  channels: readonly Float64Array[],
  count: number,
): ((x: number, y: number) => number)[] {
  const weights = new Float64Array(count).fill(1);
  const fit = (): (Float64Array | null)[] =>
    channels.map((zs) => fitQuadratic(xs, ys, zs, weights, count));
  let fits = fit();
  for (let pass = 0; pass < 4 && fits.every((c) => c !== null); pass += 1) {
    const keep = new Uint8Array(count).fill(1);
    fits.forEach((coefficients, c) => {
      const zs = channels[c];
      if (coefficients === null || zs === undefined) return;
      const residuals: number[] = [];
      for (let i = 0; i < count; i += 1) {
        residuals.push(
          Math.abs((zs[i] ?? 0) - evalQuadratic(coefficients, xs[i] ?? 0, ys[i] ?? 0)),
        );
      }
      const limit = Math.max(3, 2.5 * 1.4826 * median(residuals));
      for (let i = 0; i < count; i += 1) if ((residuals[i] ?? 0) > limit) keep[i] = 0;
    });
    for (let i = 0; i < count; i += 1) weights[i] = keep[i] ?? 0;
    const next = fit();
    if (next.some((c) => c === null)) break;
    fits = next;
  }
  return channels.map((zs, c) => {
    const coefficients = fits[c];
    if (coefficients !== null && coefficients !== undefined) {
      return (x: number, y: number) => evalQuadratic(coefficients, x, y);
    }
    let sum = 0;
    for (let i = 0; i < count; i += 1) sum += zs[i] ?? 0;
    const mean = count === 0 ? 128 : sum / count;
    return () => mean;
  });
}

/** Chamfer distance (in grid cells) from every cell to the nearest masked cell. */
function distanceToMask(mask: Uint8Array, w: number, h: number): Float32Array {
  const dist = new Float32Array(w * h).fill(1e9);
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) dist[i] = 0;
  const step = (i: number, j: number, cost: number): void => {
    const candidate = (dist[j] ?? 1e9) + cost;
    if (candidate < (dist[i] ?? 1e9)) dist[i] = candidate;
  };
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (x > 0) step(i, i - 1, 1);
      if (y > 0) {
        step(i, i - w, 1);
        if (x > 0) step(i, i - w - 1, 1.414);
        if (x < w - 1) step(i, i - w + 1, 1.414);
      }
    }
  }
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      if (x < w - 1) step(i, i + 1, 1);
      if (y < h - 1) {
        step(i, i + w, 1);
        if (x < w - 1) step(i, i + w + 1, 1.414);
        if (x > 0) step(i, i + w - 1, 1.414);
      }
    }
  }
  return dist;
}

function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const span = 2 * radius + 1;
  for (let y = 0; y < h; y += 1) {
    let acc = 0;
    for (let x = -radius; x <= radius; x += 1)
      acc += src[y * w + Math.min(w - 1, Math.max(0, x))] ?? 0;
    for (let x = 0; x < w; x += 1) {
      tmp[y * w + x] = acc / span;
      acc +=
        (src[y * w + Math.min(w - 1, x + radius + 1)] ?? 0) -
        (src[y * w + Math.max(0, x - radius)] ?? 0);
    }
  }
  for (let x = 0; x < w; x += 1) {
    let acc = 0;
    for (let y = -radius; y <= radius; y += 1)
      acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x] ?? 0;
    for (let y = 0; y < h; y += 1) {
      out[y * w + x] = acc / span;
      acc +=
        (tmp[Math.min(h - 1, y + radius + 1) * w + x] ?? 0) -
        (tmp[Math.max(0, y - radius) * w + x] ?? 0);
    }
  }
  return out;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Gaussian sample from two uniforms (Box-Muller). */
function gaussian(random: () => number): number {
  const u = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/**
 * Replaces the masked pixels of an interleaved 8-bit image (`channels` per pixel, any alpha channel is kept) by a
 * clean wall. Returns a new array; pixels farther than the feather from the mask are byte-identical to the input.
 */
export function fillWall(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  mask: Uint8Array,
  options: FillOptions = {},
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data);
  let masked = 0;
  for (const value of mask) masked += value;
  if (masked === 0) return out;
  const colour = Math.min(3, channels);
  const factor = Math.max(1, Math.ceil(Math.max(width, height) / (options.workSide ?? 192)));
  const lw = Math.ceil(width / factor);
  const lh = Math.ceil(height / factor);

  // Low-resolution grid: mean colour of the known pixels of each block, and which blocks are (mostly) masked.
  const sum = new Float64Array(lw * lh * colour);
  const known = new Float64Array(lw * lh);
  const maskedCount = new Float64Array(lw * lh);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = Math.floor(y / factor) * lw + Math.floor(x / factor);
      if (mask[y * width + x]) {
        maskedCount[cell] = (maskedCount[cell] ?? 0) + 1;
      } else {
        known[cell] = (known[cell] ?? 0) + 1;
        for (let c = 0; c < colour; c += 1) {
          sum[cell * colour + c] =
            (sum[cell * colour + c] ?? 0) + (data[(y * width + x) * channels + c] ?? 0);
        }
      }
    }
  }
  const lowMask = new Uint8Array(lw * lh);
  for (let i = 0; i < lw * lh; i += 1) {
    const total = (known[i] ?? 0) + (maskedCount[i] ?? 0);
    lowMask[i] = (maskedCount[i] ?? 0) >= total / 2 ? 1 : 0;
  }
  const dist = distanceToMask(lowMask, lw, lh);
  const ring = Math.max(6, 0.22 * Math.max(lw, lh));

  // One smooth illumination surface per colour channel, fitted to the wall around the mask.
  const xs = new Float64Array(lw * lh);
  const ys = new Float64Array(lw * lh);
  const channelSamples: Float64Array[] = Array.from(
    { length: colour },
    () => new Float64Array(lw * lh),
  );
  let sampleCount = 0;
  for (let y = 0; y < lh; y += 1) {
    for (let x = 0; x < lw; x += 1) {
      const i = y * lw + x;
      if (lowMask[i] || (known[i] ?? 0) === 0 || (dist[i] ?? 1e9) > ring) continue;
      xs[sampleCount] = (x / lw) * 2 - 1;
      ys[sampleCount] = (y / lh) * 2 - 1;
      for (let c = 0; c < colour; c += 1) {
        const column = channelSamples[c];
        if (column) column[sampleCount] = (sum[i * colour + c] ?? 0) / (known[i] ?? 1);
      }
      sampleCount += 1;
    }
  }
  const surfaces = robustSurfaces(xs, ys, channelSamples, sampleCount);

  // The wall right at the mask edge, as a deviation from the surface. A cell that is off in ANY channel (a red box
  // at the rim, a cable) is not wall: it must not tint the patch, so it is dropped from every channel together.
  const rim: number[] = [];
  const deviation: Float64Array[] = Array.from({ length: colour }, () => new Float64Array(lw * lh));
  for (let y = 0; y < lh; y += 1) {
    for (let x = 0; x < lw; x += 1) {
      const i = y * lw + x;
      if (lowMask[i] || (known[i] ?? 0) === 0) continue;
      const near =
        (x > 0 && lowMask[i - 1]) ||
        (x < lw - 1 && lowMask[i + 1]) ||
        (y > 0 && lowMask[i - lw]) ||
        (y < lh - 1 && lowMask[i + lw]);
      if (!near) continue;
      rim.push(i);
      for (let c = 0; c < colour; c += 1) {
        const value = (sum[i * colour + c] ?? 0) / (known[i] ?? 1);
        const column = deviation[c];
        if (column) column[i] = value - (surfaces[c]?.((x / lw) * 2 - 1, (y / lh) * 2 - 1) ?? 0);
      }
    }
  }
  const limits = deviation.map((column) => {
    const spread = median(rim.map((i) => Math.abs(column[i] ?? 0)));
    return Math.max(6, 3 * 1.4826 * spread);
  });
  const wallRim = rim.filter((i) =>
    deviation.every((column, c) => Math.abs(column[i] ?? 0) <= (limits[c] ?? 6)),
  );

  // Inside the mask the deviation is relaxed inward from the wall rim (Laplace, Gauss-Seidel), so the patch meets
  // the wall without a seam.
  const fillLow = new Float32Array(lw * lh * colour);
  const sweeps = options.sweeps ?? 500;
  for (let c = 0; c < colour; c += 1) {
    const residual = new Float32Array(lw * lh);
    const fixed = new Uint8Array(lw * lh);
    for (const i of wallRim) {
      residual[i] = deviation[c]?.[i] ?? 0;
      fixed[i] = 1;
    }
    for (let sweep = 0; sweep < sweeps; sweep += 1) {
      for (let y = 0; y < lh; y += 1) {
        for (let x = 0; x < lw; x += 1) {
          const i = y * lw + x;
          if (!lowMask[i]) continue;
          let total = 0;
          let count = 0;
          if (x > 0) {
            total += residual[i - 1] ?? 0;
            count += 1;
          }
          if (x < lw - 1) {
            total += residual[i + 1] ?? 0;
            count += 1;
          }
          if (y > 0) {
            total += residual[i - lw] ?? 0;
            count += 1;
          }
          if (y < lh - 1) {
            total += residual[i + lw] ?? 0;
            count += 1;
          }
          residual[i] = count === 0 ? 0 : total / count;
        }
      }
    }
    const surface = surfaces[c];
    for (let y = 0; y < lh; y += 1) {
      for (let x = 0; x < lw; x += 1) {
        const i = y * lw + x;
        fillLow[i * colour + c] =
          (surface?.((x / lw) * 2 - 1, (y / lh) * 2 - 1) ?? 0) +
          (fixed[i] || lowMask[i] ? (residual[i] ?? 0) : 0);
      }
    }
  }

  // Grain: how noisy the wall is just outside the mask (difference to its 3x3 mean), reproduced inside.
  const grainScale = options.grain ?? 0.8;
  let sigma = 0;
  if (grainScale > 0) {
    const samples: number[] = [];
    const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 20000)));
    for (let y = 1; y < height - 1; y += stride) {
      for (let x = 1; x < width - 1; x += stride) {
        const i = y * width + x;
        if (mask[i]) continue;
        const nearMask = mask[i - 1] || mask[i + 1] || mask[i - width] || mask[i + width];
        const lowDist = dist[Math.floor(y / factor) * lw + Math.floor(x / factor)] ?? 1e9;
        if (nearMask || lowDist > ring) continue;
        let around = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1)
            around += data[((y + dy) * width + x + dx) * channels + 1] ?? 0;
        }
        samples.push(Math.abs((data[i * channels + 1] ?? 0) - around / 9));
      }
    }
    sigma = Math.min(6, 1.4826 * median(samples) * 1.2) * grainScale;
  }

  const random = lcg(options.seed ?? 1);
  const alphaSource = new Float32Array(width * height);
  for (let i = 0; i < alphaSource.length; i += 1) alphaSource[i] = mask[i] ? 1 : 0;
  const feather = Math.max(1, Math.round(options.featherPx ?? 0.004 * Math.max(width, height)));
  const alpha = boxBlur(boxBlur(alphaSource, width, height, feather), width, height, feather);
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(lh - 1.001, Math.max(0, (y + 0.5) / factor - 0.5));
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const a = mask[i] ? 1 : (alpha[i] ?? 0);
      if (a <= 0.002) continue;
      const gx = Math.min(lw - 1.001, Math.max(0, (x + 0.5) / factor - 0.5));
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const noise = sigma > 0 ? gaussian(random) * sigma : 0;
      for (let c = 0; c < colour; c += 1) {
        const at = (xx: number, yy: number): number => fillLow[(yy * lw + xx) * colour + c] ?? 0;
        const value =
          at(x0, y0) * (1 - fx) * (1 - fy) +
          at(x0 + 1, y0) * fx * (1 - fy) +
          at(x0, y0 + 1) * (1 - fx) * fy +
          at(x0 + 1, y0 + 1) * fx * fy +
          noise;
        const original = data[i * channels + c] ?? 0;
        out[i * channels + c] = original * (1 - a) + value * a;
      }
    }
  }
  return out;
}

// ---- texture and colour of an edited patch -------------------------------------------------------

/** Grain above this many levels is not wall grain (an edge got into the sample); it is also the most noise ever added. */
const MAX_GRAIN = 4;

/** Pixels within this many px of the mask (outside it) are "the wall around the area". */
const NEAR_PX = 28;

/** Grain: mean absolute difference of the green channel to its 3x3 mean over the sampled pixels of `select` (levels). */
function highPassSigma(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  select: (i: number) => boolean,
): number {
  const samples: number[] = [];
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 30000)));
  for (let y = 1; y < height - 1; y += stride) {
    for (let x = 1; x < width - 1; x += stride) {
      const i = y * width + x;
      if (!select(i)) continue;
      let around = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1)
          around += data[((y + dy) * width + x + dx) * channels + 1] ?? 0;
      }
      samples.push(Math.abs((data[i * channels + 1] ?? 0) - around / 9));
    }
  }
  // Median, not mean: an edge or a cable in the sample must not pass for grain. For gaussian noise mean|x| = 1.183 * median|x|.
  return Math.min(MAX_GRAIN, 1.183 * median(samples));
}

/** Which pixels are outside the mask but within `NEAR_PX` of it (the wall the patch has to meet). */
function nearWall(mask: Uint8Array, width: number, height: number): Uint8Array {
  const source = new Float32Array(width * height);
  for (let i = 0; i < source.length; i += 1) source[i] = mask[i] ? 1 : 0;
  const blurred = boxBlur(source, width, height, NEAR_PX);
  const near = new Uint8Array(width * height);
  for (let i = 0; i < near.length; i += 1) near[i] = !mask[i] && (blurred[i] ?? 0) > 0.004 ? 1 : 0;
  return near;
}

export interface PatchReport {
  /** Mean absolute colour difference (levels, over the channels) between the patch and the reference fill, inside the mask. */
  readonly colourOff: number;
  /** Grain of the wall around the mask: mean |pixel - 3x3 mean|, levels. */
  readonly wallGrain: number;
  /** Grain of the patch interior, levels. */
  readonly patchGrain: number;
}

/**
 * How a three-channel `edited` photo compares with `reference` (the basic fill, a wall estimate) inside `mask`, and how
 * grainy the wall around and the patch are. A model that paints a flat white, or a wall of another colour, shows as a
 * large `colourOff`; one that paints a too-clean patch shows as `patchGrain` well under `wallGrain`.
 */
export function reportPatch(
  edited: Uint8Array | Uint8ClampedArray,
  reference: Uint8Array | Uint8ClampedArray,
  original: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  mask: Uint8Array,
): PatchReport {
  let sum = 0;
  let count = 0;
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = y * width + x;
      if (!mask[i]) continue;
      for (let c = 0; c < 3; c += 1) {
        sum += Math.abs((edited[i * 3 + c] ?? 0) - (reference[i * 3 + c] ?? 0));
        count += 1;
      }
    }
  }
  const near = nearWall(mask, width, height);
  return {
    colourOff: count === 0 ? 0 : sum / count,
    wallGrain: highPassSigma(original, width, height, 3, (i) => near[i] === 1),
    patchGrain: highPassSigma(edited, width, height, 3, (i) => mask[i] === 1),
  };
}

/**
 * Adds grain to the masked area of a three-channel photo until it is as grainy as `targetGrain` (levels): a patch that
 * is smoother than the wall around it reads as a flat pasted rectangle. Returns a new array.
 */
export function matchGrain(
  data: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  patchGrain: number,
  targetGrain: number,
  seed = 1,
): Uint8Array {
  // Grain is measured as a mean |pixel - 3x3 mean|; white noise of std s reads 0.752 * s on that scale.
  const missing = Math.sqrt(Math.max(0, targetGrain ** 2 - patchGrain ** 2)) / 0.752;
  const out = new Uint8Array(data);
  if (missing < 0.2) return out;
  const random = lcg(seed);
  for (let i = 0; i < width * height; i += 1) {
    if (!mask[i]) continue;
    const noise = gaussian(random) * missing;
    for (let c = 0; c < 3; c += 1) {
      out[i * 3 + c] = Math.max(0, Math.min(255, Math.round((data[i * 3 + c] ?? 0) + noise)));
    }
  }
  return out;
}

/**
 * The model's detail on the wall's own light: `reference` (the basic fill, the wall around the area continued) supplies
 * the colour and the slow brightness gradient, `edited` only the fine structure on top of ITS OWN average inside the
 * mask. A model that paints a flat colour, a slightly different white, or a gradient of its own therefore cannot leave a
 * visible patch: what it adds beyond the wall is detail, never a new tint. The average is taken over the mask only
 * (normalised blur), so the step between the patch and the untouched wall does not turn into a band at the seam.
 * `radiusPx` is the size of "slow". Returns a new array; outside the mask it is `edited` unchanged.
 */
export function transferDetail(
  edited: Uint8Array | Uint8ClampedArray,
  reference: Uint8Array | Uint8ClampedArray,
  mask: Uint8Array,
  width: number,
  height: number,
  radiusPx: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 3);
  const radius = Math.max(1, Math.round(radiusPx));
  const blur = (plane: Float32Array): Float32Array =>
    boxBlur(boxBlur(plane, width, height, radius), width, height, radius);
  const inside = new Float32Array(width * height);
  for (let i = 0; i < inside.length; i += 1) inside[i] = mask[i] ? 1 : 0;
  const weight = blur(inside);
  for (let c = 0; c < 3; c += 1) {
    const e = new Float32Array(width * height);
    const eInside = new Float32Array(width * height);
    const r = new Float32Array(width * height);
    for (let i = 0; i < e.length; i += 1) {
      e[i] = edited[i * 3 + c] ?? 0;
      eInside[i] = mask[i] ? (e[i] ?? 0) : 0;
      r[i] = reference[i * 3 + c] ?? 0;
    }
    const rInside = new Float32Array(width * height);
    for (let i = 0; i < rInside.length; i += 1) rInside[i] = mask[i] ? (r[i] ?? 0) : 0;
    const eLow = blur(eInside);
    const rLow = blur(rInside);
    for (let i = 0; i < e.length; i += 1) {
      // Outside the mask the photo is not touched at all (the feather at the seam blends edited and original there).
      if (!mask[i]) {
        out[i * 3 + c] = e[i] ?? 0;
        continue;
      }
      // Inside, both averages are taken over the mask only: the wall fill supplies the light, never the objects
      // standing beside the area, and the model's own step against the untouched wall never becomes a band.
      const w = Math.max(weight[i] ?? 0, 1e-6);
      const value = (rLow[i] ?? 0) / w + (e[i] ?? 0) - (eLow[i] ?? 0) / w;
      out[i * 3 + c] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return out;
}
