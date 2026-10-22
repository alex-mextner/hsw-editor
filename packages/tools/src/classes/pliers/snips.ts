/**
 * Aviation tin snips (compound leverage), 250 mm: long forged arms, short serrated blades that curve left
 * or right (colour-coded handles: red = left cut, green = right cut, yellow = straight), a compound link
 * bar between the handles, a return spring and a hook latch at the butt. Axis +Y from the handle butt
 * to the blade tips; handles cross at the blade pivot. Dimensions after Wiss M1R/M2R/M3R and Knipex
 * 98 10 250: total 250, blade 90 from the pivot, cutting length 32, sleeve 22 x 17.
 */
import { type V2 } from '../../math.ts';
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
  barMesh,
  innerFacePoints,
  latchPart,
  pinMesh,
  poseDims,
  vSpring,
  zonesFor,
} from './crossing.ts';
import { HANDLE_STYLES } from './handles.ts';
import { type Pt, makeSpine, resamplePolyline, tipGap, toothedEdge } from './kit.ts';

const CUTS = ['left', 'right', 'straight'] as const;

const schema = {
  length: num(L('Overall length', 'Длина'), 250, 200, 320, { step: 5, dimension: true }),
  headThickness: num(L('Blade stack thickness', 'Толщина лезвий'), 9, 6, 14, { step: 0.5 }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 0, 0, 30, { step: 1, unit: 'deg' }),
  cut: choice(L('Cut direction', 'Направление реза'), CUTS, 'left'),
  handle: choice(L('Handle type', 'Тип рукоятей'), HANDLE_STYLES, 'comfort'),
  ...finishSchema,
};

const Y_PIVOT = 176;
const Y_TIP = 250;
const Y_HANDLE = 126;
const FRAME: CrossingFrame = {
  y0: 118,
  xi: 5.4,
  xo: 11.4,
  xh: 14.4,
  yS: Y_PIVOT - 0.5,
  y1: 148,
  yC: 187,
  diagBulge: 0.6,
};

export const tinSnips = defineToolClass({
  id: 'tin-snips',
  family: 'pliers',
  name: L('Tin snips (aviation)', 'Ножницы по металлу (авиационные)'),
  bankClass: 'snips',
  keywords: {
    en: ['tin snips', 'aviation snips', 'metal shears', 'compound snips', 'sheet metal snips'],
    ru: ['ножницы по металлу', 'авиационные ножницы', 'металлические ножницы'],
  },
  schema,
  presets: [
    {
      id: 'ts-left-red',
      label: L('Left cut, red', 'Левые, красные'),
      values: { handleColor: '#c8262b' },
    },
    {
      id: 'ts-right-green',
      label: L('Right cut, green', 'Правые, зелёные'),
      values: { cut: 'right', handleColor: '#2f8f4c' },
    },
    {
      id: 'ts-straight-yellow',
      label: L('Straight cut, yellow', 'Прямые, жёлтые'),
      values: { cut: 'straight', handleColor: '#f0c326' },
    },
    {
      id: 'ts-left-open',
      label: L('Left cut, red, open', 'Левые, красные, раскрыты'),
      values: { jawOpen: 18, finish: 'forged' },
    },
    {
      id: 'ts-300-straight',
      label: L('300 mm straight, dipped', '300 мм, прямые, обливные'),
      values: {
        length: 300,
        cut: 'straight',
        handle: 'dipped',
        handleColor: '#2455a8',
        headThickness: 10,
      },
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
    const dir = p.cut === 'left' ? -1 : p.cut === 'right' ? 1 : 0;
    const bend = 11 * kw;
    const curve = (y: number, sign: number): number => {
      const u = Math.max(0, (y - yC) / (tip - yC));
      return sign * dir * bend * u * u;
    };
    const wRoot = 14.6 * kw;
    const wTip = 7.6 * kw;
    const jawGeom = (sign: number): { plate: Pt[]; jaw: Pt[]; edge: V2[] } => {
      const edge: V2[] = [];
      for (let i = 0; i <= 14; i++) {
        const y = yC + ((tip - 4 - yC) * i) / 14;
        edge.push([0.9 + curve(y, sign), y]);
      }
      for (let i = 0; i <= 8; i++) {
        const y = tip - 4 + (4 * i) / 8;
        edge.push([0.9 + curve(y, sign), y]);
      }
      const outer: Pt[] = [];
      for (let i = 0; i <= 12; i++) {
        const y = tip - ((tip - yP - 2) * i) / 12;
        const u = (y - yP) / (tip - yP);
        const w = wTip + (wRoot - wTip) * (1 - u) ** 1.2;
        const r = i === 0 ? 3 : 0;
        outer.push([0.9 + w + curve(y, sign), y, r]);
      }
      const innerDown: Pt[] = [];
      for (let i = 0; i <= 12; i++) {
        const y = tip - ((tip - yC) * i) / 12;
        innerDown.push([0.9 + curve(y, sign), y, 0]);
      }
      const mid = c.diagBack[0] as Pt;
      const yEdge = yC + ((mid[1] - yC) * 0.9) / mid[0];
      const plateOut: Pt[] = [
        ...outer.slice(0),
        c.sR,
        ...c.lower,
        [0.9, yC + 0.5, 0],
        ...innerDown.slice().reverse().slice(1),
      ];
      const jaw: Pt[] = [
        ...outer.slice(0),
        c.sR,
        ...c.diagBack,
        [0.9, yEdge, 0],
        ...innerDown.slice().reverse().slice(1),
      ];
      return { plate: plateOut, jaw, edge };
    };
    const A = jawGeom(1);
    const B = jawGeom(-1);
    const faceZ = h - 0.9;
    const teeth = (g: { edge: V2[] }): Mesh[] =>
      ctx.detail
        ? [extrude(toothedEdge(resamplePolyline(g.edge, 40), 1.8, 0.45, 1, 0.6), -faceZ, faceZ)]
        : [];
    const handleCtrl: V2[] = [
      [-20 * k, 0],
      [-19 * k, 26 * k],
      [-15.5 * k, 80 * k],
      [-11.8 * k, Y_HANDLE * k],
    ];
    const hw = 10.6;
    const hz = h + 3.6;
    const spine = makeSpine(handleCtrl);
    const extra: Part[] = [vSpring(spine, 62 * k, hw, [0, yP], p.jawOpen, ctx, 12)];

    // compound link between the handle tops and the butt latch
    const sLink = spine.length * 0.9;
    const lk = innerFacePoints(spine, sLink, hw - 0.5, [0, yP], p.jawOpen);
    extra.push({
      name: 'link',
      role: 'link',
      material: METALS.zinc,
      mesh: barMesh(lk.a, lk.b, 3.2, -1.4, 1.4),
      crease: 30,
    });
    extra.push({
      name: 'link-pins',
      role: 'pivot',
      material: METALS.steel,
      mesh: mergeMeshes([pinMesh(lk.a), pinMesh(lk.b)]),
      crease: 30,
    });
    extra.push(latchPart(spine, 16 * k, hw, [0, yP], p.jawOpen, hz - 0.4, 24 * k));

    const parts = buildCrossing({
      geometry: {
        T,
        bevel: 0.7,
        plate: A.plate,
        front: [A.jaw, c.neck],
        steps: ctx.seg(4, 3),
        faces: teeth(A),
      },
      geometryB: {
        T,
        bevel: 0.7,
        plate: B.plate,
        front: [B.jaw, c.neck],
        steps: ctx.seg(4, 3),
        faces: teeth(B),
      },
      handle: {
        ctrl: handleCtrl,
        hw,
        hz,
        style: p.handle,
        grooves: 4,
        lip: 1.6,
      },
      pivot: [0, yP],
      pivotRadius: 4.2,
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
      hang: { point: [0, Y_HANDLE * k, 0], kind: 'neck' },
      zones: zonesFor(Y_HANDLE * k, yC, p.length),
      dims: {
        length: p.length,
        width,
        thickness,
        headWidth: 2 * FRAME.xh * kw,
        jawLength: tip - yC,
        handleLength: Y_HANDLE * k,
        handleWidth: 2 * hw,
        jawOpening: tipGap(tip - yP, p.jawOpen, 0),
      },
    };
  },
});
