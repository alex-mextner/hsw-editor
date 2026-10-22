/**
 * Spring clamp (150 mm "6 in" class; 100 .. 230 mm): two injection-moulded levers crossing at a steel pivot
 * pin, ribbed splayed handles, wide rubber-dipped jaw tips and a coil torsion spring around the pivot
 * whose legs press against the handles. Axis +Y from the handle butt to the jaw tips.
 * Sizes after Irwin / Bessey spring clamps: 4 in = 100 mm tool (jaw capacity 38), 6 in = 150 (50), 9 in = 230 (75).
 */
import { type V3, DEG } from '../../math.ts';
import { extrude, tube } from '../../build/primitives.ts';
import { METALS, plastic, rubber } from '../../materials.ts';
import type { Part } from '../../model.ts';
import { L, color, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { type Mesh } from '../../mesh.ts';
import {
  type CrossingFrame,
  buildCrossing,
  crossingPieces,
  innerFacePoints,
  poseDims,
  zonesFor,
} from './crossing.ts';
import { type Pt, makeSpine, tipGap } from './kit.ts';

const schema = {
  length: num(L('Overall length', 'Длина'), 150, 90, 240, { step: 5, dimension: true }),
  leverThickness: num(L('Lever thickness', 'Толщина рычагов'), 14, 9, 22, { step: 0.5 }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 0, 0, 40, { step: 1, unit: 'deg' }),
  leverColor: color(L('Lever colour', 'Цвет рычагов'), '#e8741e'),
  padColor: color(L('Jaw tip colour', 'Цвет накладок'), '#1b1c1e'),
};

const Y_PIVOT = 62;
/** `xo` is derived from the handle outline in `build`. */
const FRAME: Omit<CrossingFrame, 'xo'> = {
  y0: 44,
  xi: 3,
  xh: 12,
  yS: Y_PIVOT - 0.5,
  y1: 52,
  yC: 76,
  diagBulge: 0.4,
};

export const springClamp = defineToolClass({
  id: 'spring-clamp',
  family: 'pliers',
  name: L('Spring clamp', 'Пружинная струбцина'),
  bankClass: 'clamp',
  keywords: {
    en: ['spring clamp', 'plastic spring clamp', 'pinch clamp', 'squeeze clamp'],
    ru: ['пружинная струбцина', 'зажим пружинный', 'прищепка'],
  },
  schema,
  presets: [
    { id: 'sp-150-orange', label: L('150 mm (6 in), orange', '150 мм, оранжевая'), values: {} },
    {
      id: 'sp-100-yellow',
      label: L('100 mm (4 in), yellow', '100 мм, жёлтая'),
      values: { length: 100, leverThickness: 11, leverColor: '#f0c326' },
    },
    {
      id: 'sp-230-blue',
      label: L('230 mm (9 in), blue', '230 мм, синяя'),
      values: { length: 230, leverThickness: 18, leverColor: '#2455a8' },
    },
    {
      id: 'sp-150-open',
      label: L('150 mm, red, open', '150 мм, красная, раскрыта'),
      values: { leverColor: '#c8262b', jawOpen: 16 },
    },
  ],
  build(p, ctx) {
    const k = p.length / 150;
    const kw = k ** 0.55;
    const T = p.leverThickness;
    const h = T / 2;
    const tip = p.length;
    const yP = Y_PIVOT * k;
    const yC = FRAME.yC * k;
    const y0 = FRAME.y0 * k;
    const botOuter: Pt = [-30 * kw, 2 * k, 6];
    const botInner: Pt = [-13.5 * kw, 4 * k, 6];
    const yS = FRAME.yS * k;
    const outerAt = (y: number): number =>
      botOuter[0] + ((-FRAME.xh * kw - botOuter[0]) * (y - botOuter[1])) / (yS - botOuter[1]);
    const innerAt = (y: number): number =>
      botInner[0] + ((-FRAME.xi * kw - botInner[0]) * (y - botInner[1])) / (y0 - botInner[1]);
    const c = crossingPieces({
      y0,
      xi: FRAME.xi * kw,
      xo: -outerAt(y0),
      xh: FRAME.xh * kw,
      yS: FRAME.yS * k,
      y1: FRAME.y1 * k,
      yC,
      diagBulge: FRAME.diagBulge ?? 0,
    });
    const faceX = 0.9;
    const jawW = 16.5 * kw;
    // handle outline (replaces the stub of the crossing frame)
    const y1 = (c.neck[3] as Pt)[1];
    const lower: Pt[] = [
      c.lower[0] as Pt,
      [-FRAME.xi * kw, y0, 0],
      botInner,
      botOuter,
      [-FRAME.xh * kw, FRAME.yS * k, 2],
      c.lower[4] as Pt,
      c.lower[5] as Pt,
    ];
    const outer: Pt[] = [];
    const nOut = 6;
    const jawEnd = tip - 4; // the rubber tip covers the last stretch, so the lever stops short of it
    for (let i = 0; i <= nOut; i++) {
      const y = jawEnd - ((jawEnd - yC - 1) * i) / nOut;
      outer.push([faceX + jawW, y, 0]);
    }
    const mid = c.diagBack[0] as Pt;
    const yEdge = yC + ((mid[1] - yC) * faceX) / mid[0];
    const tipR: Pt = [faceX, jawEnd, 0];
    const plate: Pt[] = [...outer, c.sR, ...lower, [faceX, yC + 0.5, 0], tipR];
    const jaw: Pt[] = [...outer, c.sR, ...c.diagBack, [faceX, yEdge, 0], tipR];
    const neck: Pt[] = [
      [outerAt(y1), y1, 0],
      [0, c.yX, 0],
      [-FRAME.xi * kw, y0, 0],
      botInner,
      botOuter,
    ];
    // grip ribs across the handle
    const ribs: Mesh[] = [];
    if (ctx.detail) {
      const pitch = 5 * k;
      for (let y = 10 * k; y < y0 - 3 * k; y += pitch) {
        ribs.push(
          extrude(
            [
              [innerAt(y) - 1, y - 0.9],
              [outerAt(y) + 1, y - 0.9],
              [outerAt(y) + 1, y + 0.9],
              [innerAt(y) - 1, y + 0.9],
            ],
            -(h + 0.55),
            h + 0.55,
            { bevel: 0.35 },
          ),
        );
      }
    }
    // rubber tip cover over the last stretch of the jaw (separate shell, slightly larger than the lever)
    const padLen = 34 * k;
    const pad = extrude(
      [
        [faceX, tip - padLen],
        [faceX + jawW + 1.6, tip - padLen],
        [faceX + jawW + 1.6, tip - 6],
        [faceX + jawW - 1, tip],
        [faceX, tip],
      ],
      -(h + 1.4),
      h + 1.4,
      { bevel: 1.2 },
    );

    // coil torsion spring around the pivot, legs resting on the handles
    const spine = makeSpine([
      [-21.8 * kw, 3 * k],
      [-10.15 * kw, y0],
    ]);
    const legS = spine.length * 0.6;
    const { a, b } = innerFacePoints(spine, legS, 6.4 * kw, [0, yP], p.jawOpen);
    const R = 5.6;
    const zc = h + 1.2;
    const turns = 2.5;
    const COIL_RISE = turns * 2 * 0.95; // pitch just above the 1.9 mm wire diameter
    const per = ctx.seg(12, 6);
    const path: V3[] = [[a[0], a[1], zc]];
    const startAng = 180 * DEG;
    const total = turns * 2 * Math.PI;
    for (let i = 0; i <= Math.round(turns * per); i++) {
      const t = i / Math.round(turns * per);
      const ang = startAng - t * total;
      path.push([R * Math.cos(ang), yP + R * Math.sin(ang), zc + COIL_RISE * t]);
    }
    path.push([b[0], b[1], zc + COIL_RISE]);
    const spring: Part = {
      name: 'spring',
      role: 'spring',
      material: METALS.zinc,
      mesh: tube(path, 0.95, { sides: ctx.seg(8, 6), up: [0, 0, 1] }),
      crease: 35,
    };
    const parts = buildCrossing({
      geometry: {
        T,
        bevel: 1.1,
        plate,
        front: [jaw, neck],
        steps: ctx.seg(5, 3),
        metal: ribs,
        faces: [pad],
      },
      pivot: [0, yP],
      pivotRadius: 3.6,
      openDeg: p.jawOpen,
      finish: 'polished',
      handleColor: p.leverColor,
      gripColor: p.padColor,
      metalMaterial: plastic(p.leverColor, 0.42, 'moulded lever'),
      faceMaterial: rubber(p.padColor, 'smooth', 'rubber tip'),
      ctx,
      extra: [spring],
    });
    const { width, thickness } = poseDims(parts);
    return {
      parts,
      hang: { point: [0, 2 * k + 6, 0], kind: 'butt' },
      zones: zonesFor(y0, yC, p.length),
      dims: {
        length: p.length,
        width,
        thickness,
        jawLength: tip - yP,
        handleLength: yP,
        jawWidth: jawW + 3.2,
        jawOpening: tipGap(tip - yP, p.jawOpen, 1.8),
      },
    };
  },
});
