/**
 * Wire stripper / crimper (160 / 180 / 200 mm): flat-nosed head whose jaws carry graduated stripping
 * holes (0.8 .. 3.2 mm, round bites that close into holes), a crimp pocket with serrations, a cutting
 * edge at the root of the jaws, a V return spring and a hook lock at the butt. Axis +Y from the butt
 * to the jaw tips. Proportions after Knipex 97 11 / Klauke / Irwin Vise-Grip strippers: head 31 wide,
 * jaw 38 long, handle sleeve 19 x 13.
 */
import { type V2 } from '../../math.ts';
import { extrude } from '../../build/primitives.ts';
import { L, choice, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import type { Mesh } from '../../mesh.ts';
import {
  type CrossingFrame,
  buildCrossing,
  crossingPieces,
  finishSchema,
  latchPart,
  poseDims,
  vSpring,
  zonesFor,
} from './crossing.ts';
import { HANDLE_STYLES } from './handles.ts';
import { type Pt, arcPoints, makeSpine, tipGap, toothStrip } from './kit.ts';

const schema = {
  length: num(L('Overall length', 'Длина'), 180, 140, 230, { step: 5, dimension: true }),
  headThickness: num(L('Head thickness', 'Толщина головки'), 11, 8, 16, { step: 0.5 }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 0, 0, 30, { step: 1, unit: 'deg' }),
  lock: choice(L('Handle lock', 'Фиксатор рукоятей'), ['yes', 'none'] as const, 'yes'),
  handle: choice(L('Handle type', 'Тип рукоятей'), HANDLE_STYLES, 'comfort'),
  ...finishSchema,
};

const Y_PIVOT = 118;
const Y_TIP = 180;
const FRAME: CrossingFrame = {
  y0: 88,
  xi: 6,
  xo: 14,
  xh: 15.5,
  yS: Y_PIVOT - 0.5,
  y1: 106,
  yC: 130,
  diagBulge: 0.6,
};
/** Strip hole radii (mm) from the tip towards the root. */
const STRIP_RADII = [0.45, 0.65, 0.9, 1.15, 1.45, 1.8] as const;

export const crimperStripper = defineToolClass({
  id: 'crimper-stripper',
  family: 'pliers',
  name: L('Wire stripper / crimper', 'Стриппер / обжимник'),
  bankClass: 'pliers',
  keywords: {
    en: ['wire stripper', 'crimper', 'crimping pliers', 'wire stripper crimper', 'cable stripper'],
    ru: ['стриппер', 'обжимные клещи', 'обжимник', 'инструмент для снятия изоляции'],
  },
  schema,
  presets: [
    {
      id: 'cs-180-yellow',
      label: L('180 mm, yellow/black', '180 мм, жёлто-чёрный'),
      values: { handleColor: '#f0c326' },
    },
    {
      id: 'cs-160-red',
      label: L('160 mm, red dipped', '160 мм, красный'),
      values: {
        length: 160,
        handle: 'dipped',
        handleColor: '#c8262b',
        finish: 'chrome',
        lock: 'none',
      },
    },
    {
      id: 'cs-200-blue',
      label: L('200 mm, blue/black', '200 мм, синий'),
      values: { length: 200, handleColor: '#2455a8', finish: 'forged', headThickness: 12 },
    },
    {
      id: 'cs-180-open',
      label: L('180 mm, orange, open', '180 мм, оранжевый, раскрыт'),
      values: { handleColor: '#e8741e', jawOpen: 20, finish: 'blackOxide' },
    },
  ],
  build(p, ctx) {
    const k = p.length / Y_TIP;
    const kw = k ** 0.5;
    const T = p.headThickness;
    const h = T / 2;
    const yP = Y_PIVOT * k;
    const yC = FRAME.yC * k;
    const tip = p.length;
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
    const faceX = 0.8;
    const jawW = 11.2 * kw;
    const span = tip - yC;
    const circleSegs = ctx.seg(10, 6);
    // inner edge from the root (low y) to the tip with round bites and the crimp pocket
    const holes: { y: number; r: number }[] = STRIP_RADII.map((r, i) => ({
      r,
      y: tip - 5.5 * k - ((i * (span - 22 * k)) / (STRIP_RADII.length - 1)) * 0.55 - i * 2.2,
    }));
    holes.sort((a, b) => a.y - b.y);
    const bite = (cy: number, r: number): V2[] =>
      arcPoints(faceX, cy, r, -90, 90, circleSegs).map(([x, y]) => [x, y] as V2);
    // crimp pocket: two rounded rectangular bites, root side
    const crimpY = yC + 8 * k;
    const pocket: V2[] = [
      [faceX, crimpY],
      [faceX + 2.6, crimpY + 0.8],
      [faceX + 3.1, crimpY + 3.2],
      [faceX + 2.6, crimpY + 5.6],
      [faceX, crimpY + 6.4],
    ];
    const seq: V2[] = [...pocket];
    for (const hl of holes) {
      if (hl.y - hl.r < crimpY + 7) continue;
      seq.push(...bite(hl.y, hl.r));
    }
    const edgeBites: Pt[] = seq.map((q) => [q[0], q[1], 0]);
    const outer: Pt[] = [];
    const nOut = 9;
    for (let i = 0; i <= nOut; i++) {
      const y = tip - ((tip - yC - 1) * i) / nOut;
      const u = Math.max(0, (y - yC) / span);
      const w = jawW * (0.82 + 0.18 * (1 - u * u));
      outer.push([faceX + w, y, i === 0 ? 1.6 : i === 1 ? 4 : 0]);
    }
    const mid = c.diagBack[0] as Pt;
    const yEdge = yC + ((mid[1] - yC) * faceX) / mid[0];
    const plate: Pt[] = [
      ...outer,
      c.sR,
      ...c.lower,
      [faceX, yC + 0.5, 0],
      ...edgeBites,
      [faceX, tip, 0.4],
    ];
    const jaw: Pt[] = [
      ...outer,
      c.sR,
      ...c.diagBack,
      [faceX, yEdge, 0],
      ...edgeBites,
      [faceX, tip, 0.4],
    ];

    // serrations in the crimp pocket (inside the bite, so the jaw face reads as knurled)
    const faces: Mesh[] = ctx.detail
      ? [
          extrude(
            toothStrip(faceX + 2.9, crimpY + 0.9, crimpY + 5.4, 1.1, 0.5, -1),
            -(h - 1.6),
            h - 1.6,
          ),
        ]
      : [];
    const zEdge = h - 1.1;
    const edges: Mesh[] = [
      extrude(
        [
          [2.4, yC - 5 * k],
          [0, yC - 3 * k],
          [0, yC + 0.2 * k],
          [2.4, yC + 1.6 * k],
        ],
        -zEdge,
        zEdge,
      ),
    ];
    const handleCtrl: V2[] = [
      [-19 * k, 0],
      [-17.8 * k, 24 * k],
      [-14.4 * k, 62 * k],
      [-11.2 * k, (FRAME.y0 + 6) * k],
    ];
    const hw = 9.6;
    const hz = h + 1.2;
    const spine = makeSpine(handleCtrl);
    const extra = [vSpring(spine, 52 * k, hw, [0, yP], p.jawOpen, ctx, 12)];
    if (p.lock === 'yes')
      extra.push(latchPart(spine, 14 * k, hw, [0, yP], p.jawOpen, hz - 0.4, 20 * k));
    const parts = buildCrossing({
      geometry: { T, bevel: 0.9, plate, front: [jaw, c.neck], steps: ctx.seg(4, 3), faces, edges },
      handle: { ctrl: handleCtrl, hw, hz, style: p.handle, grooves: 3, lip: 1.4 },
      pivot: [0, yP],
      pivotRadius: 3.9,
      openDeg: p.jawOpen,
      finish: p.finish,
      handleColor: p.handleColor,
      gripColor: p.gripColor,
      ctx,
      extra,
    });
    const { width, thickness } = poseDims(parts);
    return {
      parts,
      hang: { point: [0, yP, 0], kind: 'head' },
      zones: zonesFor((FRAME.y0 + 6) * k, yC, p.length),
      dims: {
        length: p.length,
        width,
        thickness,
        headWidth: 2 * FRAME.xh * kw,
        jawLength: p.length - yC,
        handleLength: (FRAME.y0 + 6) * k,
        handleWidth: 2 * hw,
        jawOpening: tipGap(tip - yP, p.jawOpen, 0),
      },
    };
  },
});
