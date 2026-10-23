/**
 * Combination pliers (lineman style, 160 / 180 / 200 mm): forged head with serrated flat jaws, round
 * pipe-grip notch, side cutter at the base of the jaws, riveted pivot and dipped / two-component handles.
 * Axis +Y from the handle butt to the jaw tips; the levers cross at the pivot. Proportions follow a 180 mm
 * Knipex-class tool: head width 35, pivot-to-tip 52, head thickness 14, handle sleeve 21 x 15.
 */
import { extrude } from '../../build/primitives.ts';
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
import { type Pt, arcPoints, scalePts, tipGap, toothStrip } from './kit.ts';

const schema = {
  length: num(L('Overall length', 'Длина'), 180, 140, 240, { step: 5, dimension: true }),
  headThickness: num(L('Head thickness', 'Толщина головки'), 14, 10, 20, { step: 0.5 }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 0, 0, 40, { step: 1, unit: 'deg' }),
  handle: choice(L('Handle type', 'Тип рукоятей'), HANDLE_STYLES, 'dipped'),
  ...finishSchema,
};

const Y_PIVOT = 130;
const Y_TIP = 180;

const FRAME: CrossingFrame = {
  y0: 98,
  xi: 7.5,
  xo: 17,
  xh: 17.6,
  yS: Y_PIVOT - 0.5,
  y1: 120,
  yC: 142,
  diagBulge: 1,
};

/** Outlines of lever A (closed pose, jaw on +x) for the 180 mm tool; scale with `scalePts`. */
function outlines(): { plate: Pt[]; jaw: Pt[]; neck: Pt[] } {
  const c = crossingPieces(FRAME);
  const hole: Pt[] = arcPoints(0, 156, 5.6, -78, 78, 12).map(([x, y]) => [x, y, 0] as Pt);
  const inner: Pt[] = [[2.4, 150.4], ...hole, [1.0, 161.6], [0.9, Y_TIP, 0.6]];
  const jawOuter: Pt[] = [[9.2, Y_TIP, 1.4], [11.4, 165, 16], [16.0, 143, 14], c.sR];
  // B's mirrored diagonal at the cutter recess (x = 2.4): where the front jaw piece meets it
  const mid = c.diagBack[0] as Pt;
  const yEdge = FRAME.yC + ((mid[1] - FRAME.yC) * 2.4) / mid[0];
  return {
    plate: [...jawOuter, ...c.lower, [2.4, FRAME.yC + 0.5], ...inner],
    jaw: [...jawOuter, ...c.diagBack, [2.4, yEdge], ...inner],
    neck: c.neck,
  };
}

export const combinationPliers = defineToolClass({
  id: 'pliers-combination',
  family: 'pliers',
  name: L('Combination pliers', 'Плоскогубцы комбинированные'),
  bankClass: 'pliers',
  keywords: {
    en: ['combination pliers', 'pliers', 'lineman pliers', 'universal pliers'],
    ru: ['плоскогубцы', 'пассатижи', 'комбинированные плоскогубцы'],
  },
  schema,
  presets: [
    { id: 'cp-180-red', label: L('180 mm, red dipped', '180 мм, красные'), values: {} },
    {
      id: 'cp-160-blue',
      label: L('160 mm, blue dipped', '160 мм, синие'),
      values: { length: 160, handleColor: '#2455a8', finish: 'chrome', headThickness: 13 },
    },
    {
      id: 'cp-200-comfort',
      label: L('200 mm, yellow/black comfort grip', '200 мм, жёлто-чёрные'),
      values: {
        length: 200,
        handle: 'comfort',
        handleColor: '#f0c326',
        gripColor: '#1b1c1e',
        headThickness: 15,
        finish: 'forged',
      },
    },
    {
      id: 'cp-180-black-open',
      label: L('180 mm, black oxide, open', '180 мм, чёрные, раскрыты'),
      values: { handleColor: '#1b1c1e', finish: 'blackOxide', jawOpen: 24 },
    },
    {
      id: 'cp-200-bare',
      label: L('200 mm, bare steel handles', '200 мм, стальные рукояти'),
      values: { length: 200, handle: 'bare', finish: 'chrome', headThickness: 14 },
    },
  ],
  build(p, ctx) {
    const k = p.length / 180;
    const T = p.headThickness;
    const h = T / 2;
    const o = outlines();
    const yP = Y_PIVOT * k;
    const detail = ctx.detail;
    const teethY0 = 162.2 * k;
    const teethY1 = Y_TIP * k - 0.8;
    const zEdge = h - 1.1;
    const faces = detail
      ? [extrude(toothStrip(0.9, teethY0, teethY1, 1.5, 0.9, -1), -zEdge, zEdge)]
      : [];
    const edges = [
      extrude(
        [
          [2.6 * k, 142.3 * k],
          [0, 144.5 * k],
          [0, 148.4 * k],
          [2.6 * k, 150.4 * k],
        ],
        -zEdge,
        zEdge,
      ),
    ];
    const parts = buildCrossing({
      geometry: {
        T,
        bevel: 1,
        plate: scalePts(o.plate, k),
        front: [scalePts(o.jaw, k), scalePts(o.neck, k)],
        steps: ctx.seg(5, 3),
        faces,
        edges,
      },
      handle: {
        ctrl: [
          [-21.5 * k, 0],
          [-20 * k, 25 * k],
          [-16.8 * k, 65 * k],
          [-12.5 * k, 100 * k],
          [-11.8 * k, 104.5 * k],
        ],
        hw: 10.6,
        hz: h + 0.7,
        style: p.handle,
        grooves: 3,
        lip: 1.6,
      },
      pivot: [0, yP],
      pivotRadius: 4.3,
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
      zones: zonesFor(104 * k, 142 * k, p.length),
      dims: {
        length: p.length,
        width,
        thickness,
        headWidth: 2 * 17.6 * k,
        jawLength: p.length - 142 * k,
        handleLength: 104 * k,
        handleWidth: 21.2,
        jawOpening: tipGap(Y_TIP * k - yP, p.jawOpen, 0),
      },
    };
  },
});
