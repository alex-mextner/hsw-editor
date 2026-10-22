/**
 * Locking pliers (Vise-Grip style, 7 in = 180 mm ... 10 in = 250 mm ... 12 in): steel body with fixed jaw and
 * fixed handle, movable jaw on a pivot, lever handle with a release tab, serrated curved (or straight) jaws
 * and the adjusting screw knob at the tail. Axis +Y from the knob to the jaw tips; jaws and handles open in
 * the xy plane. Proportions of a 10 in curved-jaw tool: length 250, head width 52, handle sleeve 22 x 15.
 */
import { type V2 } from '../../math.ts';
import { at, extrude, loft, place } from '../../build/primitives.ts';
import { circleRing, flutedRing } from '../../build/rings.ts';
import { METALS } from '../../materials.ts';
import type { Part } from '../../model.ts';
import { L, choice, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { type Mesh, mergeMeshes } from '../../mesh.ts';
import { FINISHES, crossingMaterials, finishSchema, headMaterial, poseDims } from './crossing.ts';
import { HANDLE_STYLES, buildHandle } from './handles.ts';
import { type Pt, plateMesh, rivetMesh, swing, tipGap, toothedEdge } from './kit.ts';

const schema = {
  length: num(L('Overall length', 'Длина'), 250, 150, 320, { step: 5, dimension: true }),
  jawOpen: num(L('Jaw opening angle', 'Угол раскрытия'), 0, 0, 28, { step: 1, unit: 'deg' }),
  jaws: choice(L('Jaw shape', 'Форма губок'), ['curved', 'straight'] as const, 'curved'),
  handle: choice(L('Handle type', 'Тип рукоятей'), HANDLE_STYLES, 'dipped'),
  ...finishSchema,
  finish: choice(L('Body finish', 'Покрытие корпуса'), FINISHES, 'chrome'),
};

const Y_TIP = 214;
const HEAD_T = 13;

export const lockingPliers = defineToolClass({
  id: 'locking-pliers',
  family: 'pliers',
  name: L('Locking pliers', 'Зажимные плоскогубцы (вайсгрипы)'),
  bankClass: 'pliers',
  keywords: {
    en: ['locking pliers', 'vise grip', 'vise-grip', 'mole grip', 'locking wrench'],
    ru: ['зажимные плоскогубцы', 'вайсгрип', 'клещи зажимные', 'самозажимные плоскогубцы'],
  },
  schema,
  presets: [
    {
      id: 'lp-10in-curved',
      label: L('10 in curved jaw, red', '10", изогнутые, красные'),
      values: {},
    },
    {
      id: 'lp-7in-curved',
      label: L('7 in curved jaw, blue', '7", изогнутые, синие'),
      values: { length: 180, handleColor: '#2455a8', finish: 'polished', jawOpen: 12 },
    },
    {
      id: 'lp-10in-straight',
      label: L('10 in straight jaw, orange/black', '10", прямые, оранжевые'),
      values: {
        jaws: 'straight',
        handle: 'comfort',
        handleColor: '#e8741e',
        gripColor: '#1b1c1e',
        finish: 'blackOxide',
      },
    },
    {
      id: 'lp-12in-open',
      label: L('12 in, bare steel, open', '12", стальные, раскрыты'),
      values: { length: 300, handle: 'bare', finish: 'chrome', jawOpen: 24 },
    },
  ],
  build(p, ctx) {
    const k = p.length / (Y_TIP + 0.5);
    const kt = (p.length / 250) ** 0.6;
    const T = HEAD_T * kt;
    const h = T / 2;
    const curved = p.jaws === 'curved';
    const sag = curved ? 7 : 0;
    const S = (v: number): number => v * k;
    const X = (v: number): number => v * kt;
    const pt = (x: number, y: number, r = 0): Pt => [X(x), S(y), X(r)];
    const mat = headMaterial(p.finish);

    // mating edge of the fixed jaw (x < 0), root contact at y = 158, tip at y = 213
    const arc = (sign: 1 | -1): Pt[] => {
      const out: Pt[] = [];
      for (let i = 0; i <= 18; i++) {
        const y = 158 + (55 * i) / 18;
        const u = (y - 185.5) / 27.5;
        out.push(pt(sign * (0.3 + sag * (1 - u * u)), y));
      }
      return out;
    };
    const fixedArc = arc(-1);
    const movableArc = arc(1);

    const fixedPlate: Pt[] = [
      pt(-20.5, 110),
      pt(-20.5, 126),
      pt(-24.5, 150, 8),
      pt(-26, 172, 14),
      pt(-22.5, 192, 12),
      pt(-13, 207, 10),
      pt(-3, 214.5, 3),
      ...fixedArc.slice().reverse(),
      pt(-0.3, 148),
      pt(-1.8, 138),
      pt(-2.2, 126),
      pt(-2.2, 110),
    ];
    const movablePlate: Pt[] = [
      pt(2.2, 138),
      pt(1.6, 142),
      pt(0.3, 148),
      ...movableArc,
      pt(3, 214.5, 3),
      pt(13, 207, 10),
      pt(22.5, 192, 12),
      pt(26, 172, 14),
      pt(24.5, 150, 8),
      pt(21.5, 138),
    ];
    const tailPlate: Pt[] = [pt(3.4, 140), pt(3.4, 119, 2), pt(19.6, 119, 2), pt(19.6, 140)];
    const steps = ctx.seg(5, 3);
    const zT = h;
    const body: Mesh[] = [plateMesh(fixedPlate, -zT, zT, { back: 0.9, front: 0.9 }, steps)];
    const jawM: Mesh[] = [
      plateMesh(movablePlate, -zT, zT, { back: 0.9, front: 0.9 }, steps),
      plateMesh(tailPlate, -2 * kt, 2 * kt, { back: 0.4, front: 0.4 }, steps),
    ];

    const faces: { f: Mesh[]; m: Mesh[] } = { f: [], m: [] };
    if (ctx.detail) {
      const zs = h - 1.2;
      const pathOf = (a: Pt[]): V2[] => a.map((q) => [q[0], q[1]]);
      faces.f.push(extrude(toothedEdge(pathOf(fixedArc), 1.8, 0.55, -1, 0.7), -zs, zs));
      faces.m.push(extrude(toothedEdge(pathOf(movableArc), 1.8, 0.55, 1, 0.7), -zs, zs));
    }

    // handles: fixed (left) from the butt up to the head, lever (right) shorter
    const hw = 11 * kt;
    const hz = (15 / 2) * kt;
    const hf = buildHandle(
      {
        ctrl: [
          [X(-11), S(15)],
          [X(-11.5), S(60)],
          [X(-11.5), S(100)],
          [X(-11.3), S(121)],
        ],
        hw,
        hz,
        style: p.handle,
        grooves: 3,
        lip: 1.2,
      },
      ctx,
    );
    const hl = buildHandle(
      {
        ctrl: [
          [X(11), S(26)],
          [X(11.5), S(60)],
          [X(11.5), S(100)],
          [X(11.3), S(121)],
        ],
        hw,
        hz,
        style: p.handle,
        grooves: 3,
        lip: 1.2,
      },
      ctx,
    );

    // lever steel (inside the sleeve and up to the pivot) and release tab
    const leverSteel = extrude(
      [
        [X(4), S(108)],
        [X(19), S(108)],
        [X(19.2), S(131)],
        [X(4.4), S(131)],
      ],
      -3.6 * kt,
      3.6 * kt,
      { bevel: 0.6 },
    );
    const release = plateMesh(
      [
        pt(19, 112, 1),
        pt(30, 118, 2),
        pt(31.5, 142, 2.5),
        pt(26, 143, 1.5),
        pt(25, 126, 1),
        pt(19, 124),
      ],
      -3 * kt,
      3 * kt,
      { back: 0.6, front: 0.6 },
      steps,
    );

    // adjusting screw knob at the butt of the fixed handle
    const knobR = 8.4 * kt;
    const knobFlutes = 16;
    const knobY0 = 0;
    const knobY1 = S(13.5);
    const ringAt = (r: number): V2[] =>
      flutedRing(r, knobFlutes, ctx.detail ? 0.7 : 0.01, knobFlutes * 6);
    const knob = place(
      loft([
        { y: knobY0, ring: ringAt(knobR * 0.8) },
        { y: knobY0 + 1.2, ring: ringAt(knobR) },
        { y: knobY1 - 1.8, ring: ringAt(knobR) },
        { y: knobY1, ring: ringAt(knobR * 0.78) },
      ]),
      at(X(-11), 0, 0),
    );
    const rod = place(
      loft([
        { y: knobY1 - 0.5, ring: circleRing(3.1 * kt, 16) },
        { y: S(19), ring: circleRing(3.1 * kt, 16) },
      ]),
      at(X(-11), 0, 0),
    );

    // pivots: P1 movable jaw (head), P2 lever top
    const P1: V2 = [X(13), S(146)];
    const P2: V2 = [X(11.5), S(125)];
    const alpha = p.jawOpen;
    const beta = p.jawOpen * 1.2;
    const jawPose = (m: Mesh): Mesh => swing(m, P1[0], P1[1], -alpha);
    // the lever turns about P2, which itself rides on the jaw arm
    const leverPose = (m: Mesh): Mesh => jawPose(swing(m, P2[0], P2[1], beta));

    const parts: Part[] = [];
    parts.push({ name: 'body', role: 'jaw', material: mat, mesh: mergeMeshes(body), crease: 40 });
    parts.push({
      name: 'jaw-movable',
      role: 'jaw',
      material: mat,
      mesh: jawPose(mergeMeshes(jawM)),
      crease: 40,
    });
    if (faces.f.length) {
      parts.push({
        name: 'teeth-fixed',
        role: 'jaw-face',
        material: METALS.steel,
        mesh: mergeMeshes(faces.f),
        crease: 20,
      });
      parts.push({
        name: 'teeth-movable',
        role: 'jaw-face',
        material: METALS.steel,
        mesh: jawPose(mergeMeshes(faces.m)),
        crease: 20,
      });
    }
    const mats = crossingMaterials(p.finish, p.handleColor, p.gripColor, p.handle === 'comfort');
    const sleeveMat = mats.sleeve;
    const insertMat = mats.insert;
    const addHandle = (name: string, hd: typeof hf, pose: (m: Mesh) => Mesh): void => {
      if (hd.sleeve)
        parts.push({
          name,
          role: 'handle',
          material: sleeveMat,
          mesh: pose(hd.sleeve),
          crease: 60,
        });
      if (hd.bare)
        parts.push({ name, role: 'handle', material: mat, mesh: pose(hd.bare), crease: 40 });
      if (hd.inserts.length)
        parts.push({
          name: `${name}-grip`,
          role: 'grip',
          material: insertMat,
          mesh: pose(mergeMeshes(hd.inserts)),
          crease: 60,
        });
    };
    addHandle('handle-fixed', hf, (m) => m);
    addHandle('handle-lever', hl, leverPose);
    parts.push({
      name: 'lever-steel',
      role: 'lever',
      material: mat,
      mesh: leverPose(leverSteel),
      crease: 40,
    });
    parts.push({
      name: 'release-lever',
      role: 'lever',
      material: METALS.steel,
      mesh: leverPose(release),
      crease: 40,
    });
    parts.push({
      name: 'adjust-knob',
      role: 'screw',
      material: METALS.blackOxide,
      mesh: knob,
      crease: 35,
    });
    parts.push({ name: 'adjust-screw', role: 'screw', material: METALS.zinc, mesh: rod });
    const rv = (c: V2, r: number): Mesh =>
      place(rivetMesh(r, T, ctx.seg(18, 10)), at(c[0], c[1], 0));
    parts.push({
      name: 'pivot',
      role: 'pivot',
      material: METALS.steel,
      mesh: rv(P1, 4.2 * kt),
      crease: 30,
    });
    parts.push({
      name: 'lever-pivot',
      role: 'pivot',
      material: METALS.steel,
      mesh: leverPose(rv(P2, 3.4 * kt)),
      crease: 30,
    });

    const { width, thickness } = poseDims(parts);
    const mouth = 2 * sag * k;
    return {
      parts,
      hang: { point: [0, S(150), 0], kind: 'head' },
      zones: [
        { name: 'knob', y0: 0, y1: S(15) },
        { name: 'handle', y0: S(15), y1: S(121) },
        { name: 'head', y0: S(121), y1: S(158) },
        { name: 'jaws', y0: S(158), y1: S(Y_TIP + 1) },
      ],
      dims: {
        length: S(Y_TIP + 0.5),
        width,
        thickness,
        handleLength: S(106),
        handleWidth: 2 * hw,
        headWidth: X(52),
        jawLength: S(56),
        jawOpening: tipGap(S(Y_TIP - 146), p.jawOpen, 0.6) + mouth,
      },
    };
  },
});
