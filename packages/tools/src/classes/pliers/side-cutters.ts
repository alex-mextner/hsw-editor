/**
 * Diagonal side cutters (140 / 160 / 180 mm): compact rounded head with two bevelled cutting blades, nose
 * swept back at the tip, crossed levers on a riveted pivot, dipped handles and an optional leaf spring.
 * Axis +Y from the butt to the cutting edge. Proportions: 160 mm tool, head 26 wide, pivot-to-tip 36,
 * head thickness 13, handle sleeve 20 x 13 (Knipex 70 01 160 class).
 */
import { type V2 } from '../../math.ts';
import { L, choice, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import {
  type CrossingFrame,
  buildCrossing,
  crossingPieces,
  finishSchema,
  poseDims,
  vSpring,
  zonesFor,
} from './crossing.ts';
import { HANDLE_STYLES } from './handles.ts';
import { type Pt, makeSpine, tipGap, wedgeLoft } from './kit.ts';
import type { Part } from '../../model.ts';

const schema = {
  length: num(L('Overall length', 'Длина'), 160, 120, 220, { step: 5, dimension: true }),
  headThickness: num(L('Head thickness', 'Толщина головки'), 13, 9, 18, { step: 0.5 }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 12, 0, 36, { step: 1, unit: 'deg' }),
  headAngle: num(L('Nose sweep', 'Скос носика'), 14, 0, 28, { step: 1, unit: 'deg' }),
  spring: choice(L('Return spring', 'Возвратная пружина'), ['none', 'leaf'] as const, 'leaf'),
  handle: choice(L('Handle type', 'Тип рукоятей'), HANDLE_STYLES, 'dipped'),
  ...finishSchema,
};

const FRAME: CrossingFrame = {
  y0: 88,
  xi: 5.6,
  xo: 13,
  xh: 13.4,
  yS: 127.5,
  y1: 114,
  yC: 137.5,
  diagBulge: 0.8,
};
const Y_PIVOT = 128;

export const sideCutters = defineToolClass({
  id: 'side-cutters',
  family: 'pliers',
  name: L('Diagonal side cutters', 'Бокорезы'),
  bankClass: 'snips',
  keywords: {
    en: ['side cutters', 'diagonal cutters', 'wire cutters', 'nippers', 'diagonal pliers'],
    ru: ['бокорезы', 'кусачки', 'боковые кусачки'],
  },
  schema,
  presets: [
    {
      id: 'sc-160-red',
      label: L('160 mm, red, spring', '160 мм, красные'),
      values: {},
    },
    {
      id: 'sc-160-blue',
      label: L('160 mm, blue, spring', '160 мм, синие'),
      values: { handleColor: '#2455a8', finish: 'chrome' },
    },
    {
      id: 'sc-140-yellow',
      label: L('140 mm, yellow/black', '140 мм, жёлто-чёрные'),
      values: {
        length: 140,
        handle: 'comfort',
        handleColor: '#f0c326',
        gripColor: '#1b1c1e',
        finish: 'forged',
        spring: 'none',
        jawOpen: 6,
        headThickness: 12,
      },
    },
    {
      id: 'sc-180-black',
      label: L('180 mm, black oxide', '180 мм, чёрные'),
      values: {
        length: 180,
        handleColor: '#1b1c1e',
        finish: 'blackOxide',
        headThickness: 14,
        jawOpen: 20,
      },
    },
  ],
  build(p, ctx) {
    const k = p.length / 160;
    const T = p.headThickness;
    const h = T / 2;
    const yP = Y_PIVOT * k;
    const c = crossingPieces({
      ...FRAME,
      y0: FRAME.y0 * k,
      xi: FRAME.xi * k,
      xo: FRAME.xo * k,
      xh: FRAME.xh * k,
      yS: FRAME.yS * k,
      y1: FRAME.y1 * k,
      yC: FRAME.yC * k,
    });
    const plate: Pt[] = [c.sR, ...c.lower, ...c.diagBack];
    const tip = p.length;
    const w0 = FRAME.xh * k;
    const tt = h - 0.3;
    const head = wedgeLoft(
      [
        [FRAME.yS * k - 2, w0 - 0.2, tt],
        [FRAME.yC * k + 1, w0 * 0.97, tt],
        [FRAME.yC * k + (tip - FRAME.yC * k) * 0.4, w0 * 0.9, tt * 0.95],
        [FRAME.yC * k + (tip - FRAME.yC * k) * 0.72, w0 * 0.7, tt * 0.85],
        [tip - 3, w0 * 0.42, tt * 0.7],
        [tip - 1, w0 * 0.28, tt * 0.55],
        [tip, w0 * 0.2, tt * 0.42],
      ],
      { noseDeg: p.headAngle, perSegment: ctx.seg(4, 2), backPoints: ctx.seg(9, 5) },
    );
    const handleCtrl: V2[] = [
      [-19.6 * k, 0],
      [-18.5 * k, 22 * k],
      [-15.4 * k, 62 * k],
      [-11.6 * k, (FRAME.y0 + 6.5) * k],
    ];
    const hw = 10;
    const extra: Part[] = [];
    if (p.spring === 'leaf') {
      extra.push(vSpring(makeSpine(handleCtrl), 52 * k, hw, [0, yP], p.jawOpen, ctx));
    }
    const parts = buildCrossing({
      geometry: {
        T,
        bevel: 1,
        plate,
        front: [c.neck],
        steps: ctx.seg(5, 3),
        metal: [head],
      },
      handle: {
        ctrl: handleCtrl,
        hw,
        hz: h + 0.6,
        style: p.handle,
        grooves: 3,
        lip: 1.4,
      },
      pivot: [0, yP],
      pivotRadius: 3.7,
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
      zones: zonesFor(94.5 * k, FRAME.yC * k, p.length),
      dims: {
        length: p.length,
        width,
        thickness,
        headWidth: 2 * FRAME.xh * k,
        jawLength: p.length - FRAME.yC * k,
        handleLength: 94.5 * k,
        handleWidth: 20,
        jawOpening: tipGap(tip - yP, p.jawOpen, 0),
      },
    };
  },
});
