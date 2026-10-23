/**
 * Flat spanners: double open-end (DIN 3110: jaws at 15 deg, 6..32 mm), double ring / box-end (12-point
 * ring, 15 deg offset neck, DIN 838/837) and combination (open end + ring, DIN 3113). Sizes and lengths
 * follow the common catalogue ladders (6x7 = 100 mm ... 30x32 = 330 mm; combination 10 = 160 ... 32 = 410).
 * Frame: handle along +Y, the wrench lies in the XY plane with the face towards +Z; the bottom end (A)
 * starts at y = 0. Heads are plates (extrude with chamfered edges), the shank is a rounded bar (loft) that
 * thins out between the heads and cranks down towards ring ends.
 */
import { DEG, type V2, lerp, smoothstep } from '../math.ts';
import { type Mesh, mergeMeshes } from '../mesh.ts';
import { METALS } from '../materials.ts';
import { GLYPH_W } from '../render/font.ts';
import { type Label, L, choice, color, num } from '../params.ts';
import { defineToolClass, type BuildCtx } from '../registry.ts';
import type { BuiltTool, Part } from '../model.ts';
import {
  type BarSection,
  FINISHES,
  type Finish,
  barLoft,
  finishMaterial,
  gripMaterial,
  type HeadOutlineSpec,
  headOutline,
  placeOutline,
  plate,
  sleeve,
  stampText,
  stationYs,
} from './wrench-shared.ts';

/** Head circle radius of an open-end head for jaw size `s` (mm across flats). */
const openRadius = (s: number): number => 0.9 * s + 2;
/** Outer radius of a ring (box-end) head. */
const ringRadius = (s: number): number => 0.77 * s + 2;
const barWidth = (s: number): number => 0.45 * s + 7.5;
const headThick = (s: number): number => 0.3 * s + 1.8;

type EndKind = 'open' | 'ring';

interface End {
  kind: EndKind;
  size: number;
}

interface FlatOptions {
  length: number;
  jawAngle: number;
  offsetAngle: number;
  finish: Finish;
  markings: boolean;
  ringPoints: 6 | 12;
  /** Dip-coating colour of the shank, null for a bare steel handle. */
  dip: string | null;
}

interface FlatLayout {
  y: number;
  radius: number;
  half: number;
  thick: number;
  z: number;
  inner: number;
}

/**
 * 12-point (two hexagons turned 30 deg) or 6-point cavity of a ring head, with a little clearance over the
 * nut. Exact vertices only: no collinear samples, which earcut would drop into T-junctions.
 */
function ringCavity(size: number, points: 6 | 12): V2[] {
  const inr = (size / 2) * 1.015;
  const corner = inr / Math.cos(30 * DEG);
  const valley = inr / Math.cos(15 * DEG);
  const step = (360 * DEG) / points;
  const out: V2[] = [];
  for (let k = 0; k < points; k++) {
    const a = k * step + 30 * DEG;
    out.push([corner * Math.cos(a), corner * Math.sin(a)]);
    if (points === 12) out.push([valley * Math.cos(a + step / 2), valley * Math.sin(a + step / 2)]);
  }
  return out;
}

/** Bar sections between the two heads: width follows the neck widths, thickness dips in the middle. */
function shankSections(
  a: FlatLayout,
  b: FlatLayout,
  crank: { spanA: number; spanB: number },
  ys: readonly number[],
): BarSection[] {
  const y0 = a.y + a.inner;
  const y1 = b.y - b.inner;
  return ys.map((y) => {
    const u = (y - y0) / (y1 - y0);
    const bell = smoothstep(0, 0.22, u) * smoothstep(0, 0.22, 1 - u);
    const wA = 1 - smoothstep(y0, y0 + crank.spanA, y);
    const wB = smoothstep(y1 - crank.spanB, y1, y);
    return {
      y,
      width: 2 * lerp(a.half, b.half, u) * (1 - 0.1 * Math.sin(Math.PI * u)),
      thick: lerp(a.thick, b.thick, u) * (1 - 0.2 * bell),
      z: (a.z * wA + b.z * wB) / Math.max(1, wA + wB),
    };
  });
}

function buildFlat(ends: readonly [End, End], o: FlatOptions, ctx: BuildCtx): BuiltTool {
  const [endA, endB] = ends;
  const rOf = (e: End): number => (e.kind === 'open' ? openRadius(e.size) : ringRadius(e.size));
  const headSpec = (e: End, arcSteps: number): HeadOutlineSpec => ({
    radius: rOf(e),
    neckHalf: barWidth(e.size) / 2,
    fillet: Math.max(2, 0.42 * rOf(e)),
    neckExtra: 5,
    steps: arcSteps,
  });
  // The straight neck stub of one head must stay clear of the other head's jaw or ring disc.
  const stub = (e: End): number => -headOutline(headSpec(e, 2)).neckStart;
  // Where the shank takes over from the head plate: past the neck stub for ring heads, so the crank
  // never starts under a flat stub.
  const innerOf = (e: End): number => (e.kind === 'open' ? 0.62 * e.size + 2 : stub(e) - 0.5);
  const inward = (e: End): number => (e.kind === 'open' ? 1.25 * (e.size / 2 + 0.12) : rOf(e));
  const rA = rOf(endA);
  const rB = rOf(endB);
  const clear =
    Math.max(
      stub(endA) + inward(endB),
      stub(endB) + inward(endA),
      innerOf(endA) + innerOf(endB) + 4,
    ) + 2;
  const Ltot = Math.max(o.length, 2 * (rA + rB), rA + rB + clear);
  // The crank never runs longer than 45 % of the shank, so each end is flat again before the other starts.
  const shank = Ltot - rA - rB - innerOf(endA) - innerOf(endB);
  const spanOf = (e: End): number =>
    e.kind === 'ring' ? Math.min(1.7 * ringRadius(e.size), 0.45 * shank) : 0.001;
  const dzOf = (e: End): number =>
    e.kind === 'ring' ? (spanOf(e) * Math.tan(o.offsetAngle * DEG)) / 1.5 : 0;
  const layout = (e: End, y: number): FlatLayout => ({
    y,
    radius: rOf(e),
    half: barWidth(e.size) / 2,
    thick: headThick(e.size),
    z: -dzOf(e),
    inner: innerOf(e),
  });
  const A = layout(endA, rOf(endA));
  const B = layout(endB, Ltot - rOf(endB));
  const steps = ctx.seg(10, 5);
  const parts: Part[] = [];
  const material = finishMaterial(o.finish);

  const headPlate = (e: End, lay: FlatLayout): Mesh => {
    const spec = headSpec(e, steps);
    const dir = e === endA ? -1 : 1;
    const bevel = Math.min(1.3, 0.26 * lay.thick);
    if (e.kind === 'open') {
      const tilt = dir > 0 ? o.jawAngle : -o.jawAngle;
      const outline = headOutline({
        ...spec,
        notch: { halfGap: e.size / 2 + 0.12, tiltDeg: tilt },
      });
      return plate(placeOutline(outline.ring, lay.y, dir), lay.z, lay.thick, bevel);
    }
    const outline = headOutline(spec);
    const cavity = ringCavity(e.size, o.ringPoints);
    const placed = placeOutline(outline.ring, lay.y, dir);
    const hole = cavity.map(([x, s]): V2 => [x, lay.y + s]);
    return plate(placed, lay.z, lay.thick, bevel, [hole]);
  };

  const crank = { spanA: spanOf(endA), spanB: spanOf(endB) };
  const y0 = A.y + A.inner;
  const y1 = B.y - B.inner;
  const ys = stationYs(y0, y1, ctx.seg(18, 6), [
    y0 + crank.spanA * 0.25,
    y0 + crank.spanA * 0.5,
    y0 + crank.spanA * 0.75,
    y0 + crank.spanA,
    y1 - crank.spanB * 0.25,
    y1 - crank.spanB * 0.5,
    y1 - crank.spanB * 0.75,
    y1 - crank.spanB,
  ]);
  const sections = shankSections(A, B, crank, ys);
  const sectionAt = (y: number): BarSection => shankSections(A, B, crank, [y])[0] as BarSection;
  const body: Mesh = mergeMeshes([
    headPlate(endA, A),
    headPlate(endB, B),
    barLoft(sections, ctx.seg(4, 2)),
  ]);
  parts.push({ name: 'body', role: 'body', material, mesh: body, crease: 35 });

  // Size stamps: A below the shank midpoint, B above it, beside their own heads on the flat part of the
  // shank (past the crank). A span is null when it does not fit; the dip coating leaves room for them.
  interface StampSpan {
    text: string;
    px: number;
    yc: number;
    length: number;
  }
  const shankMid = (y0 + y1) / 2;
  const stampSpan = (e: End, lay: FlatLayout, below: boolean): StampSpan | null => {
    const text = Number.isInteger(e.size) ? `${e.size}` : e.size.toFixed(1);
    const px = Math.min(0.75, 0.052 * lay.half * 2);
    const length = text.length * GLYPH_W * px;
    const edge = lay.radius * 1.6 + 6;
    const yc = below
      ? Math.max(lay.y + edge + length / 2, y0 + crank.spanA + 1 + length / 2)
      : Math.min(lay.y - edge - length / 2, y1 - crank.spanB - 1 - length / 2);
    const fits = below ? yc + length / 2 <= shankMid : yc - length / 2 >= shankMid;
    return o.markings && fits && yc - length / 2 >= y0 && yc + length / 2 <= y1
      ? { text, px, yc, length }
      : null;
  };
  const stampA = stampSpan(endA, A, true);
  const stampB = stampSpan(endB, B, false);
  const dipY0 = Math.max(
    y0 + Math.max(crank.spanA, 0.14 * (y1 - y0)) + 6,
    stampA ? stampA.yc + stampA.length / 2 + 2 : 0,
  );
  const dipY1 = Math.min(
    y1 - Math.max(crank.spanB, 0.1 * (y1 - y0)) - 6,
    stampB ? stampB.yc - stampB.length / 2 - 2 : Infinity,
  );
  const dipped = o.dip !== null && dipY1 - dipY0 > 14;

  if (ctx.detail) {
    const stamps: Mesh[] = [];
    for (const st of [stampA, stampB]) {
      if (!st) continue;
      const s = sectionAt(st.yc);
      const top = s.z + s.thick / 2;
      const m = stampText(st.text, 0, st.yc, st.px, top - 0.6, top + 0.3, true);
      if (m) stamps.push(m);
    }
    if (stamps.length > 0) {
      parts.push({
        name: 'marking',
        role: 'label',
        material: METALS.polishedSteel,
        mesh: mergeMeshes(stamps),
      });
    }
  }

  if (dipped && o.dip !== null) {
    parts.push({
      name: 'grip',
      role: 'grip',
      material: gripMaterial('dipped', o.dip),
      mesh: sleeve({
        y0: dipY0,
        y1: dipY1,
        width: (y) => sectionAt(y).width,
        thick: (y) => sectionAt(y).thick,
        over: 0.85,
        count: ctx.seg(10, 3),
        grooves: [],
        grooveDepth: 0,
        bulge: 0,
        perCorner: ctx.seg(4, 2),
      }),
    });
  }

  const hangEnd = endA.kind === 'ring' ? endA : endB;
  const hangLay = endA.kind === 'ring' ? A : B;
  const headWidth = (e: End): number => 2 * rOf(e);
  const zones = [
    { name: 'head-a', y0: 0, y1: A.y + A.inner * 0.5 },
    { name: 'handle', y0: A.y + A.inner * 0.5, y1: B.y - B.inner * 0.5 },
    { name: 'head-b', y0: B.y - B.inner * 0.5, y1: Ltot },
  ];
  const mid = sectionAt((y0 + y1) / 2);
  const coat = dipped ? 0.85 : 0;
  const zHi = Math.max(A.z + A.thick / 2, B.z + B.thick / 2, mid.z + mid.thick / 2 + coat);
  const zLo = Math.min(A.z - A.thick / 2, B.z - B.thick / 2, mid.z - mid.thick / 2 - coat);
  return {
    parts,
    hang:
      hangEnd.kind === 'ring'
        ? { point: [0, hangLay.y, hangLay.z], kind: 'hole', diameterMm: hangEnd.size }
        : { point: [0, B.y, 0], kind: 'head' },
    zones,
    dims: {
      length: Ltot,
      width: Math.max(headWidth(endA), headWidth(endB)),
      thickness: zHi - zLo,
      headWidth: Math.max(headWidth(endA), headWidth(endB)),
      handleWidth: mid.width,
      handleThickness: mid.thick,
      sizeA: endA.size,
      sizeB: endB.size,
      jawOpening: Math.max(
        endA.kind === 'open' ? endA.size : 0,
        endB.kind === 'open' ? endB.size : 0,
      ),
    },
  };
}

const finishChoice = choice(L('Finish', 'Покрытие'), FINISHES, 'chrome');
const markingChoice = choice(
  L('Size stamp', 'Маркировка'),
  ['stamped', 'plain'] as const,
  'stamped',
);

const openSchema = {
  sizeA: num(L('Jaw size A (bottom)', 'Размер зева A (низ)'), 10, 6, 32, { step: 1 }),
  sizeB: num(L('Jaw size B (top)', 'Размер зева B (верх)'), 13, 6, 32, { step: 1 }),
  length: num(L('Length', 'Длина'), 170, 90, 400, { step: 1 }),
  jawAngle: num(L('Jaw angle', 'Угол зева'), 15, 0, 25, { step: 1, unit: 'deg' }),
  finish: finishChoice,
  markings: markingChoice,
};

/** [sizeA, sizeB, length] ladder (DIN 3110 double open-end). */
const OPEN_LADDER: readonly [number, number, number][] = [
  [6, 7, 105],
  [8, 10, 140],
  [10, 13, 170],
  [13, 17, 200],
  [19, 22, 250],
  [24, 27, 290],
  [30, 32, 330],
];

function ladderPresets<K extends 'open' | 'ring'>(
  kind: K,
  ladder: readonly [number, number, number][],
  pick: readonly number[],
): {
  id: string;
  label: Label;
  values: { sizeA: number; sizeB: number; length: number };
}[] {
  return pick.map((i) => {
    const [a, b, len] = ladder[i] as [number, number, number];
    return {
      id: `${a}x${b}`,
      label: L(
        `${kind === 'open' ? 'Open-end' : 'Ring'} ${a} x ${b} mm`,
        `${kind === 'open' ? 'Рожковый' : 'Накидной'} ${a} x ${b} мм`,
      ),
      values: { sizeA: a, sizeB: b, length: len },
    };
  });
}

export const wrenchOpenEnd = defineToolClass({
  id: 'wrench-open-end',
  family: 'wrenches',
  name: L('Open-end wrench', 'Рожковый ключ'),
  bankClass: 'wrench',
  keywords: {
    en: ['open-end wrench', 'open end spanner', 'double open ended spanner', 'wrench'],
    ru: ['рожковый ключ', 'гаечный ключ', 'ключ двусторонний'],
  },
  schema: openSchema,
  presets: ladderPresets('open', OPEN_LADDER, [0, 1, 2, 3, 4, 6]),
  build(p, ctx) {
    return buildFlat(
      [
        { kind: 'open', size: p.sizeA },
        { kind: 'open', size: p.sizeB },
      ],
      {
        length: p.length,
        jawAngle: p.jawAngle,
        offsetAngle: 0,
        finish: p.finish,
        markings: p.markings === 'stamped',
        ringPoints: 12,
        dip: null,
      },
      ctx,
    );
  },
});

const ringSchema = {
  sizeA: num(L('Ring size A (bottom)', 'Размер кольца A (низ)'), 10, 8, 32, { step: 1 }),
  sizeB: num(L('Ring size B (top)', 'Размер кольца B (верх)'), 13, 8, 32, { step: 1 }),
  length: num(L('Length', 'Длина'), 195, 110, 440, { step: 1 }),
  offsetAngle: num(L('Neck offset angle', 'Угол изгиба шейки'), 15, 0, 30, {
    step: 1,
    unit: 'deg',
  }),
  ringPoints: choice(L('Ring points', 'Граней в кольце'), ['12', '6'] as const, '12'),
  finish: finishChoice,
  markings: markingChoice,
};

/** DIN 838 double ring spanners. */
const RING_LADDER: readonly [number, number, number][] = [
  [8, 10, 160],
  [10, 13, 195],
  [13, 17, 235],
  [17, 19, 265],
  [19, 22, 295],
  [24, 27, 345],
  [30, 32, 410],
];

export const wrenchRing = defineToolClass({
  id: 'wrench-ring',
  family: 'wrenches',
  name: L('Ring wrench', 'Накидной ключ'),
  bankClass: 'wrench',
  keywords: {
    en: ['ring wrench', 'box-end wrench', 'ring spanner', 'offset ring spanner'],
    ru: ['накидной ключ', 'гаечный ключ накидной', 'ключ кольцевой'],
  },
  schema: ringSchema,
  presets: ladderPresets('ring', RING_LADDER, [0, 1, 2, 3, 4, 6]),
  build(p, ctx) {
    return buildFlat(
      [
        { kind: 'ring', size: p.sizeA },
        { kind: 'ring', size: p.sizeB },
      ],
      {
        length: p.length,
        jawAngle: 15,
        offsetAngle: p.offsetAngle,
        finish: p.finish,
        markings: p.markings === 'stamped',
        ringPoints: p.ringPoints === '12' ? 12 : 6,
        dip: null,
      },
      ctx,
    );
  },
});

const combinationSchema = {
  size: num(L('Wrench size', 'Размер ключа'), 13, 8, 32, { step: 1 }),
  length: num(L('Length', 'Длина'), 190, 110, 420, { step: 1 }),
  jawAngle: num(L('Jaw angle', 'Угол зева'), 15, 0, 25, { step: 1, unit: 'deg' }),
  offsetAngle: num(L('Ring offset angle', 'Угол изгиба кольца'), 15, 0, 30, {
    step: 1,
    unit: 'deg',
  }),
  ringPoints: choice(L('Ring points', 'Граней в кольце'), ['12', '6'] as const, '12'),
  finish: finishChoice,
  grip: choice(L('Handle', 'Рукоять'), ['bare', 'dipped'] as const, 'bare'),
  gripColor: color(L('Dip colour', 'Цвет покрытия'), '#2455a8'),
  markings: markingChoice,
};

/** DIN 3113 combination spanners. */
const COMBINATION_LADDER: readonly [number, number][] = [
  [8, 140],
  [10, 160],
  [13, 190],
  [17, 230],
  [19, 250],
  [24, 315],
  [32, 410],
];

export const wrenchCombination = defineToolClass({
  id: 'wrench-combination',
  family: 'wrenches',
  name: L('Combination wrench', 'Комбинированный ключ'),
  bankClass: 'wrench',
  keywords: {
    en: ['combination wrench', 'combination spanner', 'wrench', 'spanner'],
    ru: ['комбинированный ключ', 'гаечный ключ', 'рожково-накидной ключ'],
  },
  schema: combinationSchema,
  presets: [
    ...COMBINATION_LADDER.filter(([s]) => [8, 13, 17, 24, 32].includes(s)).map(
      ([size, length]) => ({
        id: `${size}`,
        label: L(`Combination ${size} mm`, `Комбинированный ${size} мм`),
        values: { size, length },
      }),
    ),
    {
      id: '13-dipped-blue',
      label: L('13 mm, blue dipped handle', '13 мм, синяя обмакнутая рукоять'),
      values: { size: 13, length: 190, grip: 'dipped' as const, gripColor: '#2455a8' },
    },
    {
      id: '19-dipped-red',
      label: L('19 mm, red dipped handle', '19 мм, красная обмакнутая рукоять'),
      values: {
        size: 19,
        length: 250,
        grip: 'dipped' as const,
        gripColor: '#c8262b',
        finish: 'satin' as const,
      },
    },
  ],
  build(p, ctx) {
    return buildFlat(
      [
        { kind: 'ring', size: p.size },
        { kind: 'open', size: p.size },
      ],
      {
        length: p.length,
        jawAngle: p.jawAngle,
        offsetAngle: p.offsetAngle,
        finish: p.finish,
        markings: p.markings === 'stamped',
        ringPoints: p.ringPoints === '12' ? 12 : 6,
        dip: p.grip === 'dipped' ? p.gripColor : null,
      },
      ctx,
    );
  },
});
