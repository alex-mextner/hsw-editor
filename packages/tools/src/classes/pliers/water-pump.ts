/**
 * Water-pump (slip-joint, tongue-and-groove) pliers, 250 mm: wide head with the jaws angled away from the
 * handle axis, coarse V teeth, slot housing with five adjustment positions, plastic-dipped handles.
 * `groove` picks the adjustment: it moves the movable member sideways along the tongue so the closed jaws
 * stay parallel at a wider opening (about 5.5 mm per step, 42 mm at position 5 on a 250 mm tool).
 * Axis +Y from the butt to the jaw tips. Proportions after Knipex Cobra 87 01 250 / Irwin 250.
 */
import { type V2, DEG } from '../../math.ts';
import { extrude } from '../../build/primitives.ts';
import { METALS } from '../../materials.ts';
import type { Part } from '../../model.ts';
import { L, choice, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { type Mesh, mergeMeshes } from '../../mesh.ts';
import {
  type CrossingFrame,
  buildCrossing,
  crossingPieces,
  finishSchema,
  poseDims,
  zonesFor,
} from './crossing.ts';
import { HANDLE_STYLES } from './handles.ts';
import { type Pt, roundedOutline, swing, tipGap, toothedEdge } from './kit.ts';

const schema = {
  length: num(L('Overall length', 'Длина'), 250, 180, 320, { step: 5, dimension: true }),
  headThickness: num(L('Head thickness', 'Толщина головки'), 15, 10, 20, { step: 0.5 }),
  groove: num(L('Adjustment position', 'Положение паза'), 1, 1, 5, { step: 1 }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 0, 0, 24, { step: 1, unit: 'deg' }),
  headAngle: num(L('Head angle', 'Угол головки'), 20, 0, 40, { step: 1, unit: 'deg' }),
  handle: choice(L('Handle type', 'Тип рукоятей'), HANDLE_STYLES, 'dipped'),
  ...finishSchema,
};

const Y_PIVOT = 164;
const Y_HANDLE = 138;
const FRAME: CrossingFrame = {
  y0: 116,
  xi: 7.2,
  xo: 18,
  xh: 20.5,
  yS: Y_PIVOT - 0.5,
  y1: 138,
  yC: 181,
  diagBulge: 1,
};
const STEP = 5;

export const waterPumpPliers = defineToolClass({
  id: 'water-pump-pliers',
  family: 'pliers',
  name: L('Water pump pliers', 'Переставные клещи (сантехнические)'),
  bankClass: 'pliers',
  keywords: {
    en: [
      'water pump pliers',
      'tongue and groove pliers',
      'slip joint pliers',
      'plumbing pliers',
      'cobra pliers',
    ],
    ru: ['переставные клещи', 'сантехнические клещи', 'клещи переставные', 'газовый ключ'],
  },
  schema,
  presets: [
    {
      id: 'wp-250-blue',
      label: L('250 mm, blue', '250 мм, синие'),
      values: { handleColor: '#2455a8' },
    },
    {
      id: 'wp-250-wide',
      label: L('250 mm, red, position 4', '250 мм, красные, паз 4'),
      values: { groove: 4, handleColor: '#c8262b', finish: 'chrome' },
    },
    {
      id: 'wp-250-comfort',
      label: L('250 mm, yellow/black comfort', '250 мм, жёлто-чёрные'),
      values: { handle: 'comfort', handleColor: '#f0c326', finish: 'forged', groove: 2 },
    },
    {
      id: 'wp-300-open',
      label: L('300 mm, black oxide, open', '300 мм, чёрные, раскрыты'),
      values: {
        length: 300,
        handleColor: '#1b1c1e',
        finish: 'blackOxide',
        jawOpen: 14,
        groove: 3,
        headThickness: 17,
      },
    },
    {
      id: 'wp-200-bare',
      label: L('200 mm, bare steel', '200 мм, стальные'),
      values: { length: 200, handle: 'bare', finish: 'chrome', headThickness: 13 },
    },
  ],
  build(p, ctx) {
    const k = p.length / 250;
    const kw = k ** 0.7;
    const T = p.headThickness;
    const h = T / 2;
    const yP = Y_PIVOT * k;
    const yC = FRAME.yC * k;
    const tip = p.length - 0.5;
    const c = crossingPieces({
      y0: FRAME.y0 * k,
      xi: FRAME.xi * kw,
      xo: FRAME.xo * kw,
      xh: FRAME.xh * kw,
      yS: FRAME.yS * k,
      y1: FRAME.y1 * k,
      yC,
      diagBulge: FRAME.diagBulge ?? 0,
    });
    const tan = Math.tan(p.headAngle * DEG);
    const shear = (y: number, sign: number): number => sign * tan * Math.max(0, y - yC);
    const jawW = 22 * kw;
    const baseFace = 0.9;
    const jawGeom = (sign: number, off: number): { plate: Pt[]; jaw: Pt[]; edge: V2[] } => {
      const faceX = baseFace + off;
      const edge: V2[] = [];
      for (let i = 0; i <= 12; i++) {
        const y = yC + 4 * k + ((tip - yC - 4 * k) * i) / 12;
        edge.push([faceX + shear(y, sign), y]);
      }
      const outer: Pt[] = [];
      const nOut = 10;
      for (let i = 0; i <= nOut; i++) {
        const y = tip - ((tip - yP - 2) * i) / nOut;
        const u = Math.max(0, (y - yC) / (tip - yC));
        const w = jawW * (0.74 + 0.26 * (1 - u * u));
        outer.push([faceX + w + shear(y, sign), y, i === 0 ? 3 : i < 3 ? 6 : 0]);
      }
      const inner: Pt[] = [];
      for (let i = 0; i <= 10; i++) {
        const y = yC + ((tip - yC) * (10 - i)) / 10;
        inner.push([faceX + shear(y, sign), y, 0]);
      }
      const mid = c.diagBack[0] as Pt;
      const yEdge = yC + ((mid[1] - yC) * Math.min(faceX, mid[0] * 0.9)) / mid[0];
      const jaw: Pt[] = [
        ...outer,
        c.sR,
        ...c.diagBack,
        [faceX, yEdge, 0],
        ...inner.slice().reverse().slice(1),
      ];
      return {
        plate: [
          ...outer,
          c.sR,
          ...c.lower,
          [faceX, yC + 0.5, 0],
          ...inner.slice().reverse().slice(1),
        ],
        jaw,
        edge,
      };
    };
    const jawOffset = (p.groove - 1) * STEP * k;
    const A = jawGeom(1, 0);
    const B = jawGeom(-1, jawOffset);
    const faceZ = h - 1.2;
    const teeth = (g: { edge: V2[] }): Mesh[] =>
      ctx.detail ? [extrude(toothedEdge(g.edge, 3, 0.8, 1, 0.7), -faceZ, faceZ)] : [];

    // slot housing around the pivot: raised bezel, grooved tongue strip and the nub
    const slotHalf = 2 * STEP * k + 3.4;
    const slot = roundedOutline(
      [
        [-slotHalf, yP - 3.6, 3],
        [slotHalf, yP - 3.6, 3],
        [slotHalf, yP + 3.6, 3],
        [-slotHalf, yP + 3.6, 3],
      ],
      4,
    );
    const bezelOuter = roundedOutline(
      [
        [-slotHalf - 3.6, yP - 7.2, 5],
        [slotHalf + 3.6, yP - 7.2, 5],
        [slotHalf + 3.6, yP + 7.2, 5],
        [-slotHalf - 3.6, yP + 7.2, 5],
      ],
      4,
    );
    const bezel = extrude(bezelOuter, h, h + 0.8, { holes: [slot], bevel: 0.25 });
    const tongueTeeth = extrude(
      toothedEdge(
        [
          [-slotHalf + 0.6, yP - 0.4],
          [slotHalf - 0.6, yP - 0.4],
        ],
        STEP * k * 0.5,
        1.6,
        1,
        1.2,
      ),
      h - 0.4,
      h + 0.4,
    );
    const extra: Part[] = [
      {
        name: 'slot-housing',
        role: 'head',
        material: METALS.darkSteel,
        mesh: swing(
          mergeMeshes(ctx.detail ? [bezel, tongueTeeth] : [bezel]),
          0,
          yP,
          -p.jawOpen / 2,
        ),
        crease: 30,
      },
    ];
    const handleCtrl: V2[] = [
      [-24 * k, 0],
      [-22 * k, 30 * k],
      [-16 * k, 90 * k],
      [-12 * k, (Y_HANDLE - 2) * k],
    ];
    const parts = buildCrossing({
      geometry: {
        T,
        bevel: 1,
        plate: A.plate,
        front: [A.jaw, c.neck],
        steps: ctx.seg(4, 3),
        faces: teeth(A),
      },
      geometryB: {
        T,
        bevel: 1,
        plate: B.plate,
        front: [B.jaw, c.neck],
        steps: ctx.seg(4, 3),
        faces: teeth(B),
      },
      handle: { ctrl: handleCtrl, hw: 11.2, hz: h + 0.7, style: p.handle, grooves: 3, lip: 1.5 },
      pivot: [0, yP],
      pivotRadius: 4.8,
      openDeg: p.jawOpen,
      finish: p.finish,
      handleColor: p.handleColor,
      gripColor: p.gripColor,
      ctx,
      extra,
    });
    const { width, thickness } = poseDims(parts);
    const closedGap = 2 * baseFace + jawOffset;
    return {
      parts,
      hang: { point: [0, yP, 0], kind: 'head' },
      zones: zonesFor(Y_HANDLE * k, yC, p.length),
      dims: {
        length: p.length,
        width,
        thickness,
        headWidth: 2 * FRAME.xh * kw,
        jawLength: p.length - yC,
        handleLength: Y_HANDLE * k,
        handleWidth: 22.4,
        jawOpening: tipGap(tip - yP, p.jawOpen, closedGap),
      },
    };
  },
});
