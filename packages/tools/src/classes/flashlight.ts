/**
 * Flashlight / torch. Axis +Y: tail cap with the switch boot at y = 0, knurled body tube, flared head
 * with the lens end at y = length. Parts: tail-cap, switch, body (flutes / grooves), o-rings, head,
 * reflector (parabolic cup), led, lens, optional pocket clip. Sizes: AAA pocket 14 x 88, AA 21 x 135,
 * 18650 tactical 25 x 140, 4D Maglite 41 (head 54) x 304, 2D LED 34 x 210 mm.
 */
import { clamp, smoothstep, type V2 } from '../math.ts';
import { type Station, loft, lathe, place, at, torus } from '../build/primitives.ts';
import { circleRing, flutedRing } from '../build/rings.ts';
import type { Mesh } from '../mesh.ts';
import { GLASS, METALS, plastic, rubber, translucentPlastic } from '../materials.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { merge, part, revolveLoop, revolveZ, slab } from './power-kit.ts';

const schema = {
  bodyDiameter: num(L('Body diameter', 'Диаметр корпуса'), 25.4, 12, 45, { step: 0.2 }),
  length: num(L('Overall length', 'Общая длина'), 140, 70, 320, { step: 1 }),
  headDiameter: num(L('Head diameter', 'Диаметр головы'), 37, 14, 60, { step: 0.5 }),
  headLength: num(L('Head length', 'Длина головы'), 36, 14, 60, { step: 0.5 }),
  knurl: choice(
    L('Body texture', 'Накатка корпуса'),
    ['flutes', 'rings', 'smooth'] as const,
    'flutes',
  ),
  switchType: choice(L('Switch', 'Кнопка'), ['tail', 'side'] as const, 'tail'),
  clip: choice(L('Pocket clip', 'Клипса'), ['none', 'clip'] as const, 'clip'),
  bodyColor: color(L('Body colour', 'Цвет корпуса'), '#26272a'),
  accentColor: color(L('Switch colour', 'Цвет кнопки'), '#c8262b'),
};

export const flashlight = defineToolClass({
  id: 'flashlight',
  family: 'power',
  name: L('Flashlight', 'Фонарь'),
  bankClass: 'multimeter',
  keywords: {
    en: ['flashlight', 'torch', 'led flashlight', 'maglite', 'headlamp'],
    ru: ['фонарь', 'фонарик', 'светодиодный фонарь'],
  },
  schema,
  presets: [
    { id: '18650-tactical', label: L('18650 tactical 25 x 140', 'Тактический 18650'), values: {} },
    {
      id: 'pocket-aaa',
      label: L('Pocket AAA 14 x 88', 'Карманный AAA'),
      values: {
        bodyDiameter: 14,
        length: 88,
        headDiameter: 17,
        headLength: 20,
        knurl: 'rings',
        bodyColor: '#7a7f86',
        accentColor: '#1b1c1e',
      },
    },
    {
      id: 'edc-aa',
      label: L('EDC AA 21 x 135', 'Ручной AA'),
      values: {
        bodyDiameter: 21,
        length: 135,
        headDiameter: 27,
        headLength: 30,
        knurl: 'rings',
        bodyColor: '#c4c7cc',
        accentColor: '#1b1c1e',
        clip: 'none',
      },
    },
    {
      id: 'maglite-4d',
      label: L('4D Maglite 41 x 304', 'Maglite 4D'),
      values: {
        bodyDiameter: 41,
        length: 304,
        headDiameter: 54,
        headLength: 52,
        knurl: 'rings',
        switchType: 'side',
        clip: 'none',
        bodyColor: '#1b1c1e',
        accentColor: '#1b1c1e',
      },
    },
    {
      id: 'orange-2d',
      label: L('Orange 2D 34 x 210', 'Оранжевый 2D'),
      values: {
        bodyDiameter: 34,
        length: 210,
        headDiameter: 46,
        headLength: 44,
        knurl: 'flutes',
        switchType: 'side',
        clip: 'none',
        bodyColor: '#e8741e',
        accentColor: '#1b1c1e',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const Lt = p.length;
    const rB = p.bodyDiameter / 2;
    const rH = Math.max(p.headDiameter / 2, rB * 1.02);
    const hl = Math.min(p.headLength, Lt * 0.4);
    const tailL = clamp(p.bodyDiameter * 0.55, 8, 20);
    const yH0 = Lt - hl;
    const N = ctx.seg(96, 40);
    const parts: Part[] = [];
    const bodyMat = {
      ...METALS.aluminium,
      name: 'anodised aluminium',
      color: p.bodyColor,
      roughness: 0.46,
      metallic: 0.8,
    };

    // tail cap and switch boot
    const rTail = rB * 1.02;
    parts.push(
      part(
        'tail-cap',
        'body',
        bodyMat,
        lathe(
          [
            [0, 1.5],
            [rTail * 0.72, 1.5],
            [rTail * 0.9, 2.6],
            [rTail, 4.6],
            [rTail, tailL],
            [rB, tailL + 0.6],
          ],
          N,
        ),
        40,
      ),
    );
    if (p.switchType === 'tail') {
      const rS = rB * 0.36;
      parts.push(
        part(
          'switch',
          'control',
          translucentPlastic(p.accentColor, 0.9, 'switch boot'),
          lathe(
            [
              [0, 0],
              [rS * 0.7, 0.15],
              [rS * 0.97, 0.9],
              [rS, 2.2],
              [rS, 5],
            ],
            ctx.seg(40, 20),
          ),
        ),
      );
    }

    // body tube with grip texture
    const yb0 = tailL;
    const yb1 = yH0;
    const stations: Station[] = [];
    const flutes = 30;
    const grip0 = yb0 + (yb1 - yb0) * 0.1;
    const grip1 = yb1 - (yb1 - yb0) * 0.1;
    if (p.knurl === 'rings' && ctx.detail) {
      // square-ish grooves every 2.6 mm across the grip zone
      stations.push({ y: yb0, ring: circleRing(rB, N) });
      for (let y = grip0; y + 3.2 <= grip1; y += 3.2) {
        for (const [dy, d] of [
          [0, 0],
          [0.25, 0.55],
          [1.45, 0.55],
          [1.7, 0],
        ] as const) {
          stations.push({ y: y + dy, ring: circleRing(rB - d, N) });
        }
      }
      stations.push({ y: yb1, ring: circleRing(rB, N) });
    } else {
      const nSt = ctx.seg(Math.max(24, Math.round((yb1 - yb0) / 3)), 4);
      for (let i = 0; i <= nSt; i++) {
        const y = yb0 + ((yb1 - yb0) * i) / nSt;
        const g = smoothstep(grip0, grip0 + 4, y) * (1 - smoothstep(grip1 - 4, grip1, y));
        const detailed = p.knurl === 'flutes' && ctx.detail;
        stations.push({
          y,
          ring: detailed ? flutedRing(rB, flutes, 0.55 * g, flutes * 4) : circleRing(rB, N),
        });
      }
    }
    parts.push(part('body', 'handle', bodyMat, loft(stations), 40));

    // o-rings at the joints
    const oring = (y: number): Mesh =>
      place(torus(rB * 1.0, 0.8, ctx.seg(48, 20), ctx.seg(8, 5)), at(0, y, 0));
    parts.push(
      part(
        'o-rings',
        'seal',
        rubber('#111113', 'smooth', 'o-ring'),
        merge(oring(yb0 + 0.6), oring(yb1 - 0.4)),
      ),
    );

    // head: neck flare, finned barrel (ring fins at LOD0), bezel, recessed lens
    const rLens = rH * 0.86;
    const depth = clamp(hl * 0.55, 8, 28);
    const yF = Lt;
    const prof: V2[] = [[0, yH0]];
    prof.push([rB, yH0], [rB * 1.02, yH0 + hl * 0.06]);
    const neck = yH0 + hl * 0.38;
    prof.push([rB * 1.04 + (rH - rB) * 0.25, yH0 + hl * 0.2], [rH * 0.96, neck]);
    if (ctx.detail) {
      const fins = Math.floor((0.46 * hl - 3.7) / 3.4) + 1;
      for (let i = 0; i < fins; i++) {
        const y = neck + 1.4 + i * 3.4;
        prof.push([rH * 0.96, y], [rH, y + 0.5], [rH, y + 1.8], [rH * 0.96, y + 2.3]);
      }
    }
    prof.push([rH, yF - hl * 0.16], [rH * 1.0, yF - 1.2], [rH * 0.95, yF]);
    prof.push([rLens * 1.03, yF], [rLens, yF - 1.4], [rLens, yF - depth], [0, yF - depth]);
    parts.push(part('head', 'head', bodyMat, lathe(prof, N), 35));

    // reflector shell (parabolic dish) sitting on the floor of the recess
    const M = ctx.seg(10, 5);
    const yFloor = yF - depth;
    const dep = depth - 3.2;
    const rr = rLens * 0.97;
    const refl: V2[] = [];
    for (let i = 0; i <= M; i++) {
      const r = (rr * i) / M;
      refl.push([r, yFloor + 0.9 + dep * (r / rr) ** 2]);
    }
    const rim = refl[refl.length - 1] as V2;
    const shell: V2[] = [...refl, [rim[0], rim[1] - 0.5]];
    for (let i = M - 1; i >= 0; i--) {
      const q = refl[i] as V2;
      shell.push([q[0], q[1] - 0.5]);
    }
    parts.push(
      part(
        'reflector',
        'optic',
        { ...METALS.polishedSteel, name: 'reflector', roughness: 0.1 },
        lathe(shell, ctx.seg(64, 28)),
      ),
    );
    parts.push(
      part(
        'led',
        'optic',
        plastic('#fff4cf', 0.3, 'led emitter'),
        lathe(
          [
            [rr * 0.16, yFloor + 0.9],
            [rr * 0.16, yFloor + 2.2],
          ],
          ctx.seg(24, 10),
        ),
      ),
    );
    parts.push(
      part(
        'lens',
        'optic',
        { ...GLASS, name: 'lens', color: '#7d97a3', alpha: 0.4 },
        lathe(
          [
            [rLens * 0.995, yF - 2.4],
            [rLens * 0.995, yF - 1.4],
          ],
          N,
        ),
      ),
    );

    // side switch (maglite style): rubber pad on the body just below the head, facing the viewer (+Z)
    if (p.switchType === 'side') {
      const ys = yH0 - clamp(Lt * 0.06, 8, 16);
      const rs = clamp(rB * 0.3, 3, 7);
      parts.push(
        part(
          'switch',
          'control',
          rubber(p.accentColor, 'smooth', 'switch boot'),
          revolveZ(
            [
              [0, rB + 1.8],
              [rs * 0.7, rB + 1.8],
              [rs, rB + 1.1],
              [rs, rB - 0.8],
              [0, rB - 0.8],
            ],
            0,
            ys,
            ctx.seg(20, 10),
          ),
        ),
      );
    }

    // pocket clip along -X
    if (p.clip === 'clip') {
      const y0 = tailL + 7;
      const y1 = Math.min(yH0 - 4, tailL + Lt * 0.4);
      const w = clamp(rB * 0.45, 2.4, 6);
      const gap = 1.2;
      const t = 0.9;
      const xo = -(rB + gap);
      const strip = slab(
        [
          [xo + 0.3, y0 - 3],
          [xo - t, y0 - 3],
          [xo - t, y1],
          [xo + 1.8, y1 - 2],
          [xo + 1.8, y1 - 2 - t],
          [xo + 0.3, y1 - 3.6],
        ],
        -w / 2,
        w / 2,
      );
      const band = revolveLoop(
        [
          [rB * 0.98, y0 - 3],
          [rB + 1.2, y0 - 3],
          [rB + 1.2, y0 + 3],
          [rB * 0.98, y0 + 3],
        ],
        ctx.seg(48, 20),
      );
      parts.push(part('clip', 'clip', METALS.steel, merge(strip, band), 30));
    }

    return {
      parts,
      hang: { point: [0, yH0, 0], kind: 'neck' },
      zones: [
        { name: 'tail', y0: 0, y1: tailL },
        { name: 'body', y0: tailL, y1: yH0 },
        { name: 'head', y0: yH0, y1: Lt },
      ],
      dims: {
        length: Lt,
        bodyDiameter: p.bodyDiameter,
        headDiameter: rH * 2,
        headLength: hl,
        lensDiameter: rLens * 2,
      },
    };
  },
});
