/**
 * Long-nose (snipe-nose) pliers, 160 / 200 / 240 mm: slim head, long tapered half-round nose with a
 * serrated flat inner face and an optional side cutter at the nose root. Axis +Y from the handle butt to the
 * nose tip. Proportions of a 200 mm DIN ISO 5745 tool: head 28 wide, pivot-to-tip 72, nose 55 long
 * tapering from 9 to 1.3 mm, handle sleeve 20 x 13.
 */
import { at, extrude, place } from '../../build/primitives.ts';
import { L, choice, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import {
  type CrossingFrame,
  buildCrossing,
  crossingPieces,
  finishSchema,
  poseDims,
  zonesFor,
} from './crossing.ts';
import { HANDLE_STYLES } from './handles.ts';
import { type NoseStation, type Pt, noseLoft, tipGap, toothStrip } from './kit.ts';

const schema = {
  length: num(L('Overall length', 'Длина'), 200, 140, 260, { step: 5, dimension: true }),
  headThickness: num(L('Head thickness', 'Толщина головки'), 12.5, 8, 18, { step: 0.5 }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 0, 0, 36, { step: 1, unit: 'deg' }),
  cutter: choice(L('Side cutter', 'Боковой резак'), ['yes', 'none'] as const, 'yes'),
  handle: choice(L('Handle type', 'Тип рукоятей'), HANDLE_STYLES, 'dipped'),
  ...finishSchema,
};

const Y_PIVOT = 128;
const Y_TIP = 200;
const FRAME: CrossingFrame = {
  y0: 100,
  xi: 6.6,
  xo: 15.4,
  xh: 14,
  yS: Y_PIVOT - 0.5,
  y1: 119,
  yC: 139,
  diagBulge: 0.8,
};
const NOSE_Y = 147;
const FACE_X = 0.45;

export const longNosePliers = defineToolClass({
  id: 'pliers-long-nose',
  family: 'pliers',
  name: L('Long-nose pliers', 'Длинногубцы'),
  bankClass: 'pliers',
  keywords: {
    en: ['long nose pliers', 'needle nose pliers', 'snipe nose pliers', 'radio pliers'],
    ru: ['длинногубцы', 'утконосы', 'тонкогубцы', 'плоскогубцы длинные'],
  },
  schema,
  presets: [
    { id: 'ln-200-red', label: L('200 mm, red', '200 мм, красные'), values: {} },
    {
      id: 'ln-160-blue',
      label: L('160 mm, blue, chrome', '160 мм, синие, хром'),
      values: { length: 160, handleColor: '#2455a8', finish: 'chrome', headThickness: 11 },
    },
    {
      id: 'ln-200-comfort',
      label: L('200 mm, yellow/black comfort', '200 мм, жёлто-чёрные'),
      values: {
        handle: 'comfort',
        handleColor: '#f0c326',
        finish: 'forged',
        gripColor: '#1b1c1e',
        cutter: 'none',
      },
    },
    {
      id: 'ln-240-black-open',
      label: L('240 mm, black oxide, open', '240 мм, чёрные, раскрыты'),
      values: {
        length: 240,
        handleColor: '#1b1c1e',
        finish: 'blackOxide',
        jawOpen: 20,
        headThickness: 14,
      },
    },
  ],
  build(p, ctx) {
    const k = p.length / Y_TIP;
    const T = p.headThickness;
    const h = T / 2;
    const yP = Y_PIVOT * k;
    const c = crossingPieces({
      y0: FRAME.y0 * k,
      xi: FRAME.xi * k,
      xo: FRAME.xo * k,
      xh: FRAME.xh * k,
      yS: FRAME.yS * k,
      y1: FRAME.y1 * k,
      yC: FRAME.yC * k,
      diagBulge: FRAME.diagBulge ?? 0,
    });
    const yN = NOSE_Y * k;
    const yC = FRAME.yC * k;
    const mid = c.diagBack[0] as Pt;
    const yEdge = yC + ((mid[1] - yC) * FACE_X) / mid[0];
    const root = 9.6 * Math.sqrt(k);
    const jawOuter: Pt[] = [[root, yN, 0], [root + 1.4 * k, 137 * k, 12], c.sR];
    const plate: Pt[] = [...jawOuter, ...c.lower, [FACE_X, yC + 0.5], [FACE_X, yN]];
    const jaw: Pt[] = [...jawOuter, ...c.diagBack, [FACE_X, yEdge], [FACE_X, yN]];

    const tip = p.length;
    const span = tip - yN;
    const tt = h - 0.3;
    const stations: NoseStation[] = [
      [0, root - 0.15, tt],
      [0.06, root - 0.4, tt * 0.96],
      [0.28, root * 0.84, tt * 0.8],
      [0.55, root * 0.56, tt * 0.56],
      [0.8, root * 0.3, tt * 0.36],
      [0.94, root * 0.17, tt * 0.25],
      [0.985, root * 0.13, tt * 0.2],
      [1, root * 0.1, tt * 0.15],
    ].map(([u, w, t]) => ({
      y: yN - 1 + (span + 1) * (u as number),
      w: w as number,
      t: t as number,
    }));
    const nose = place(noseLoft(stations, 1, ctx.seg(16, 10), 2.4), at(FACE_X, 0, 0));

    const faces = ctx.detail
      ? [
          { y0: yN + 4, y1: yN + span * 0.45, z: tt * 0.62 },
          { y0: yN + span * 0.45, y1: yN + span * 0.78, z: tt * 0.4 },
          { y0: yN + span * 0.78, y1: tip - 1.2, z: tt * 0.22 },
        ].map((s) => extrude(toothStrip(FACE_X, s.y0, s.y1, 1.4, 0.45, -1), -s.z, s.z))
      : [];
    const zEdge = h - 1.1;
    const edges =
      p.cutter === 'yes'
        ? [
            extrude(
              [
                [2.6, yC + 1.5 * k],
                [0, yC + 3.5 * k],
                [0, yC + 8 * k],
                [2.6, yC + 9.2 * k],
              ],
              -zEdge,
              zEdge,
            ),
          ]
        : [];
    const parts = buildCrossing({
      geometry: {
        T,
        bevel: 0.9,
        plate: plate,
        front: [jaw, c.neck],
        steps: ctx.seg(5, 3),
        metal: [nose],
        faces,
        edges,
      },
      handle: {
        ctrl: [
          [-19 * k, 0],
          [-17.5 * k, 32 * k],
          [-14.2 * k, 78 * k],
          [-11 * k, (FRAME.y0 + 6) * k],
        ],
        hw: 9.8,
        hz: h + 0.6,
        style: p.handle,
        grooves: 3,
        lip: 1.4,
      },
      pivot: [0, yP],
      pivotRadius: 3.9,
      openDeg: p.jawOpen,
      finish: p.finish,
      handleColor: p.handleColor,
      gripColor: p.gripColor,
      ctx,
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
        headWidth: 2 * FRAME.xh * k,
        jawLength: p.length - yC,
        handleLength: (FRAME.y0 + 6) * k,
        handleWidth: 19.6,
        noseLength: span,
        jawOpening: tipGap(tip - yP, p.jawOpen, 0),
      },
    };
  },
});
