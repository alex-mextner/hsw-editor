/**
 * G / C-clamp: cast I-section frame (rim + web), threaded screw with swivel pad, T-bar or wing handle.
 * Frames use the rim + web construction: a thick rim ring (outline with the inset outline cut out) over a
 * thin web plate. Sizes 50..250 mm opening (DIN 5117 malleable cast G-clamps: 100 mm = 100 x 60 reach).
 */
import { at, extrude, lathe, loft, place, rotZ } from '../../build/primitives.ts';
import { circleRing } from '../../build/rings.ts';
import { METALS, paint } from '../../materials.ts';
import type { Part } from '../../model.ts';
import { L, choice, color, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { type Mesh, mergeMeshes } from '../../mesh.ts';
import { iFrame, threadedRod } from './clamp-kit.ts';
import { poseDims } from './crossing.ts';
import { type Pt, roundedOutline } from './kit.ts';

const cSchema = {
  opening: num(L('Maximum opening', 'Раскрытие'), 100, 40, 250, { step: 5, dimension: true }),
  jawGap: num(L('Current jaw gap', 'Текущий зазор'), 55, 0, 250, { step: 1 }),
  throat: num(L('Throat depth', 'Вылет'), 60, 30, 140, { step: 1 }),
  frameWidth: num(L('Frame thickness (z)', 'Толщина рамы'), 20, 12, 40, { step: 1 }),
  frameColor: color(L('Frame colour', 'Цвет рамы'), '#2455a8'),
  handleStyle: choice(L('Screw handle', 'Ручка винта'), ['t-bar', 'wing'] as const, 't-bar'),
};

export const cClamp = defineToolClass({
  id: 'c-clamp',
  family: 'pliers',
  name: L('C-clamp (G-clamp)', 'Струбцина G-образная'),
  bankClass: 'clamp',
  keywords: {
    en: ['c-clamp', 'g-clamp', 'screw clamp', 'g clamp', 'c clamp'],
    ru: ['струбцина', 'g-образная струбцина', 'винтовая струбцина'],
  },
  schema: cSchema,
  presets: [
    { id: 'cc-100', label: L('100 mm (4 in), blue', '100 мм, синяя'), values: {} },
    {
      id: 'cc-50',
      label: L('50 mm (2 in), black', '50 мм, чёрная'),
      values: {
        opening: 50,
        jawGap: 22,
        throat: 34,
        frameWidth: 14,
        frameColor: '#26272a',
        handleStyle: 'wing',
      },
    },
    {
      id: 'cc-150',
      label: L('150 mm (6 in), red', '150 мм, красная'),
      values: { opening: 150, jawGap: 90, throat: 80, frameWidth: 26, frameColor: '#c8262b' },
    },
    {
      id: 'cc-200',
      label: L('200 mm (8 in), silver', '200 мм, серая'),
      values: { opening: 200, jawGap: 40, throat: 100, frameWidth: 32, frameColor: '#9da1a7' },
    },
  ],
  build(p, ctx) {
    const O = p.opening;
    const gap = Math.min(p.jawGap, O);
    const sd = 9 + O * 0.06; // screw diameter, 12 at 50, 15 at 100, 24 at 250
    const sr = sd / 2;
    const boss = sd + 9;
    const armH = 12 + O * 0.07;
    const spine = 12 + O * 0.09;
    const handleLen = 42 + O * 0.55;
    const padR = sr * 1.5;
    const zH = p.frameWidth / 2;
    const seg = ctx.seg(28, 14);
    const steps = ctx.seg(5, 3);
    // y layout: handle bar at y = 4, rod up to the swivel pad; frame placed from the anvil
    const rodLen = O + armH + (p.handleStyle === 'wing' ? 34 : 12); // the wing hub hangs 28 mm below the arm
    const yPadTop = 4 + rodLen;
    const yAnvil = yPadTop + gap + 6; // inner face of the top arm; the anvil disc hangs 6 mm below it
    const yB1 = yAnvil - 6 - O; // top of the bottom arm (inner)
    const yB0 = yB1 - armH;
    const yT1 = yAnvil + armH;
    const bx = boss / 2 + 2;
    const rim = Math.max(3.5, armH * 0.28);
    const cr = rim + 1.5; // arm-tip fillets must stay wider than the rim or its inset loop folds over
    const R = p.throat + bx;
    const outline: Pt[] = [
      [-bx, yB0, cr],
      [R + spine, yB0, spine * 0.9],
      [R + spine, yT1, spine * 0.9],
      [-bx, yT1, cr],
      [-bx, yAnvil, cr],
      [R, yAnvil, spine * 0.35],
      [R, yB1, spine * 0.35],
      [-bx, yB1, cr],
    ];
    const frameMat = paint(p.frameColor, 0.5, 'cast frame');
    const frameMeshes = iFrame(outline, zH, Math.max(2.2, zH * 0.22), rim, steps, ctx.detail);
    const bossMesh = place(
      lathe(
        [
          [boss / 2, yB0 - 1],
          [boss / 2, yB1 + 1],
        ],
        seg,
      ),
      at(0, 0, 0),
    );
    const anvil = place(
      lathe(
        [
          [padR * 1.05, yAnvil - 6],
          [padR * 1.05, yAnvil + 1],
        ],
        seg,
      ),
      at(0, 0, 0),
    );
    const parts: Part[] = [
      {
        name: 'frame',
        role: 'body',
        material: frameMat,
        mesh: mergeMeshes([...frameMeshes, bossMesh, anvil]),
        crease: 45,
      },
    ];
    parts.push({
      name: 'screw',
      role: 'screw',
      material: METALS.blackOxide,
      mesh: threadedRod(sr, 4, yPadTop - 6, 2.4 + O * 0.01, ctx.seg(20, 10), ctx.detail),
      crease: 40,
    });
    // swivel pad: ball joint + disc
    parts.push({
      name: 'swivel-pad',
      role: 'pad',
      material: METALS.zinc,
      mesh: lathe(
        [
          [sr * 0.9, yPadTop - 7],
          [padR * 0.9, yPadTop - 4.5],
          [padR, yPadTop - 3],
          [padR, yPadTop - 0.5],
          [padR * 0.82, yPadTop],
        ],
        seg,
      ),
      crease: 40,
    });
    // handle
    if (p.handleStyle === 't-bar') {
      const hr = 2.8 + O * 0.012;
      const bar = place(
        loft([
          { y: -handleLen / 2, ring: circleRing(hr * 1.5, ctx.seg(16, 8)) },
          { y: -handleLen / 2 + hr * 1.2, ring: circleRing(hr * 1.5, ctx.seg(16, 8)) },
          { y: -handleLen / 2 + hr * 1.8, ring: circleRing(hr, ctx.seg(16, 8)) },
          { y: handleLen / 2 - hr * 1.8, ring: circleRing(hr, ctx.seg(16, 8)) },
          { y: handleLen / 2 - hr * 1.2, ring: circleRing(hr * 1.5, ctx.seg(16, 8)) },
          { y: handleLen / 2, ring: circleRing(hr * 1.5, ctx.seg(16, 8)) },
        ]),
        rotZ(90),
        at(0, 4, 0),
      );
      parts.push({
        name: 'handle-bar',
        role: 'handle',
        material: METALS.blackOxide,
        mesh: bar,
        crease: 40,
      });
    } else {
      // wing / butterfly handle: cast ears on a hub
      const ear = (sgn: number): Mesh =>
        extrude(
          roundedOutline(
            [
              [sgn * 3, -9, 1],
              [sgn * (handleLen / 2), -2, 3],
              [sgn * (handleLen / 2), 14, 6],
              [sgn * (handleLen * 0.22), 12, 2],
              [sgn * 3, 9, 1],
            ],
            3,
          ).slice(),
          -2.6,
          2.6,
          { bevel: 0.6 },
        );
      const wing = mergeMeshes([
        place(ear(1), at(0, 14, 0)),
        place(ear(-1), at(0, 14, 0)),
        place(
          lathe(
            [
              [sr * 1.6, 0],
              [sr * 1.6, 26],
            ],
            seg,
          ),
          at(0, 0, 0),
        ),
      ]);
      parts.push({
        name: 'handle-wing',
        role: 'handle',
        material: frameMat,
        mesh: wing,
        crease: 40,
      });
    }
    const measured = poseDims(parts);
    return {
      parts,
      hang: { point: [R * 0.6, yT1 - armH / 2, 0], kind: 'body' },
      zones: [
        { name: 'handle', y0: 0, y1: yB0 },
        { name: 'frame', y0: yB0, y1: yT1 },
      ],
      dims: {
        length: yT1,
        ...measured,
        opening: O,
        throat: p.throat,
        screwDiameter: sd,
        handleLength: handleLen,
      },
    };
  },
});
