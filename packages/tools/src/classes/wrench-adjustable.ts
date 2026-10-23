/**
 * Adjustable wrench (Crescent type): flat forged handle with a hang hole, angled head with a fixed jaw,
 * a sliding jaw plate, a knurled worm thumb wheel and a millimetre scale. Lengths 150 / 200 / 250 / 300 mm
 * (ISO 6787 / DIN 3117) with jaw capacities of about L / 8 (20, 24, 30, 36). The handle can be bare steel,
 * dip-coated (like the blue wrench on the HSW wall photo) or fitted with a ribbed rubber grip.
 * Proportions are fractions of the length, tuned against 8 in / 200 mm trade wrenches: head thickness
 * 11 mm, handle 16..20 mm wide and about 7 mm thick, jaw face 32 mm.
 *
 * Checked against the blue wrench of the HSW wall photo (head about a third of the length, jaw opening about
 * 10 % of it, handle about 11 % wide with the dip coat): at 200 mm the head is 47.6 mm wide against a 19.6 mm
 * handle bar (2.4x; 2.2x over the dip coat) and the handle is 9.8 % wide (10.7 % with the coat).
 */
import { DEG, type V2, smoothstep } from '../math.ts';
import { type Mesh, mergeMeshes } from '../mesh.ts';
import { METALS } from '../materials.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import type { BuiltTool, Part } from '../model.ts';
import { box, extrude, lathe, place, at, rotZ } from '../build/primitives.ts';
import {
  type BarSection,
  FINISHES,
  arcPoints,
  barLoft,
  bezierPoints,
  finishMaterial,
  gripMaterial,
  handleOutline,
  plate,
  sleeve,
  stationYs,
} from './wrench-shared.ts';

const TILT = 15;

const schema = {
  length: num(L('Length at full opening', 'Длина при раскрытых губках'), 200, 100, 380, {
    step: 5,
  }),
  jawOpening: num(
    L('Jaw opening (max 12 % of length)', 'Раскрытие губок (до 12 % длины)'),
    20,
    0,
    40,
    { step: 0.5 },
  ),
  finish: choice(L('Finish', 'Покрытие'), FINISHES, 'satin'),
  grip: choice(L('Handle', 'Рукоять'), ['bare', 'dipped', 'rubber'] as const, 'dipped'),
  gripColor: color(L('Grip colour', 'Цвет рукояти'), '#2455a8'),
  scale: choice(L('Jaw scale', 'Шкала на губке'), ['marked', 'plain'] as const, 'marked'),
};

export const wrenchAdjustable = defineToolClass({
  id: 'wrench-adjustable',
  family: 'wrenches',
  name: L('Adjustable wrench', 'Разводной ключ'),
  bankClass: 'wrench',
  keywords: {
    en: ['adjustable wrench', 'adjustable spanner', 'crescent wrench', 'monkey wrench'],
    ru: ['разводной ключ', 'ключ разводной', 'гаечный ключ'],
  },
  schema,
  presets: [
    {
      id: '150-bare',
      label: L('150 mm, bare steel', '150 мм, стальной'),
      values: { length: 150, jawOpening: 17, grip: 'bare', finish: 'chrome' },
    },
    {
      id: '200-blue-dipped',
      label: L('200 mm, blue dipped handle', '200 мм, синяя обмакнутая рукоять'),
      values: { length: 200, jawOpening: 22, grip: 'dipped', gripColor: '#2455a8' },
    },
    {
      id: '250-red-rubber',
      label: L('250 mm, red rubber grip', '250 мм, красная резиновая рукоять'),
      values: {
        length: 250,
        jawOpening: 18,
        grip: 'rubber',
        gripColor: '#c8262b',
        finish: 'chrome',
      },
    },
    {
      id: '300-black-rubber',
      label: L('300 mm, black rubber grip', '300 мм, чёрная резиновая рукоять'),
      values: {
        length: 300,
        jawOpening: 30,
        grip: 'rubber',
        gripColor: '#1b1c1e',
        finish: 'black-oxide',
      },
    },
    {
      id: '200-closed',
      label: L('200 mm, jaws closed', '200 мм, губки сведены'),
      values: { length: 200, jawOpening: 0, grip: 'dipped', gripColor: '#e8741e' },
    },
  ],
  build(p, ctx): BuiltTool {
    const Lt = p.length;
    const k = Lt / 200;
    const cap = 0.12 * Lt;
    const g = Math.min(Math.max(p.jawOpening, 0.6), cap);
    const jtBase = 0.052 * Lt;
    const jtTip = 0.04 * Lt;
    const mt = 0.042 * Lt;
    const mtBase = 0.055 * Lt;
    const jl = 0.125 * Lt;
    const hb = 0.115 * Lt;
    const xr = cap + mt + 0.024 * Lt;
    const Th = 0.055 * Lt;
    const tb = 0.034 * Lt;
    const wButt = 0.082 * Lt;
    const wTop = 0.098 * Lt;
    const holeR = 0.022 * Lt;
    const holeY = 0.068 * Lt;
    const xn = (xr - jtBase) / 2 - 0.04 * xr;
    const neckExtra = 0.03 * Lt;
    const steps = ctx.seg(8, 4);
    const material = finishMaterial(p.finish);
    const tilt = TILT * DEG;
    const [c, s] = [Math.cos(tilt), Math.sin(tilt)];

    // Head local frame: x across the jaws (fixed jaw face at x = 0, sliding jaw at +x), y along the jaws.
    // `world` rotates it by the head angle about the neck point and puts that point at (0, yNeck).
    const fixedTop = (-jtTip / 2 - xn) * s + (jl + hb) * c;
    const slideTop = (gap: number): number => (gap + mt / 2 - xn) * s + (0.96 * jl + hb) * c;
    // The head sits where it would with the jaws fully open, so the opening only moves the sliding jaw.
    const yNeck = Lt - Math.max(fixedTop, slideTop(cap));
    const world = ([x, y]: V2): V2 => [
      (x - xn) * c - (y + hb) * s,
      yNeck + (x - xn) * s + (y + hb) * c,
    ];

    const bezierSteps = ctx.seg(10, 5);
    const yb0 = -hb - neckExtra;
    const rc = 0.03 * Lt;
    const body: V2[] = [
      ...bezierPoints(
        [xn + wTop / 2, yb0],
        [xn + wTop / 2, -0.85 * hb],
        [xr, -0.9 * hb],
        [xr, -0.45 * hb],
        bezierSteps,
      ),
      ...arcPoints(xr - rc, -rc, rc, 0, 90, steps),
      [0, 0],
      ...arcPoints(-jtTip / 2, jl - jtTip / 2, jtTip / 2, 0, 180, steps * 2),
      ...bezierPoints(
        [-jtBase, -0.25 * hb],
        [-jtBase, -0.8 * hb],
        [xn - wTop / 2, -0.8 * hb],
        [xn - wTop / 2, yb0],
        bezierSteps,
      ),
    ];
    // Window in the head that exposes the worm screw.
    const winW = 0.078 * Lt;
    const winH = 0.058 * Lt;
    const winX = xr - 0.03 * Lt - winW / 2;
    const winY = -0.17 * hb - winH / 2;
    const winR = 0.012 * Lt;
    const windowRing: V2[] = [
      ...arcPoints(winX + winW / 2 - winR, winY + winH / 2 - winR, winR, 0, 90, steps),
      ...arcPoints(winX - winW / 2 + winR, winY + winH / 2 - winR, winR, 90, 180, steps),
      ...arcPoints(winX - winW / 2 + winR, winY - winH / 2 + winR, winR, 180, 270, steps),
      ...arcPoints(winX + winW / 2 - winR, winY - winH / 2 + winR, winR, 270, 360, steps),
    ];
    const headMesh = plate(body.map(world), 0, Th, Math.min(1.3, 0.12 * Th), [
      windowRing.map(world),
    ]);

    const slideTipR = mt / 2;
    const slide: V2[] = [
      [g, -0.14 * hb],
      [g + mtBase, -0.14 * hb],
      [g + mtBase, 0.12 * jl],
      [g + mt, 0.5 * jl],
      ...arcPoints(g + mt / 2, 0.96 * jl - slideTipR, slideTipR, 0, 180, steps * 2),
    ];
    const slideThick = Th - 1.2;
    const slideMesh = plate(slide.map(world), 0, slideThick, Math.min(1, 0.1 * Th));

    // Worm screw (axis along the jaw faces) lying in the window: ridged cylinder with end journals.
    const rw = Math.min(winH / 2 - 0.6, Th / 2 - 0.8);
    const wormLen = winW * 0.9;
    const ridges = ctx.seg(6, 3);
    const pitch = (wormLen - 2) / ridges;
    const wormProfile: V2[] = [[rw * 0.55, -wormLen / 2]];
    for (let i = 0; i < ridges; i++) {
      const y = -wormLen / 2 + 1 + i * pitch;
      wormProfile.push(
        [rw * 0.6, y],
        [rw, y + 0.14 * pitch],
        [rw, y + 0.6 * pitch],
        [rw * 0.6, y + 0.78 * pitch],
      );
    }
    wormProfile.push([rw * 0.6, wormLen / 2 - 0.5], [rw * 0.55, wormLen / 2]);
    const [wx, wy] = world([winX, winY]);
    const worm = place(lathe(wormProfile, ctx.seg(28, 12)), rotZ(TILT - 90), at(wx, wy, 0));

    const parts: Part[] = [];
    // Handle core: forged flat bar with the hang hole, plus a short thick-to-thin shoulder into the head.
    const yH1 = yNeck - 0.075 * Lt;
    const blank = handleOutline({
      y0: 0,
      y1: yH1,
      wButt,
      wTop,
      buttRound: 0.03 * Lt,
      hole: { y: holeY, r: holeR },
      steps,
    });
    const handleCore = extrude(blank.outer, -tb / 2, tb / 2, {
      bevel: Math.min(1.2, 0.2 * tb),
      holes: [blank.hole],
    });
    const neckEnd = yNeck + 0.02 * Lt;
    const neckYs = stationYs(yH1 - 0.5, neckEnd, ctx.seg(6, 3), []);
    const neckSections: BarSection[] = neckYs.map((y) => ({
      y,
      width: wTop,
      thick: tb + (Th - tb) * smoothstep(yH1, yNeck - 0.05 * Lt, y),
      z: 0,
    }));
    const neck = barLoft(neckSections, ctx.seg(4, 2));
    parts.push({
      name: 'handle',
      role: 'handle',
      material,
      mesh: mergeMeshes([handleCore, neck]),
      crease: 35,
    });
    parts.push({ name: 'head', role: 'head', material, mesh: headMesh, crease: 35 });
    parts.push({
      name: 'jaw-sliding',
      role: 'head',
      material,
      mesh: slideMesh,
      crease: 35,
    });
    parts.push({
      name: 'worm',
      role: 'adjuster',
      material: p.finish === 'black-oxide' ? METALS.blackOxide : METALS.darkSteel,
      mesh: worm,
      crease: 45,
    });

    if (p.scale === 'marked' && ctx.detail) {
      const ticks: Mesh[] = [];
      const tickStep = 0.025 * Lt;
      const top = slideThick / 2;
      for (let i = 0, y = 0.12 * jl; y < 0.9 * jl; i++, y += tickStep) {
        const long = i % 2 === 0;
        const w = long ? mt * 0.55 : mt * 0.32;
        const [x, yy] = world([g + mt * 0.2 + w / 2, y]);
        ticks.push(place(box(w, 0.35 * k + 0.2, 0.6), rotZ(TILT), at(x, yy, top - 0.15)));
      }
      parts.push({
        name: 'scale',
        role: 'label',
        material: METALS.blackOxide,
        mesh: mergeMeshes(ticks),
      });
    }

    const overCoat = p.grip === 'rubber' ? 2.1 : 0.9;
    const gripY0 = p.grip === 'rubber' ? 0.12 * Lt : 0.16 * Lt;
    const gripY1 = yH1 - 0.012 * Lt;
    if (p.grip !== 'bare') {
      const grooves: number[] = [];
      if (p.grip === 'rubber' && ctx.detail) {
        for (let y = gripY0 + 0.06 * Lt; y < gripY1 - 0.04 * Lt; y += 0.045 * Lt) grooves.push(y);
      }
      parts.push({
        name: 'grip',
        role: 'grip',
        material: gripMaterial(p.grip, p.gripColor),
        mesh: sleeve({
          y0: gripY0,
          y1: gripY1,
          width: (y) => wButt + ((wTop - wButt) * y) / yH1,
          thick: () => tb,
          over: overCoat,
          count: ctx.seg(10, 4),
          grooves,
          grooveDepth: 0.9,
          bulge: p.grip === 'rubber' ? 0.05 : 0,
          perCorner: ctx.seg(4, 2),
        }),
      });
    }

    const overall = yNeck + Math.max(fixedTop, slideTop(g));
    const headWidth = xr + jtBase;
    return {
      parts,
      hang: { point: [0, holeY, 0], kind: 'hole', diameterMm: 2 * holeR },
      zones: [
        { name: 'handle', y0: 0, y1: yNeck - 0.02 * Lt },
        { name: 'head', y0: yNeck - 0.02 * Lt, y1: overall },
      ],
      dims: {
        length: overall,
        width: headWidth * c + (jl + hb) * s,
        thickness: Math.max(
          Th,
          (tb + (p.grip === 'bare' ? 0 : 2 * overCoat)) * (p.grip === 'rubber' ? 1.05 : 1),
        ),
        headWidth,
        headThickness: Th,
        handleWidth: wTop,
        handleThickness:
          (tb + (p.grip === 'bare' ? 0 : 2 * overCoat)) * (p.grip === 'rubber' ? 1.05 : 1),
        jawOpening: g,
        jawCapacity: cap,
      },
    };
  },
});
