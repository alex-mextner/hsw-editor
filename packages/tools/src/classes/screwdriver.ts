/**
 * Screwdriver: six tip types x six handle styles. Axis +Y, butt at y = 0, handle 0..handleLength, exposed
 * shaft handleLength..handleLength+shaftLength, tip at the far end. Parts: handle (+ grip / cap),
 * bolster or ferrule, shaft, tip. Sizes cross-checked with HSW refit/design.json (shaft 3..6.5 mm,
 * tip width 3.5..7.5 mm, handle 62..98 mm, shaft 75..130 mm).
 */
import { compose, lerp, rotationZ, smoothstep, translation, type V2 } from '../math.ts';
import { type Mesh, transformMesh } from '../mesh.ts';
import { type Station, lathe, loft } from '../build/primitives.ts';
import {
  polarRing,
  polygonPolar,
  crossPolar,
  profileStations,
  sampleProfile,
  smoothProfile,
} from '../build/profile.ts';
import {
  circleRing,
  flutedRing,
  lobedRing,
  polygonRing,
  scaleRing,
  superellipse,
} from '../build/rings.ts';
import {
  METALS,
  type Material,
  type WoodSpecies,
  WOODS,
  plastic,
  rubber,
  wood,
} from '../materials.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass, type BuildCtx } from '../registry.ts';

const TIPS = ['slotted', 'phillips', 'pozidriv', 'torx', 'hex', 'square'] as const;
const HANDLES = ['classic', 'ergonomic', 'cushion', 'octagonal', 'precision', 'T-grip'] as const;
const WOODS_LIST = Object.keys(WOODS) as WoodSpecies[];

const schema = {
  tip: choice(L('Tip type', 'Тип шлица'), TIPS, 'slotted'),
  handle: choice(L('Handle style', 'Форма рукоятки'), HANDLES, 'classic'),
  tipSize: num(L('Tip width / across flats', 'Ширина шлица'), 6.5, 1.5, 12, { step: 0.1 }),
  shaftDiameter: num(L('Shaft diameter', 'Диаметр стержня'), 5.5, 2, 9, { step: 0.1 }),
  shaftLength: num(L('Shaft length', 'Длина стержня'), 100, 25, 300, { step: 1 }),
  handleLength: num(L('Handle length', 'Длина рукоятки'), 95, 45, 160, { step: 1 }),
  handleDiameter: num(L('Handle diameter', 'Диаметр рукоятки'), 30, 9, 46, { step: 0.5 }),
  bolster: choice(L('Bolster', 'Шестигранник у основания'), ['none', 'hex'] as const, 'none'),
  shaftFinish: choice(
    L('Shaft finish', 'Покрытие стержня'),
    ['chrome', 'steel', 'blackOxide'] as const,
    'chrome',
  ),
  handleColor: color(L('Handle colour', 'Цвет рукоятки'), '#c8262b'),
  gripColor: color(L('Grip colour', 'Цвет накладки'), '#1b1c1e'),
  handleWood: choice(L('Wood (octagonal handle)', 'Порода дерева'), WOODS_LIST, 'beech'),
};

/** Control profiles [t along the handle, radius factor]; first/last factor 0 = dome. */
const PROFILES: Record<(typeof HANDLES)[number], readonly V2[]> = {
  classic: [
    [0, 0],
    [0.015, 0.6],
    [0.05, 0.86],
    [0.12, 0.97],
    [0.28, 1],
    [0.5, 0.93],
    [0.76, 0.78],
    [0.92, 0.66],
    [1, 0.62],
  ],
  ergonomic: [
    [0, 0],
    [0.02, 0.62],
    [0.07, 0.86],
    [0.17, 0.98],
    [0.3, 1],
    [0.46, 0.9],
    [0.58, 0.84],
    [0.74, 0.88],
    [0.88, 0.78],
    [0.96, 0.6],
    [1, 0.5],
  ],
  cushion: [
    [0, 0],
    [0.02, 0.6],
    [0.09, 0.9],
    [0.22, 1],
    [0.5, 1],
    [0.74, 0.92],
    [0.9, 0.74],
    [0.97, 0.6],
    [1, 0.56],
  ],
  octagonal: [
    [0, 0.7],
    [0.03, 0.9],
    [0.14, 1],
    [0.55, 0.95],
    [0.86, 0.74],
    [0.97, 0.66],
    [1, 0.64],
  ],
  precision: [
    [0, 0.62],
    [0.04, 0.86],
    [0.1, 1],
    [0.7, 1],
    [0.88, 0.9],
    [0.96, 0.7],
    [1, 0.62],
  ],
  'T-grip': [
    [0, 0.5],
    [0.05, 0.75],
    [0.2, 0.9],
    [0.5, 1],
    [0.85, 0.9],
    [1, 0.7],
  ],
};

interface HandleResult {
  parts: Part[];
  /** Radius where the handle meets the ferrule / shaft. */
  neckRadius: number;
}

function shaftMaterial(finish: 'chrome' | 'steel' | 'blackOxide'): Material {
  return finish === 'chrome'
    ? METALS.chrome
    : finish === 'steel'
      ? METALS.steel
      : METALS.blackOxide;
}

function buildHandle(
  style: (typeof HANDLES)[number],
  Lh: number,
  R: number,
  colors: { handle: string; grip: string; wood: WoodSpecies },
  ctx: BuildCtx,
): HandleResult {
  const N = ctx.seg(96, 36);
  const control = PROFILES[style];
  const last = control[control.length - 1] as V2;
  const neckRadius = R * last[1];
  const hardMat = plastic(colors.handle, 0.38, 'handle plastic');
  const softMat = rubber(colors.grip, 'ribbed', 'grip rubber');
  const parts: Part[] = [];
  const fade = (t: number, a: number, b: number): number =>
    smoothstep(a, a + 0.12, t) * (1 - smoothstep(b - 0.12, b, t));

  if (style === 'classic') {
    const flutes = 12;
    const stations = profileStations(control, 0, Lh, (f, t) =>
      flutedRing(R * f, flutes, 0.045 * R * fade(t, 0.05, 0.9), N),
    );
    parts.push({
      name: 'handle',
      role: 'handle',
      material: hardMat,
      mesh: loft(stations),
      crease: 60,
    });
  } else if (style === 'ergonomic') {
    // hard core under a soft over-mould: the core shows at butt and neck
    const core = profileStations(control, 0, Lh, (f) =>
      scaleRing(circleRing(R * f * 0.93, N), 1, 0.9),
    );
    parts.push({ name: 'handle', role: 'handle', material: hardMat, mesh: loft(core), crease: 60 });
    const a = 0.1;
    const b = 0.9;
    const gripCtl = control.filter(([t]) => t >= a && t <= b);
    const edge = (t: number): V2 => [t, sampleProfile(control, t)];
    const gc: V2[] = [edge(a), ...gripCtl.filter(([t]) => t > a && t < b), edge(b)];
    const grip = profileStations(gc, 0, Lh, (f, t) =>
      scaleRing(
        flutedRing(
          R * f,
          6,
          0.035 * R * smoothstep(a, a + 0.12, t) * (1 - smoothstep(b - 0.12, b, t)),
          N,
        ),
        1,
        0.9,
      ),
    );
    parts.push({ name: 'grip', role: 'grip', material: softMat, mesh: loft(grip), crease: 55 });
  } else if (style === 'cushion') {
    // soft tri-lobe body between a hard butt cap and a hard neck
    const a = 0.08;
    const b = 0.9;
    const gc: V2[] = [
      [a, sampleProfile(control, a)],
      ...control.filter(([t]) => t > a && t < b),
      [b, sampleProfile(control, b)],
    ];
    const soft = profileStations(gc, 0, Lh, (f, t) => {
      const amp = 0.075 * R * f * smoothstep(a, a + 0.14, t) * (1 - smoothstep(b - 0.14, b, t));
      return lobedRing(R * f, amp, 3, N);
    });
    const core = profileStations(control, 0, Lh, (f) => circleRing(R * f * 0.9, N));
    parts.push({ name: 'handle', role: 'handle', material: hardMat, mesh: loft(core), crease: 60 });
    parts.push({ name: 'grip', role: 'grip', material: softMat, mesh: loft(soft), crease: 55 });
  } else if (style === 'octagonal') {
    const mat = wood(colors.wood, 0.55);
    const stations = profileStations(control, 0, Lh, (f) =>
      polygonRing(8, (R * f) / Math.cos(Math.PI / 8), N, false),
    );
    parts.push({ name: 'handle', role: 'handle', material: mat, mesh: loft(stations), crease: 30 });
  } else if (style === 'precision') {
    // slim knurled barrel with a freely spinning cap on top
    const capEnd = 0.12;
    const body = control.filter(([t]) => t >= capEnd);
    const bc: V2[] = [[capEnd, 1], ...body.filter(([t]) => t > capEnd)];
    const barrel = profileStations(bc, 0, Lh, (f, t) =>
      flutedRing(R * f, 24, 0.03 * R * (1 - smoothstep(0.85, 1, t)), N),
    );
    parts.push({
      name: 'handle',
      role: 'handle',
      material: hardMat,
      mesh: loft(barrel),
      crease: 60,
    });
    const cap = profileStations(
      [
        [0, 0],
        [0.07, 0.72],
        [0.3, 0.9],
        [0.8, 0.96],
        [1, 0.94],
      ],
      0,
      lerp(0, Lh, capEnd) - 0.4,
      (f) => circleRing(R * f, N),
    );
    parts.push({
      name: 'cap',
      role: 'cap',
      material: plastic(colors.grip, 0.3, 'swivel cap'),
      mesh: loft(cap),
      crease: 60,
    });
  } else {
    // T-grip: a bar across the top, a short stem below; the stem starts inside the bar
    const barY = R * 0.5 + 0.04 * Lh;
    const stemStart = barY;
    const stem = profileStations(
      [
        [0, 0.55],
        [0.1, 0.58],
        [0.6, 0.5],
        [1, 0.46],
      ],
      stemStart,
      Lh,
      (f) => circleRing(R * f * 0.62, N),
    );
    parts.push({ name: 'handle', role: 'handle', material: hardMat, mesh: loft(stem), crease: 60 });
    const barR = R * 0.5;
    const bar = loft(
      smoothProfile(
        [
          [0, 0],
          [0.03, 0.8],
          [0.5, 1],
          [0.97, 0.8],
          [1, 0],
        ],
        5,
      ).map(([t, f]) => ({
        y: (t - 0.5) * 2 * R * 1.8,
        ring: circleRing(Math.max(0, barR * f), N),
      })),
    );
    // bar lies along X: rotate the Y-axis lathe onto X and sit it at the butt
    parts.push({
      name: 'grip',
      role: 'grip',
      material: softMat,
      mesh: placeBar(bar, barY),
      crease: 55,
    });
    return { parts, neckRadius: R * 0.62 * 0.46 };
  }
  return { parts, neckRadius };
}

/** Lay a Y-axis lathe along X with its centre at y = yc. */
function placeBar(mesh: Mesh, yc: number): Mesh {
  return transformMesh(mesh, compose(translation(0, yc, 0), rotationZ(90)));
}

/** Tip stations from the shaft end (y = yS) to the tip (y = yS + Lt). */
function tipStations(
  tip: (typeof TIPS)[number],
  shaftR: number,
  size: number,
  yS: number,
  Lt: number,
  ctx: BuildCtx,
): Station[] {
  const K = ctx.seg(14, 7);
  const N = ctx.seg(96, 48);
  const out: Station[] = [];
  const tipR = size / 2;
  if (tip === 'slotted') {
    const thick = Math.max(0.5, 0.15 * size + 0.15);
    const Nn = ctx.seg(64, 32);
    for (let k = 0; k <= K; k++) {
      const u = k / K;
      const s = smoothstep(0, 0.7, u);
      const a = lerp(shaftR, tipR, s);
      const b = lerp(shaftR, thick / 2, s);
      const n = lerp(2, 9, s);
      // final 0.6 mm: ground tip edge
      const edge = u > 0.97 ? 0.72 : 1;
      out.push({ y: yS + Lt * u, ring: superellipse(a, b * edge, n, Nn) });
    }
    return out;
  }
  for (let k = 0; k <= K; k++) {
    const u = k / K;
    const blend = smoothstep(0, 0.5, u);
    let outerR: number;
    let shape: (theta: number) => number;
    if (tip === 'phillips' || tip === 'pozidriv') {
      const reach = lerp(shaftR * 1.0, tipR * 0.42, u ** 1.2);
      const thick = lerp(shaftR * 0.9, tipR * 0.17, u ** 0.9) + 0.12;
      outerR = lerp(shaftR, reach, u);
      const cross = crossPolar(reach, thick);
      const diag = crossPolar(reach * 0.7, thick * 0.55, Math.PI / 4);
      shape = tip === 'pozidriv' ? (t) => Math.max(cross(t), diag(t)) : cross;
    } else if (tip === 'torx') {
      outerR = lerp(shaftR, tipR, smoothstep(0, 0.6, u));
      shape = (t) => outerR * (0.9 + 0.1 * Math.cos(6 * t));
    } else if (tip === 'hex') {
      outerR = lerp(shaftR, tipR, smoothstep(0, 0.6, u));
      shape = polygonPolar(6, outerR * 0.9);
    } else {
      outerR = lerp(shaftR, tipR, smoothstep(0, 0.6, u));
      shape = polygonPolar(4, outerR * 0.85);
    }
    const r0 = outerR;
    out.push({
      y: yS + Lt * u,
      ring: polarRing((t) => lerp(r0, Math.min(shape(t), r0 * 1.5), blend), N),
    });
  }
  return out;
}

export const screwdriver = defineToolClass({
  id: 'screwdriver',
  family: 'drivers',
  name: L('Screwdriver', 'Отвёртка'),
  bankClass: 'screwdriver',
  keywords: {
    en: [
      'screwdriver',
      'phillips screwdriver',
      'flathead screwdriver',
      'torx screwdriver',
      'precision screwdriver',
    ],
    ru: ['отвертка', 'крестовая отвертка', 'шлицевая отвертка'],
  },
  schema,
  presets: [
    {
      id: 'slotted-classic',
      label: L('Slotted, classic handle', 'Шлицевая, классическая'),
      values: {},
    },
    {
      id: 'phillips-ergonomic',
      label: L('Phillips PH2, ergonomic', 'Крестовая PH2, эргономичная'),
      values: {
        tip: 'phillips',
        handle: 'ergonomic',
        tipSize: 6,
        shaftDiameter: 6,
        shaftLength: 100,
        handleColor: '#d8d8d8',
        gripColor: '#e8741e',
        handleLength: 105,
        handleDiameter: 34,
      },
    },
    {
      id: 'torx-cushion',
      label: L('Torx T25, cushion grip', 'Torx T25, мягкая'),
      values: {
        tip: 'torx',
        handle: 'cushion',
        tipSize: 4.4,
        shaftDiameter: 5,
        shaftLength: 110,
        handleColor: '#d9b21c',
        gripColor: '#1b1c1e',
        handleLength: 100,
        handleDiameter: 32,
      },
    },
    {
      id: 'hex-octagonal',
      label: L('Hex 4, wood octagonal', 'Шестигранная, деревянная'),
      values: {
        tip: 'hex',
        handle: 'octagonal',
        tipSize: 4,
        shaftDiameter: 5,
        shaftLength: 90,
        handleLength: 90,
        handleDiameter: 26,
        bolster: 'hex',
        handleWood: 'beech',
      },
    },
    {
      id: 'precision-slotted',
      label: L('Precision slotted 2.4', 'Часовая шлицевая 2.4'),
      values: {
        tip: 'slotted',
        handle: 'precision',
        tipSize: 2.4,
        shaftDiameter: 2.5,
        shaftLength: 40,
        handleLength: 62,
        handleDiameter: 9.5,
        handleColor: '#26272a',
        gripColor: '#c0c3c8',
      },
    },
    {
      id: 'pozidriv-t-grip',
      label: L('Pozidriv PZ2, T-grip', 'PZ2, Т-образная'),
      values: {
        tip: 'pozidriv',
        handle: 'T-grip',
        tipSize: 6,
        shaftDiameter: 6.5,
        shaftLength: 150,
        handleLength: 90,
        handleDiameter: 36,
        handleColor: '#2455a8',
        gripColor: '#2455a8',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const R = p.handleDiameter / 2;
    const Lh = p.handleLength;
    const shaftR = p.shaftDiameter / 2;
    const handle = buildHandle(
      p.handle,
      Lh,
      R,
      { handle: p.handleColor, grip: p.gripColor, wood: p.handleWood },
      ctx,
    );
    const parts: Part[] = [...handle.parts];
    const shaftMat = shaftMaterial(p.shaftFinish);
    const tipLen = Math.min(p.shaftLength * 0.4, p.tip === 'slotted' ? 16 : 14);
    const yTip0 = Lh + p.shaftLength - tipLen;
    const yEnd = Lh + p.shaftLength;
    const insideStart = Lh * 0.6;
    const seg = ctx.seg(40, 20);

    // ferrule / bolster
    const neckR = handle.neckRadius;
    const ferruleR = Math.max(shaftR * 1.5, Math.min(neckR * 0.98, R * 0.62));
    if (p.bolster === 'hex' || p.handle === 'octagonal') {
      const across = Math.max(shaftR * 3, ferruleR * 1.6);
      const hexRing = polygonRing(6, across / 2 / Math.cos(Math.PI / 6), ctx.seg(36, 12), true);
      parts.push({
        name: 'bolster',
        role: 'ferrule',
        material: METALS.chrome,
        mesh: loft([
          { y: Lh - 1, ring: scaleRing(hexRing, 0.96) },
          { y: Lh, ring: hexRing },
          { y: Lh + 14, ring: hexRing },
          { y: Lh + 15, ring: scaleRing(hexRing, 0.9) },
        ]),
        crease: 25,
      });
    } else {
      parts.push({
        name: 'ferrule',
        role: 'ferrule',
        material: METALS.chrome,
        mesh: lathe(
          [
            [ferruleR * 1.0, Lh - 7],
            [ferruleR * 1.03, Lh - 5],
            [ferruleR * 1.03, Lh + 1],
            [ferruleR * 0.8, Lh + 4],
            [shaftR * 1.5, Lh + 9],
            [shaftR * 1.25, Lh + 12],
          ],
          seg,
        ),
      });
    }

    parts.push({
      name: 'shaft',
      role: 'shaft',
      material: shaftMat,
      mesh: lathe(
        [
          [shaftR, insideStart],
          [shaftR, yTip0],
        ],
        seg,
      ),
    });
    const tipMat = p.tip === 'slotted' ? shaftMat : METALS.blackOxide;
    parts.push({
      name: 'tip',
      role: 'tip',
      material: tipMat,
      mesh: loft(tipStations(p.tip, shaftR, p.tipSize, yTip0, tipLen, ctx)),
      crease: 30,
    });
    const tipWidth = p.tip === 'slotted' ? p.tipSize : p.tipSize;
    return {
      parts,
      hang: { point: [0, Lh, 0], kind: 'neck' },
      zones: [
        { name: 'handle', y0: 0, y1: Lh },
        { name: 'shaft', y0: Lh, y1: yTip0 },
        { name: 'tip', y0: yTip0, y1: yEnd },
      ],
      dims: {
        length: yEnd,
        handleLength: Lh,
        handleDiameter: p.handleDiameter,
        shaftLength: p.shaftLength,
        shaftDiameter: p.shaftDiameter,
        tipWidth,
        collarDiameter: ferruleR * 2,
      },
    };
  },
});
