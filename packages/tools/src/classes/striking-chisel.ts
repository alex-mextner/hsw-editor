/**
 * Chisel and punch. Axis +Y, struck end at y = 0, working end at the far end.
 * Chisel: bevel-edge / firmer / mortise wood chisels (wood or plastic handle with steel hoop / strike cap,
 * steel bolster, blade with the ground 25 deg edge bevel on the -Z face) and an octagonal cold chisel.
 * Sizes: blade widths 6, 10, 13, 20, 25, 32 mm (ISO 8997 / DIN 5139 series), blade 100..130 mm, handle
 * 100..120 mm; cold chisel 20 x 180 mm (DIN 6453). Punch: centre punch 8 x 125 (DIN 7250), pin punch
 * 3 x 150 (DIN 6450-ish), drift 10 x 150, octagonal shank, knurled mid-zone, mushroomed head.
 */
import { DEG, lerp, smoothstep, translation } from '../math.ts';
import { cylinder, lathe, loft } from '../build/primitives.ts';
import { transformMesh } from '../mesh.ts';
import {
  METALS,
  type Material,
  type WoodSpecies,
  WOODS,
  plastic,
  rubber,
  wood,
} from '../materials.ts';
import { type Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { type Keyed, keyedStations, loftFaceted } from './striking-util.ts';

const WOOD_LIST = Object.keys(WOODS) as WoodSpecies[];

/** `steps + 1` keyed sections between y0 and y1, `f(u)` gives the section at fraction u. */
function sweep(y0: number, y1: number, steps: number, f: (u: number) => Omit<Keyed, 'y'>): Keyed[] {
  const out: Keyed[] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    out.push({ y: lerp(y0, y1, u), ...f(u) });
  }
  return out;
}

// ---------------------------------------------------------------- chisel

const KINDS = ['bevel-edge', 'firmer', 'mortise', 'cold'] as const;

const chiselSchema = {
  kind: choice(L('Chisel type', 'Тип стамески'), KINDS, 'bevel-edge'),
  handle: choice(L('Handle', 'Рукоятка'), ['wood', 'plastic'] as const, 'wood'),
  bladeWidth: num(L('Blade width', 'Ширина лезвия'), 20, 6, 32, { step: 1 }),
  bladeLength: num(L('Blade length', 'Длина лезвия'), 120, 60, 250, { step: 1 }),
  handleLength: num(L('Handle length', 'Длина рукоятки'), 105, 80, 150, { step: 1 }),
  handleDiameter: num(L('Handle diameter', 'Диаметр рукоятки'), 30, 22, 42, { step: 0.5 }),
  handleWood: choice(L('Wood species', 'Порода дерева'), WOOD_LIST, 'beech'),
  handleColor: color(L('Handle colour', 'Цвет рукоятки'), '#e8741e'),
  gripColor: color(L('Grip colour', 'Цвет накладки'), '#1b1c1e'),
  finish: choice(
    L('Steel finish', 'Покрытие стали'),
    ['steel', 'chromeVanadium', 'blackOxide'] as const,
    'chromeVanadium',
  ),
};

const STEEL: Record<(typeof chiselSchema.finish.options)[number], Material> = {
  steel: METALS.steel,
  chromeVanadium: METALS.chromeVanadium,
  blackOxide: METALS.blackOxide,
};

export const chisel = defineToolClass({
  id: 'chisel',
  family: 'striking',
  name: L('Chisel', 'Стамеска'),
  bankClass: 'knife',
  keywords: {
    en: ['chisel', 'wood chisel', 'bevel edge chisel', 'cold chisel', 'mortise chisel'],
    ru: ['стамеска', 'долото', 'зубило', 'плотницкая стамеска'],
  },
  schema: chiselSchema,
  presets: [
    {
      id: 'bevel-20-wood',
      label: L('Bevel-edge 20 mm, wood', 'Стамеска 20 мм, дерево'),
      values: {},
    },
    {
      id: 'bevel-12-plastic',
      label: L('Bevel-edge 12 mm, plastic', 'Стамеска 12 мм, пластик'),
      values: {
        handle: 'plastic',
        bladeWidth: 12,
        bladeLength: 105,
        handleLength: 100,
        handleDiameter: 28,
        handleColor: '#d9b21c',
        gripColor: '#1b1c1e',
      },
    },
    {
      id: 'bevel-6-narrow',
      label: L('Narrow 6 mm, wood', 'Узкая стамеска 6 мм'),
      values: {
        bladeWidth: 6,
        bladeLength: 100,
        handleLength: 92,
        handleDiameter: 24,
        handleWood: 'walnut',
      },
    },
    {
      id: 'firmer-32',
      label: L('Firmer 32 mm, plastic', 'Плоская стамеска 32 мм'),
      values: {
        kind: 'firmer',
        handle: 'plastic',
        bladeWidth: 32,
        bladeLength: 130,
        handleLength: 115,
        handleDiameter: 36,
        handleColor: '#2455a8',
        gripColor: '#1b1c1e',
      },
    },
    {
      id: 'mortise-10',
      label: L('Mortise 10 mm, wood', 'Стамеска-долото 10 мм'),
      values: {
        kind: 'mortise',
        bladeWidth: 10,
        bladeLength: 150,
        handleLength: 110,
        handleDiameter: 32,
        handleWood: 'ash',
      },
    },
    {
      id: 'cold-20',
      label: L('Cold chisel 20 x 180', 'Зубило 20 x 180'),
      values: { kind: 'cold', bladeWidth: 20, bladeLength: 180, finish: 'blackOxide' },
    },
  ],
  build(p, ctx) {
    const N = ctx.seg(36, 20);
    const w = p.bladeWidth;
    const parts: Part[] = [];
    const steel = STEEL[p.finish];

    if (p.kind === 'cold') {
      // octagonal bar, struck head mushroomed, flat bit with a ground edge
      const total = p.bladeLength;
      const d = Math.max(12, 0.62 * w + 4) / 2; // across-flats radius of the bar
      const bitLen = Math.min(0.22 * total, 40);
      const edgeLen = Math.min(0.55 * bitLen, 14);
      const t = Math.max(3, 0.28 * w);
      const keys: Keyed[] = [
        { y: 0, a: d * 0.72, b: d * 0.72, oct: 1 },
        { y: 1.6, a: d * 0.98, b: d * 0.98, oct: 1 },
        { y: 4, a: d * 1.05, b: d * 1.05, oct: 1 },
        { y: 8, a: d * 1.0, b: d * 1.0, oct: 1 },
        { y: 0.5 * total, a: d * 0.98, b: d * 0.98, oct: 1 },
        ...sweep(total - bitLen, total - edgeLen, 8, (u) => {
          const s = smoothstep(0, 1, u);
          return { a: lerp(d, w / 2, s), b: lerp(d, t / 2, s), n: lerp(2, 4.4, s), oct: 1 - s };
        }),
      ];
      parts.push({
        name: 'body',
        role: 'blade',
        material: steel,
        mesh: loftFaceted(keys, N),
        crease: 35,
      });
      parts.push({
        name: 'edge',
        role: 'edge',
        material: METALS.polishedSteel,
        mesh: loftFaceted(
          [
            { y: total - edgeLen - 0.01, a: w / 2, b: t / 2, n: 4.4 },
            { y: total - edgeLen, a: w / 2 + 0.02, b: t / 2 + 0.02, n: 4.4 },
            { y: total, a: w / 2, b: 0.3, n: 4.4 },
          ],
          N,
        ),
      });
      return {
        parts,
        hang: { point: [0, 0.5 * total, 0], kind: 'body' },
        zones: [
          { name: 'body', y0: 0, y1: total - bitLen },
          { name: 'bit', y0: total - bitLen, y1: total },
        ],
        dims: {
          length: total,
          shaftDiameter: 2 * d * 1.08,
          bladeWidth: w,
          bladeThickness: t,
          handleLength: 0,
          handleDiameter: 2 * d * 1.08,
        },
      };
    }

    const Lh = p.handleLength;
    const R = p.handleDiameter / 2;
    const BL = p.bladeLength;
    const mortise = p.kind === 'mortise';
    const t = mortise ? Math.max(5, w * 0.86) : Math.min(8, Math.max(2.6, 0.2 * w + 1.8));
    const shankR = Math.min(4.2, Math.max(2.4, w * 0.3));
    const neckLen = Math.max(14, 0.2 * BL);
    const bevelLen = Math.min(0.3 * BL, Math.max(3, t / Math.tan(25 * DEG)));
    const yEnd = Lh + BL;
    const bolsterR = Math.min(R * 0.62, Math.max(shankR * 1.9, w * 0.34));

    // handle
    if (p.handle === 'wood') {
      const keys: Keyed[] = [
        ...sweep(0, 6, 3, (u) => ({ a: R * lerp(0.82, 0.92, u), b: R * lerp(0.82, 0.92, u) })),
        { y: 0.22 * Lh, a: R, b: R },
        { y: 0.42 * Lh, a: R * 0.96, b: R * 0.96 },
        { y: 0.68 * Lh, a: R * 0.74, b: R * 0.74 },
        { y: 0.85 * Lh, a: R * 0.66, b: R * 0.66 },
        { y: Lh - 4, a: bolsterR * 0.96, b: bolsterR * 0.96 },
      ];
      parts.push({
        name: 'handle',
        role: 'handle',
        material: wood(p.handleWood, 0.5),
        mesh: loft(keyedStations(keys, N, 4)),
      });
      // steel hoop on the struck end
      parts.push({
        name: 'hoop',
        role: 'ferrule',
        material: METALS.steel,
        mesh: lathe(
          [
            [R * 0.86, 0],
            [R * 0.98, 0.8],
            [R * 0.99, 7],
            [R * 0.95, 8.2],
          ],
          ctx.seg(36, 16),
        ),
      });
    } else {
      // plastic: rounded-hex body with a soft over-mould in the middle
      const hex = (f: number, g = f): Omit<Keyed, 'y'> => ({
        a: R * f,
        b: R * g,
        n: 2.8,
        oct: 0.55,
      });
      const body: Keyed[] = [
        { y: 0, ...hex(0.84) },
        { y: 3, ...hex(0.98) },
        { y: 0.2 * Lh, ...hex(0.94) },
        { y: 0.78 * Lh, ...hex(0.86) },
        { y: 0.92 * Lh, ...hex(0.66) },
        { y: Lh - 4, a: bolsterR * 0.96, b: bolsterR * 0.96, n: 2, oct: 0 },
      ];
      parts.push({
        name: 'handle',
        role: 'handle',
        material: plastic(p.handleColor, 0.35, 'polypropylene'),
        mesh: loft(keyedStations(body, N, 3)),
      });
      const ribs = ctx.detail ? 10 : 0;
      const grip: Keyed[] = [
        { y: 0.2 * Lh, ...hex(0.94), rib: 0 },
        { y: 0.26 * Lh, ...hex(1.03), rib: 0.06 },
        { y: 0.56 * Lh, ...hex(1.02), rib: 0.06 },
        { y: 0.7 * Lh, ...hex(0.94), rib: 0.04 },
        { y: 0.76 * Lh, ...hex(0.88), rib: 0 },
      ];
      parts.push({
        name: 'grip',
        role: 'grip',
        material: rubber(p.gripColor, ribs ? 'ribbed' : 'soft-grip'),
        mesh: loft(keyedStations(grip, ribs ? 80 : N, 2, ribs)),
      });
      parts.push({
        name: 'strike-cap',
        role: 'ferrule',
        material: METALS.steel,
        mesh: transformMesh(cylinder(R * 0.78, 3, ctx.seg(30, 14)), translation(0, 1.5, 0)),
      });
    }

    // bolster (steel collar where the handle meets the blade)
    parts.push({
      name: 'bolster',
      role: 'ferrule',
      material: METALS.steel,
      mesh: lathe(
        [
          [bolsterR * 1.02, Lh - 6],
          [bolsterR * 1.08, Lh - 4],
          [bolsterR * 1.08, Lh + 2],
          [bolsterR * 0.9, Lh + 6],
          [shankR * 1.5, Lh + 10],
          [shankR * 1.1, Lh + 13],
        ],
        ctx.seg(32, 14),
      ),
    });

    // blade: round tang-shank -> neck blending into the flat blade -> ground bevel on the -Z face
    const bladeKeys: Keyed[] = [
      { y: Lh - 6, a: shankR, b: shankR },
      { y: Lh + 13, a: shankR, b: shankR },
      ...sweep(Lh + 13, Lh + 13 + neckLen, 8, (u) => {
        const s = smoothstep(0, 1, u);
        return {
          a: lerp(shankR, 0.9 * (w / 2), s),
          b: lerp(shankR, t / 2, s),
          n: lerp(2, mortise ? 4.5 : 3.1, s),
        };
      }).slice(1),
      { y: yEnd - bevelLen, a: w / 2, b: t / 2, n: mortise ? 4.5 : 3.1 },
      {
        y: yEnd,
        a: w / 2,
        b: 0.2,
        n: mortise ? 4.5 : 3.1,
        cz: t / 2 - 0.2,
      },
    ];
    parts.push({
      name: 'blade',
      role: 'blade',
      material: steel,
      mesh: loftFaceted(bladeKeys, N),
      crease: 30,
    });
    // ground bevel edge shown as a lighter strip at the working end
    return {
      parts,
      hang: { point: [0, Lh - 6, 0], kind: 'neck' },
      zones: [
        { name: 'handle', y0: 0, y1: Lh },
        { name: 'blade', y0: Lh, y1: yEnd },
      ],
      dims: {
        length: yEnd,
        handleLength: Lh,
        handleDiameter: p.handleDiameter,
        bladeLength: BL,
        bladeWidth: w,
        bladeThickness: t,
        shaftDiameter: 2 * shankR,
      },
    };
  },
});

// ---------------------------------------------------------------- punch

const punchSchema = {
  kind: choice(L('Punch type', 'Тип бородка'), ['center', 'pin', 'drift'] as const, 'center'),
  length: num(L('Length', 'Длина'), 125, 70, 250, { step: 1 }),
  shaftDiameter: num(L('Shank diameter (across flats)', 'Диаметр хвостовика'), 8, 3, 16, {
    step: 0.5,
  }),
  tipDiameter: num(L('Pin / flat end diameter', 'Диаметр рабочего конца'), 3, 1, 14, { step: 0.5 }),
  grip: choice(L('Grip zone', 'Зона хвата'), ['knurled', 'smooth'] as const, 'knurled'),
  finish: choice(L('Finish', 'Покрытие'), ['blackOxide', 'steel', 'brass'] as const, 'blackOxide'),
};

export const punch = defineToolClass({
  id: 'punch',
  family: 'striking',
  name: L('Punch', 'Бородок'),
  bankClass: 'screwdriver',
  keywords: {
    en: ['punch', 'centre punch', 'center punch', 'pin punch', 'drift punch', 'drift'],
    ru: ['керн', 'бородок', 'выколотка', 'кернер'],
  },
  schema: punchSchema,
  presets: [
    { id: 'centre-8x125', label: L('Centre punch 8 x 125', 'Керн 8 x 125'), values: {} },
    {
      id: 'centre-4x100',
      label: L('Centre punch 4 x 100', 'Керн 4 x 100'),
      values: { length: 100, shaftDiameter: 5, grip: 'smooth', finish: 'steel' },
    },
    {
      id: 'pin-3x150',
      label: L('Pin punch 3 x 150', 'Выколотка 3 x 150'),
      values: { kind: 'pin', length: 150, shaftDiameter: 8, tipDiameter: 3, finish: 'steel' },
    },
    {
      id: 'drift-10x150',
      label: L('Drift 10 x 150', 'Бородок 10 x 150'),
      values: { kind: 'drift', length: 150, shaftDiameter: 12, tipDiameter: 9, grip: 'smooth' },
    },
    {
      id: 'brass-drift',
      label: L('Brass drift 8 x 140', 'Латунный бородок 8 x 140'),
      values: {
        kind: 'drift',
        length: 140,
        shaftDiameter: 10,
        tipDiameter: 7,
        grip: 'smooth',
        finish: 'brass',
      },
    },
  ],
  build(p, ctx) {
    const Lt = p.length;
    const r = p.shaftDiameter / 2;
    const tipR = Math.min(p.tipDiameter / 2, r * 0.92);
    const mat: Material =
      p.finish === 'brass' ? METALS.brass : p.finish === 'steel' ? METALS.steel : METALS.blackOxide;
    const knurl = p.grip === 'knurled' && ctx.detail;
    const g0 = 0.34 * Lt;
    const g1 = 0.58 * Lt;
    const ribCount = 24;
    const oct = (f: number): Omit<Keyed, 'y'> => ({ a: r * f, b: r * f, oct: 1 });
    const pointLen = p.kind === 'center' ? Math.min(0.25 * Lt, 4 * r) : 0;
    const pinLen = p.kind === 'pin' ? 0.18 * Lt : 0;
    const taperLen = p.kind === 'pin' ? 9 + pinLen : p.kind === 'drift' ? 0.3 * Lt : 0;
    const keys: Keyed[] = [
      { y: 0, ...oct(0.74) },
      { y: 1.4, ...oct(0.98) },
      { y: 3.2, ...oct(1.06) },
      { y: 6, ...oct(1.0) },
      { y: g0 - 0.5, ...oct(1.0) },
      { y: g0, a: r * 1.02, b: r * 1.02, rib: knurl ? 0.07 : 0 },
      { y: g1, a: r * 1.02, b: r * 1.02, rib: knurl ? 0.07 : 0 },
      { y: g1 + 0.5, ...oct(1.0) },
    ];
    if (p.kind === 'center') {
      keys.push(
        { y: Lt - pointLen - 0.01, ...oct(1.0), oct: 0.5 },
        ...sweep(Lt - pointLen, Lt, 6, (u) => ({
          a: lerp(r * 0.98, 0.22, u ** 0.9),
          b: lerp(r * 0.98, 0.22, u ** 0.9),
        })),
      );
    } else {
      keys.push({ y: Lt - taperLen - 0.01, ...oct(1.0) });
      keys.push(
        ...sweep(Lt - taperLen, Lt - 0.6 - pinLen, 6, (u) => {
          const s = smoothstep(0, 1, u);
          return { a: lerp(r, tipR, s), b: lerp(r, tipR, s), oct: lerp(1, 0, s) };
        }),
      );
      if (pinLen > 0) keys.push({ y: Lt - 0.6, a: tipR, b: tipR });
      keys.push({ y: Lt, a: tipR * 0.92, b: tipR * 0.92 });
    }
    const mesh = loftFaceted(keys, knurl ? 96 : ctx.seg(48, 16), knurl ? ribCount : 0);
    return {
      parts: [
        {
          name: 'shank',
          role: 'shaft',
          material: mat,
          mesh,
          crease: 35,
        },
      ],
      hang: { point: [0, 0.5 * Lt, 0], kind: 'body' },
      zones: [
        { name: 'head', y0: 0, y1: g0 },
        { name: 'grip', y0: g0, y1: g1 },
        { name: 'point', y0: g1, y1: Lt },
      ],
      dims: {
        length: Lt,
        shaftDiameter: p.shaftDiameter,
        handleDiameter: p.shaftDiameter,
        tipDiameter: p.kind === 'center' ? 0.5 : 2 * tipR,
      },
    };
  },
});
