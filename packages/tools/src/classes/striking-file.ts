/**
 * File / rasp: flat, half-round, round, needle and rasp sections with a wood or plastic handle, steel
 * ferrule and tapered tang (or bare tang / integral grip for needle files). Axis +Y: handle butt at y = 0,
 * file body from y = handleLength to the tip. Teeth are modelled at LOD0 as a saw-tooth ripple of the
 * surface (bands, or a staggered bump field for the rasp). Sizes: DIN 7261 / DIN 8349 series, body
 * length 100..350 mm (4"..14"), flat width 12..35 mm, half-round 14..28 mm, needle 3 x 140 mm.
 */
import { lerp, smoothstep, type V2 } from '../math.ts';
import { loft, lathe, type Station } from '../build/primitives.ts';
import { superellipse } from '../build/rings.ts';
import { METALS, type WoodSpecies, WOODS, plastic, wood } from '../materials.ts';
import { type Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { type Keyed, keyedStations, loftFaceted } from './striking-util.ts';

const TYPES = ['flat', 'half-round', 'round', 'needle', 'rasp'] as const;
const WOOD_LIST = Object.keys(WOODS) as WoodSpecies[];

const schema = {
  type: choice(L('File type', 'Тип напильника'), TYPES, 'flat'),
  length: num(L('File body length', 'Длина полотна'), 200, 100, 350, { step: 5 }),
  width: num(L('Width / diameter', 'Ширина / диаметр'), 20, 3, 40, { step: 0.5 }),
  thickness: num(L('Thickness', 'Толщина'), 5, 1.5, 12, { step: 0.25 }),
  handle: choice(L('Handle', 'Рукоятка'), ['wood', 'plastic', 'none'] as const, 'wood'),
  handleLength: num(L('Handle length', 'Длина рукоятки'), 100, 70, 130, { step: 1 }),
  handleDiameter: num(L('Handle diameter', 'Диаметр рукоятки'), 24, 14, 34, { step: 0.5 }),
  handleWood: choice(L('Wood species', 'Порода дерева'), WOOD_LIST, 'beech'),
  handleColor: color(L('Handle colour', 'Цвет рукоятки'), '#c8262b'),
  finish: choice(L('Steel', 'Сталь'), ['steel', 'darkSteel', 'blackOxide'] as const, 'steel'),
};

type Type = (typeof TYPES)[number];

/** Half-round section: flat face at z = -b, domed face up to z = +b (a = half width). */
function halfRoundRing(a: number, b: number, count: number): V2[] {
  const arc = Math.round(count * 0.7);
  const flat = count - arc - 1;
  const out: V2[] = [];
  for (let i = 0; i <= arc; i++) {
    const t = (i / arc) * Math.PI;
    out.push([a * Math.cos(t), -b + 2 * b * Math.sin(t)]);
  }
  for (let j = 1; j <= flat; j++) out.push([-a + (2 * a * j) / (flat + 1), -b]);
  return out;
}

function sectionRing(type: Type, a: number, b: number, count: number): V2[] {
  if (type === 'flat') return superellipse(a, b, 5, count);
  if (type === 'half-round' || type === 'rasp') return halfRoundRing(a, b, count);
  return superellipse(a, a, 2, count);
}

/** Outward 2-D normals of a closed ring (any winding). */
function ringNormals(ring: readonly V2[]): V2[] {
  const n = ring.length;
  let cx = 0;
  let cz = 0;
  for (const p of ring) {
    cx += p[0] / n;
    cz += p[1] / n;
  }
  return ring.map((p, i) => {
    const a = ring[(i + n - 1) % n] as V2;
    const c = ring[(i + 1) % n] as V2;
    let nx = c[1] - a[1];
    let nz = -(c[0] - a[0]);
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    if (nx * (p[0] - cx) + nz * (p[1] - cz) < 0) {
      nx = -nx;
      nz = -nz;
    }
    return [nx, nz];
  });
}

export const file = defineToolClass({
  id: 'file',
  family: 'striking',
  name: L('File', 'Напильник'),
  bankClass: 'file',
  keywords: {
    en: ['file', 'flat file', 'half-round file', 'round file', 'rasp', 'needle file'],
    ru: ['напильник', 'рашпиль', 'надфиль', 'трёхгранный напильник'],
  },
  schema,
  presets: [
    {
      id: 'flat-200',
      label: L('Flat file 200 mm, wood handle', 'Плоский напильник 200 мм'),
      values: {},
    },
    {
      id: 'half-round-250',
      label: L('Half-round 250 mm, plastic', 'Полукруглый 250 мм'),
      values: {
        type: 'half-round',
        length: 250,
        width: 24,
        thickness: 7.5,
        handle: 'plastic',
        handleLength: 110,
        handleDiameter: 28,
        handleColor: '#2455a8',
      },
    },
    {
      id: 'round-150',
      label: L('Round file 150 mm', 'Круглый напильник 150 мм'),
      values: {
        type: 'round',
        length: 150,
        width: 8,
        handleLength: 90,
        handleDiameter: 22,
        handleWood: 'walnut',
      },
    },
    {
      id: 'rasp-250',
      label: L('Wood rasp 250 mm', 'Рашпиль 250 мм'),
      values: {
        type: 'rasp',
        length: 250,
        width: 28,
        thickness: 8,
        handleLength: 110,
        handleDiameter: 28,
        handleWood: 'beech',
        finish: 'steel',
      },
    },
    {
      id: 'needle-140',
      label: L('Needle file 3 x 140', 'Надфиль 3 x 140'),
      values: {
        type: 'needle',
        length: 140,
        width: 3.5,
        thickness: 1.5,
        handle: 'none',
        handleColor: '#1b1c1e',
        finish: 'steel',
      },
    },
    {
      id: 'flat-350',
      label: L('Flat bastard 350 mm', 'Плоский 350 мм'),
      values: {
        length: 350,
        width: 35,
        thickness: 9,
        handleLength: 125,
        handleDiameter: 32,
        handleWood: 'ash',
      },
    },
  ],
  build(p, ctx) {
    const parts: Part[] = [];
    const steel =
      p.finish === 'steel'
        ? METALS.steel
        : p.finish === 'blackOxide'
          ? METALS.blackOxide
          : METALS.darkSteel;
    const isNeedle = p.type === 'needle';
    const len = p.length;
    const integral = isNeedle && p.handle === 'none';
    const bare = !integral && p.handle === 'none';
    const Lh = integral ? Math.min(60, 0.42 * len) : bare ? 0.2 * len : p.handleLength;
    const yEnd = Lh + len;
    const w = isNeedle ? Math.min(p.width, 5) : p.width;
    const a0 = w / 2;
    const b0 = p.type === 'round' || isNeedle ? a0 : Math.min(p.thickness / 2, a0 * 0.95);
    const R = p.handleDiameter / 2;
    const N = ctx.seg(48, 20);

    // handle
    if (!integral && !bare) {
      const isWood = p.handle === 'wood';
      const flutes = !isWood && ctx.detail ? 10 : 0;
      const ferruleR = Math.max(
        R * 0.52,
        Math.min(R * 0.62, a0 * 0.9 + 2.5),
        Math.hypot(a0, b0) + 1.2,
      );
      const keys: Keyed[] = [
        { y: 0, a: R * 0.72, b: R * 0.72, rib: 0 },
        { y: 3, a: R * 0.94, b: R * 0.94, rib: flutes ? 0.04 : 0 },
        { y: 0.2 * Lh, a: R, b: R, rib: flutes ? 0.06 : 0 },
        { y: 0.55 * Lh, a: R * 0.95, b: R * 0.95, rib: flutes ? 0.06 : 0 },
        { y: 0.85 * Lh, a: R * 0.7, b: R * 0.7, rib: 0 },
        { y: Lh - 3, a: ferruleR * 0.98, b: ferruleR * 0.98, rib: 0 },
      ];
      parts.push({
        name: 'handle',
        role: 'handle',
        material: isWood ? wood(p.handleWood, 0.5) : plastic(p.handleColor, 0.38, 'handle plastic'),
        mesh: loft(keyedStations(keys, flutes ? 80 : N, 4, flutes)),
      });
      parts.push({
        name: 'ferrule',
        role: 'ferrule',
        material: METALS.brass,
        mesh: lathe(
          [
            [ferruleR * 0.96, Lh - 8],
            [ferruleR * 1.04, Lh - 6],
            [ferruleR * 1.04, Lh + 4],
            [ferruleR * 0.9, Lh + 8],
            [Math.max(a0, b0) * 0.6 + 0.6, Lh + 10],
          ],
          ctx.seg(36, 16),
        ),
      });
    } else if (integral) {
      const gr = Math.max(2.8, a0 * 0.95 + 1.4);
      parts.push({
        name: 'grip',
        role: 'grip',
        material: plastic(p.handleColor, 0.5, 'needle file grip'),
        mesh: lathe(
          [
            [gr * 0.85, 0],
            [gr, 1.5],
            [gr * 1.04, 0.5 * Lh],
            [gr, 0.9 * Lh],
            [gr * 0.78, Lh],
          ],
          ctx.seg(24, 12),
        ),
      });
    }

    // tang
    const tangTop = Lh;
    const tangBottom = bare ? 0 : integral ? 0.1 * Lh : 0.25 * Lh;
    const tangKeys: Keyed[] = [
      { y: tangBottom, a: 0.6, b: 0.6, n: 4 },
      { y: tangTop, a: Math.max(1.4, a0 * 0.4), b: Math.max(1.2, b0 * 0.5), n: 4 },
    ];
    parts.push({
      name: 'tang',
      role: 'tang',
      material: steel,
      mesh: loftFaceted(tangKeys, ctx.seg(16, 8)),
    });

    // body: taper, tip, teeth
    const widthAt = (u: number): number =>
      (u < 0.55 ? 1 : lerp(1, p.type === 'round' ? 0.6 : 0.8, smoothstep(0.55, 1, u))) *
      (u > 0.97 ? 0.35 + (1 - u) * 22 : 1);
    const teeth = ctx.detail;
    const pitch = p.type === 'rasp' ? 3.4 : Math.max(1.7, Math.min(3.4, w * 0.12));
    const depth = p.type === 'rasp' ? Math.min(0.7, 0.4 * b0) : Math.min(0.45, 0.07 * b0 + 0.18);
    const heelPlain = 0.07 * len;
    const stations: Station[] = [];
    const specs: { y: number; f: number; tooth: number }[] = [];
    const smoothEnd = yEnd - 0.03 * len;
    specs.push({ y: Lh, f: widthAt(0), tooth: 0 });
    if (teeth) {
      const perPitch = p.type === 'rasp' ? 4 : 2;
      const start = Lh + heelPlain;
      const stop = yEnd - 0.03 * len;
      const count = Math.floor((stop - start) / pitch);
      specs.push({ y: start - 0.01, f: widthAt((start - Lh) / len), tooth: 0 });
      for (let k = 0; k < count; k++) {
        for (let s = 0; s < perPitch; s++) {
          const frac = s / perPitch;
          const y = start + (k + frac) * pitch;
          const tooth = p.type === 'rasp' ? 1 + frac : frac * (perPitch === 2 ? 1.7 : 1);
          specs.push({ y, f: widthAt((y - Lh) / len), tooth });
        }
      }
      specs.push({
        y: start + count * pitch,
        f: widthAt((start + count * pitch - Lh) / len),
        tooth: 0,
      });
    } else {
      for (let i = 1; i < 12; i++) {
        const y = Lh + (i / 12) * (smoothEnd - Lh);
        specs.push({ y, f: widthAt((y - Lh) / len), tooth: 0 });
      }
    }
    const tipY = [smoothEnd + 0.4 * (yEnd - smoothEnd), smoothEnd + 0.8 * (yEnd - smoothEnd), yEnd];
    for (const y of tipY) specs.push({ y, f: widthAt((y - Lh) / len), tooth: 0 });
    const baseRing = sectionRing(p.type, a0, b0, N);
    const normals = ringNormals(baseRing);
    const rasp = p.type === 'rasp';
    for (const sp of specs) {
      const ring = sectionRing(p.type, a0 * sp.f, Math.max(b0 * lerp(1, sp.f, 0.6), 0.35), N);
      const out: V2[] = ring.map((q, i) => {
        const n = normals[i] as V2;
        const onFace = p.type === 'flat' ? Math.min(1, Math.abs(n[1]) * 1.5) : 1;
        let t = sp.tooth;
        if (rasp && sp.tooth > 0) {
          const ph = (i % 2) * 0.5;
          const x = sp.tooth - 1 + ph;
          t = 0.5 + 0.5 * Math.cos(2 * Math.PI * x);
          t *= 0.6 + 0.4 * Math.cos(i * 0.9);
          t = Math.max(0, t);
        }
        const d = -depth * t * onFace;
        return [q[0] + n[0] * d, q[1] + n[1] * d];
      });
      stations.push({ y: sp.y, ring: out });
    }
    // sort guard: loft expects ordered stations
    stations.sort((x, y) => x.y - y.y);
    const dedup: Station[] = [];
    for (const st of stations) {
      const last = dedup[dedup.length - 1];
      if (last && st.y - last.y < 1e-3) continue;
      dedup.push(st);
    }
    parts.push({
      name: 'body',
      role: 'blade',
      material: steel,
      mesh: loft(dedup),
      crease: 40,
    });

    return {
      parts,
      hang: { point: [0, Lh, 0], kind: 'neck' },
      zones: [
        { name: 'handle', y0: 0, y1: Lh },
        { name: 'body', y0: Lh, y1: yEnd },
      ],
      dims: {
        length: yEnd,
        handleLength: Lh,
        handleDiameter: integral
          ? 2 * Math.max(2.8, a0 * 0.95 + 1.4) * 1.04
          : bare
            ? 0
            : p.handleDiameter,
        fileLength: len,
        width: w,
        thickness: b0 * 2,
      },
    };
  },
});
