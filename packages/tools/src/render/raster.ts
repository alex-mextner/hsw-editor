/**
 * Dependency-free software renderer: orthographic z-buffer with supersampling and a small PBR-ish shader
 * (studio environment reflection for metals, Blinn-Phong for plastics). Used for contact sheets (visual
 * review of every generator), silhouettes (photo fitting) and prototype images (recognition).
 * Not a game engine: single-threaded, ~100-300 ms for a 512 px tile of a 50k triangle tool.
 */
import { type V3, clamp, cross, dot, norm, smoothstep } from '../math.ts';
import { hexToRgb } from '../materials.ts';
import type { ToolModel } from '../model.ts';
import { type ShadedMesh, shade } from '../mesh.ts';

export interface ViewSpec {
  /** Camera direction from the object towards the eye, tool frame. */
  eye: V3;
  /** Image up vector (projected). */
  up: V3;
}

export const VIEWS = {
  /** From the viewer side (+Z), tip up: the photo-from-above / wall view. */
  front: { eye: [0, 0, 1], up: [0, 1, 0] },
  back: { eye: [0, 0, -1], up: [0, 1, 0] },
  /** From +X, tip up: the thickness profile. */
  side: { eye: [1, 0, 0], up: [0, 1, 0] },
  /** Looking down the tool axis from the working end. */
  end: { eye: [0, 1, 0], up: [0, 0, -1] },
  iso: { eye: [0.62, 0.28, 0.73], up: [0, 1, 0] },
  iso2: { eye: [-0.66, 0.2, 0.72], up: [0, 1, 0] },
  iso3: { eye: [0.5, 0.75, 0.43], up: [0, 1, 0] },
} as const satisfies Record<string, ViewSpec>;
export type ViewName = keyof typeof VIEWS;

export interface RenderOptions {
  width: number;
  height: number;
  view: ViewSpec;
  /** Supersampling factor per axis (default 2). */
  ssaa?: number;
  /** Fraction of the tile left empty around the object (default 0.08). */
  margin?: number;
  /** Fixed scale in pixels per mm; default fits the object into the tile. */
  pixelsPerMm?: number;
  /** Background colour or null for transparent (RGBA alpha 0). */
  background?: string | null;
  /** Centre of the view in the tool frame; default centre of the bounds. */
  center?: V3;
}

export interface RenderResult {
  width: number;
  height: number;
  /** RGBA8. */
  rgba: Uint8ClampedArray;
  /** Coverage 0..255 per pixel (silhouette). */
  mask: Uint8Array;
  pixelsPerMm: number;
}

function camera(view: ViewSpec): { right: V3; up: V3; back: V3 } {
  const back = norm(view.eye);
  let right = cross(view.up, back);
  if (dot(right, right) < 1e-8) right = cross([0, 0, 1], back);
  right = norm(right);
  const up = norm(cross(back, right));
  return { right, up, back };
}

interface Shader {
  color: [number, number, number];
  metallic: number;
  roughness: number;
  alpha: number;
  /** Blinn-Phong exponent derived from the roughness (constant per material). */
  shininess: number;
}

const srgb2lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin2srgb = (c: number): number =>
  255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** Studio environment: soft top box, side strip lights and a dark floor; direction in view space. */
function environment(x: number, y: number, z: number): number {
  const top = 0.55 * Math.exp(-(((y - 0.75) / 0.35) ** 2));
  const strip = 0.7 * Math.exp(-(((x + 0.65) / 0.16) ** 2)) * smoothstep(-0.3, 0.2, y);
  const strip2 = 0.4 * Math.exp(-(((x - 0.7) / 0.22) ** 2)) * smoothstep(-0.3, 0.2, y);
  const front = 0.25 * Math.exp(-(((z - 0.8) / 0.4) ** 2));
  const floor = 0.12 + 0.12 * smoothstep(-1, 0, y);
  return floor + top + strip + strip2 + front;
}

const LIGHT_DEFS: readonly { dir: V3; power: number }[] = [
  { dir: norm([-0.45, 0.75, 0.62]), power: 0.95 },
  { dir: norm([0.8, 0.15, 0.55]), power: 0.38 },
  { dir: norm([0.1, -0.6, 0.3]), power: 0.18 },
];
/** The camera is orthographic along +Z, so the half vectors are constants. */
const LIGHTS = LIGHT_DEFS.map((l) => ({ ...l, half: norm([l.dir[0], l.dir[1], l.dir[2] + 1]) }));

function shadePixel(sh: Shader, nx: number, ny: number, nz: number): [number, number, number] {
  const nl = Math.hypot(nx, ny, nz) || 1;
  const n: V3 = [nx / nl, ny / nl, nz / nl];
  // view vector is +Z in view space (orthographic camera)
  const ndv = Math.max(0, n[2]);
  const hemi = 0.32 + 0.2 * n[1];
  let diff = hemi;
  let spec = 0;
  const shininess = sh.shininess;
  for (const l of LIGHTS) {
    const ndl = Math.max(0, dot(n, l.dir));
    diff += l.power * ndl;
    spec += l.power * Math.max(0, dot(n, l.half)) ** Math.min(shininess, 400);
  }
  const r2: V3 = [2 * ndv * n[0], 2 * ndv * n[1], 2 * ndv * n[2] - 1];
  const env = environment(r2[0], r2[1], r2[2]);
  // blur the environment lookup with roughness
  const envMean = 0.45;
  const envSeen = envMean + (env - envMean) * (1 - 0.8 * sh.roughness);
  const fres = 0.04 + 0.96 * (1 - ndv) ** 5;
  const specNorm = ((shininess + 8) / (8 * Math.PI)) * 0.35;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const base = sh.color[k] as number;
    const dielectric = base * diff * (1 - sh.metallic);
    const metalPart =
      base * envSeen * 1.15 * sh.metallic + sh.metallic * base * 0.5 * spec * specNorm;
    const gloss =
      (1 - sh.metallic) * (fres * envSeen * (1 - sh.roughness) + spec * specNorm * 0.25);
    out[k] = dielectric * 0.82 + metalPart + gloss;
  }
  return out;
}

export function render(model: ToolModel, options: RenderOptions): RenderResult {
  const ssaa = options.ssaa ?? 2;
  const W = options.width * ssaa;
  const H = options.height * ssaa;
  const cam = camera(options.view);
  const centre: V3 =
    options.center ??
    ([
      (model.bounds.min[0] + model.bounds.max[0]) / 2,
      (model.bounds.min[1] + model.bounds.max[1]) / 2,
      (model.bounds.min[2] + model.bounds.max[2]) / 2,
    ] as V3);

  // projected triangle soup in flat typed arrays: 9 floats of position and 9 of normal per triangle
  const shaders: Shader[] = [];
  const meshes = model.parts.map((part) => shade(part.mesh, part.crease ?? 50));
  const triCount = meshes.reduce((a, m) => a + m.indices.length / 3, 0);
  const P = new Float64Array(triCount * 9);
  const N = new Float32Array(triCount * 9);
  const partOf = new Int32Array(triCount);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let ti = 0;
  const [rx, ry, rz] = cam.right;
  const [ux, uy, uz] = cam.up;
  const [bx0, by0, bz0] = cam.back;
  model.parts.forEach((part, pi) => {
    const m = part.material;
    const roughness = m.roughness;
    shaders.push({
      color: hexToRgb(m.color).map((c) => srgb2lin(c / 255)) as [number, number, number],
      metallic: m.metallic,
      roughness,
      alpha: m.alpha,
      shininess: 2 / Math.max(0.02, roughness ** 4) - 2,
    });
    const s = meshes[pi] as ShadedMesh;
    for (let t = 0; t < s.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const i = (s.indices[t + k] as number) * 3;
        const px = (s.positions[i] as number) - centre[0];
        const py = (s.positions[i + 1] as number) - centre[1];
        const pz = (s.positions[i + 2] as number) - centre[2];
        const vx = px * rx + py * ry + pz * rz;
        const vy = px * ux + py * uy + pz * uz;
        const o = ti * 9 + k * 3;
        P[o] = vx;
        P[o + 1] = vy;
        P[o + 2] = px * bx0 + py * by0 + pz * bz0;
        const nx = s.normals[i] as number;
        const ny = s.normals[i + 1] as number;
        const nz = s.normals[i + 2] as number;
        N[o] = nx * rx + ny * ry + nz * rz;
        N[o + 1] = nx * ux + ny * uy + nz * uz;
        N[o + 2] = nx * bx0 + ny * by0 + nz * bz0;
        if (vx < minX) minX = vx;
        if (vx > maxX) maxX = vx;
        if (vy < minY) minY = vy;
        if (vy > maxY) maxY = vy;
      }
      partOf[ti++] = pi;
    }
  });

  const margin = options.margin ?? 0.08;
  const fit = Math.min(
    (W * (1 - 2 * margin)) / Math.max(1e-6, maxX - minX),
    (H * (1 - 2 * margin)) / Math.max(1e-6, maxY - minY),
  );
  const scale = options.pixelsPerMm ? options.pixelsPerMm * ssaa : fit;
  // an explicit centre is the middle of the image; otherwise the middle of the projected bounds
  const cx = options.center ? W / 2 : W / 2 - ((minX + maxX) / 2) * scale;
  const cy = options.center ? H / 2 : H / 2 + ((minY + maxY) / 2) * scale;
  // to screen space in place
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      P[o] = (P[o] as number) * scale + cx;
      P[o + 1] = cy - (P[o + 1] as number) * scale;
    }
  }

  const depth = new Float32Array(W * H).fill(-Infinity);
  const tri = new Int32Array(W * H).fill(-1);
  const bu = new Float32Array(W * H);
  const bv = new Float32Array(W * H);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = P[o] as number;
    const ay = P[o + 1] as number;
    const az = P[o + 2] as number;
    const bx = P[o + 3] as number;
    const by = P[o + 4] as number;
    const bz = P[o + 5] as number;
    const qx = P[o + 6] as number;
    const qy = P[o + 7] as number;
    const qz = P[o + 8] as number;
    const area = (bx - ax) * (qy - ay) - (qx - ax) * (by - ay);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, qx)));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, qx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, qy)));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, qy)));
    const inv = 1 / area;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        const w1 = ((px - ax) * (qy - ay) - (qx - ax) * (py - ay)) * inv;
        const w2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * inv;
        const w0 = 1 - w1 - w2;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * az + w1 * bz + w2 * qz;
        const idx = y * W + x;
        if (z > (depth[idx] as number)) {
          depth[idx] = z;
          tri[idx] = t;
          bu[idx] = w1;
          bv[idx] = w2;
        }
      }
    }
  }

  const bg = options.background === null ? null : hexToRgb(options.background ?? '#eceff3');
  const outW = options.width;
  const outH = options.height;
  const rgba = new Uint8ClampedArray(outW * outH * 4);
  const mask = new Uint8Array(outW * outH);
  const n2 = ssaa * ssaa;
  // shade each supersample once
  const sampleColor = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const t = tri[i] as number;
    if (t < 0) continue;
    const w1 = bu[i] as number;
    const w2 = bv[i] as number;
    const w0 = 1 - w1 - w2;
    const o = t * 9;
    const nx = w0 * (N[o] as number) + w1 * (N[o + 3] as number) + w2 * (N[o + 6] as number);
    const ny = w0 * (N[o + 1] as number) + w1 * (N[o + 4] as number) + w2 * (N[o + 7] as number);
    const nz = w0 * (N[o + 2] as number) + w1 * (N[o + 5] as number) + w2 * (N[o + 8] as number);
    const sh = shaders[partOf[t] as number] as Shader;
    const c = shadePixel(sh, nx, ny, nz);
    sampleColor[i * 3] = c[0];
    sampleColor[i * 3 + 1] = c[1];
    sampleColor[i * 3 + 2] = c[2];
  }
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let cov = 0;
      for (let sy = 0; sy < ssaa; sy++) {
        for (let sx = 0; sx < ssaa; sx++) {
          const i = (y * ssaa + sy) * W + x * ssaa + sx;
          if ((tri[i] as number) < 0) continue;
          cov++;
          r += sampleColor[i * 3] as number;
          g += sampleColor[i * 3 + 1] as number;
          b += sampleColor[i * 3 + 2] as number;
        }
      }
      const o = (y * outW + x) * 4;
      const a = cov / n2;
      mask[y * outW + x] = Math.round(a * 255);
      const bgy = y / outH;
      const back: [number, number, number] = bg
        ? [bg[0] * (1 - 0.1 * bgy), bg[1] * (1 - 0.1 * bgy), bg[2] * (1 - 0.08 * bgy)]
        : [0, 0, 0];
      if (cov > 0) {
        const fr = lin2srgb(clamp(r / cov, 0, 1));
        const fg = lin2srgb(clamp(g / cov, 0, 1));
        const fb = lin2srgb(clamp(b / cov, 0, 1));
        // straight (non-premultiplied) colour when the background is transparent
        rgba[o] = bg ? fr * a + back[0] * (1 - a) : fr;
        rgba[o + 1] = bg ? fg * a + back[1] * (1 - a) : fg;
        rgba[o + 2] = bg ? fb * a + back[2] * (1 - a) : fb;
        rgba[o + 3] = bg ? 255 : Math.round(a * 255);
      } else {
        rgba[o] = back[0];
        rgba[o + 1] = back[1];
        rgba[o + 2] = back[2];
        rgba[o + 3] = bg ? 255 : 0;
      }
    }
  }
  return { width: outW, height: outH, rgba, mask, pixelsPerMm: scale / ssaa };
}
