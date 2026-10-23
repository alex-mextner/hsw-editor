/**
 * Workshop consumables: aerosol spray can (base dome, body, label band + stripes, domed shoulder,
 * valve cup, overcap or actuator with spray tip and optional straw) and tape roll (open core ring, tape
 * ring with chamfered edges, loose tail). The spray can stands on y = 0 and the tape roll is a ring in the
 * XY plane (axis along Z, hole towards the viewer) with its centre at y = outer radius, so a peg through
 * the hole is the hang point. Sizes: aerosol 100 ml 35 x 120, 400 ml 52 x 195, WD-40-style 400 ml 60 x 200,
 * 520 ml 65 x 215; HSW measured tape rolls 120 / 76 / 50 and 50 / 25 / 15 mm (OD / core ID / width,
 * refit/design.json).
 */
import { clamp, type V2, type V3 } from '../math.ts';
import { extrude, lathe, place, rotX, at, tube, roundedPath } from '../build/primitives.ts';
import {
  type Material,
  METALS,
  WHITE_PAPER,
  paint,
  plastic,
  translucentPlastic,
} from '../materials.ts';
import type { Mesh } from '../mesh.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { merge, part, revolveLoop, revolveX } from './power-kit.ts';

const sprayerSchema = {
  diameter: num(L('Can diameter', 'Диаметр баллона'), 52, 33, 70, { step: 0.5 }),
  height: num(L('Overall height', 'Общая высота'), 195, 100, 260, { step: 1 }),
  top: choice(L('Top', 'Верх'), ['cap', 'nozzle'] as const, 'cap'),
  straw: choice(L('Straw', 'Трубка'), ['none', 'attached'] as const, 'none'),
  canColor: color(L('Can colour', 'Цвет баллона'), '#c8262b'),
  labelColor: color(L('Label colour', 'Цвет этикетки'), '#1b1c1e'),
  stripeColor: color(L('Stripe colour', 'Цвет полосы'), '#f0c326'),
  capColor: color(L('Cap colour', 'Цвет колпачка'), '#c8262b'),
};

export const sprayCan = defineToolClass({
  id: 'spray-can',
  family: 'workshop',
  name: L('Spray can', 'Аэрозольный баллон'),
  bankClass: 'spray-can',
  keywords: {
    en: ['spray can', 'aerosol can', 'spray paint', 'wd-40', 'lubricant spray'],
    ru: ['баллончик', 'аэрозоль', 'краска в баллончике', 'смазка WD-40'],
  },
  schema: sprayerSchema,
  presets: [
    { id: 'paint-400ml', label: L('Spray paint 400 ml', 'Краска в баллончике 400 мл'), values: {} },
    {
      id: 'wd40-400ml',
      label: L('Lubricant with straw 400 ml', 'Смазка WD-40 400 мл'),
      values: {
        diameter: 60,
        height: 200,
        top: 'nozzle',
        straw: 'attached',
        canColor: '#1d4fa0',
        labelColor: '#f2cf2a',
        stripeColor: '#c8262b',
        capColor: '#f2f2f0',
      },
    },
    {
      id: 'mini-100ml',
      label: L('Mini aerosol 100 ml', 'Мини-аэрозоль 100 мл'),
      values: {
        diameter: 35,
        height: 128,
        canColor: '#d6d9de',
        labelColor: '#2455a8',
        stripeColor: '#e8741e',
        capColor: '#2455a8',
      },
    },
    {
      id: 'maxi-520ml',
      label: L('Large can 520 ml', 'Большой баллон 520 мл'),
      values: {
        diameter: 65,
        height: 218,
        canColor: '#2b2c30',
        labelColor: '#e8741e',
        stripeColor: '#f0c326',
        capColor: '#e8741e',
      },
    },
    {
      id: 'contact-cleaner',
      label: L('Contact cleaner 200 ml', 'Очиститель контактов 200 мл'),
      values: {
        diameter: 52,
        height: 160,
        top: 'nozzle',
        straw: 'attached',
        canColor: '#2f8f4c',
        labelColor: '#f0eee8',
        stripeColor: '#1b1c1e',
        capColor: '#1b1c1e',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const R = p.diameter / 2;
    const H = p.height;
    const N = ctx.seg(72, 32);
    const canTop = H - 26;
    const rn = Math.min(clamp(R * 0.5, 10.5, 13), R * 0.55);
    const sh = R * 0.85;
    const yS = canTop - sh;
    // shoulder dome: quarter ellipse from the body radius down to the valve-cup neck
    const rNeck = rn * 1.2;
    const domeH = sh - 2.6;
    const DOME_STEPS = ctx.seg(10, 5);
    const domeR = (u: number): number => rNeck + (R - rNeck) * Math.sqrt(Math.max(0, 1 - u * u));
    const parts: Part[] = [];

    // body: domed base recess, chime, cylinder, domed shoulder to the valve cup
    const body: V2[] = [
      [0, 5.5],
      [R * 0.4, 5.0],
      [R * 0.66, 3.6],
      [R * 0.82, 1.4],
      [R * 0.9, 0.25],
      [R * 0.95, 0],
      [R * 0.985, 0.6],
      [R, 2.2],
      [R, yS],
      ...Array.from({ length: DOME_STEPS }, (_, k): V2 => {
        const u = (k + 1) / DOME_STEPS;
        return [domeR(u), yS + domeH * u];
      }),
      [rn * 1.05, canTop - 1.8],
      [0, canTop - 1.8],
    ];
    parts.push(
      part(
        'body',
        'body',
        { ...paint(p.canColor, 0.3, 'can lacquer'), metallic: 0.25 },
        lathe(body, N),
        40,
      ),
    );
    // label band + stripes (thin shells standing 0.2 mm proud)
    const y0 = Math.max(12, yS * 0.12);
    const y1 = yS - 4;
    parts.push(
      part(
        'label',
        'label',
        paint(p.labelColor, 0.45, 'printed label'),
        lathe(
          [
            [R + 0.2, y0],
            [R + 0.2, y1],
          ],
          N,
        ),
      ),
    );
    parts.push(
      part(
        'label-stripes',
        'label',
        paint(p.stripeColor, 0.45, 'label stripes'),
        merge(
          lathe(
            [
              [R + 0.35, y1 - 9],
              [R + 0.35, y1 - 3],
            ],
            N,
          ),
          lathe(
            [
              [R + 0.35, y0 + 3],
              [R + 0.35, y0 + 9],
            ],
            N,
          ),
        ),
      ),
    );
    // valve cup
    parts.push(
      part(
        'valve-cup',
        'metal',
        METALS.aluminium,
        lathe(
          [
            [rn * 1.22, canTop - 4],
            [rn * 1.22, canTop - 0.8],
            [rn * 1.0, canTop],
            [rn * 0.55, canTop],
            [rn * 0.55, canTop + 0.6],
            [0, canTop + 0.6],
          ],
          ctx.seg(40, 18),
        ),
      ),
    );
    const capMat: Material = plastic(p.capColor, 0.36, 'spray plastic');
    const yAct = H - 6;
    if (p.top === 'cap') {
      // overcap hugging the shoulder: follows the dome 1.4 mm proud, then a tube over the valve cup
      const u0 = 0.3;
      const off = 1.4;
      const capY0 = yS + domeH * u0;
      const rb = domeR(u0) + off;
      const rt = rNeck + off;
      const capProfile: V2[] = [
        [0, capY0],
        [rb - 0.9, capY0],
        [rb, capY0 + 0.5],
        ...Array.from({ length: DOME_STEPS }, (_, k): V2 => {
          const u = u0 + ((1 - u0) * (k + 1)) / DOME_STEPS;
          return [domeR(u) + off, yS + domeH * u];
        }),
        [rt, H - 2],
        [rt * 0.9, H],
        [0, H],
      ];
      parts.push(part('cap', 'cap', capMat, lathe(capProfile, N), 45));
    } else {
      parts.push(
        part(
          'actuator',
          'actuator',
          capMat,
          lathe(
            [
              [0, H],
              [6.4, H],
              [7.4, H - 1.6],
              [7.4, H - 11],
              [4.2, H - 12],
              [3.4, canTop + 1],
              [0, canTop + 1],
            ],
            ctx.seg(36, 16),
          ),
          40,
        ),
      );
      parts.push(
        part(
          'spray-tip',
          'actuator',
          plastic('#101012', 0.5, 'spray orifice'),
          revolveX(
            [
              [2.0, 5],
              [2.0, 10.4],
            ],
            yAct,
            0,
            ctx.seg(16, 8),
          ),
        ),
      );
      if (p.straw === 'attached') {
        const lift = 2.4;
        const path: V3[] = [
          [R + lift, y1 * 0.5, 0],
          [R + lift, yS, 0],
          ...[0.25, 0.5, 0.75, 1].map((u): V3 => [domeR(u) + lift, yS + domeH * u + lift * 0.6, 0]),
          [rNeck + lift, canTop + 1, 0],
          [9.2, yAct, 0],
        ];
        parts.push(
          part(
            'straw',
            'straw',
            translucentPlastic('#c8262b', 0.95, 'spray straw'),
            tube(roundedPath(path, 7, ctx.seg(6, 3)), 1.2, { sides: ctx.seg(10, 6) }),
          ),
        );
      }
    }

    return {
      parts,
      hang: { point: [0, canTop, 0], kind: 'neck' },
      zones: [
        { name: 'body', y0: 0, y1: yS },
        { name: 'shoulder', y0: yS, y1: canTop },
        { name: 'top', y0: canTop, y1: H },
      ],
      dims: {
        length: H,
        diameter: p.diameter,
        canHeight: canTop,
        neckDiameter: rn * 1.22 * 2,
      },
    };
  },
});

// ---------------------------------------------------------------- tape roll

const TAPE_TYPES = ['masking', 'duct', 'electrical', 'packing'] as const;

const tapeSchema = {
  outerDiameter: num(L('Outer diameter', 'Внешний диаметр'), 120, 40, 140, { step: 0.5 }),
  coreDiameter: num(L('Core (hole) diameter', 'Диаметр отверстия'), 76, 18, 90, { step: 0.5 }),
  width: num(L('Tape width', 'Ширина ленты'), 50, 8, 60, { step: 0.5 }),
  tapeType: choice(L('Tape type', 'Тип ленты'), TAPE_TYPES, 'masking'),
  tapeColor: color(L('Tape colour', 'Цвет ленты'), '#e6d3a3'),
  coreColor: color(L('Core colour', 'Цвет втулки'), '#ece8dc'),
};

function tapeMaterial(type: (typeof TAPE_TYPES)[number], c: string): Material {
  if (type === 'masking')
    return { ...WHITE_PAPER, name: 'masking tape', color: c, roughness: 0.82 };
  if (type === 'duct')
    return { name: 'cloth tape', kind: 'fabric', color: c, metallic: 0, roughness: 0.62, alpha: 1 };
  if (type === 'electrical')
    return { name: 'pvc tape', kind: 'plastic', color: c, metallic: 0, roughness: 0.3, alpha: 1 };
  return {
    name: 'packing tape',
    kind: 'plastic',
    color: c,
    metallic: 0,
    roughness: 0.14,
    alpha: 0.92,
  };
}

export const tapeRoll = defineToolClass({
  id: 'tape-roll',
  family: 'workshop',
  name: L('Tape roll', 'Рулон скотча / изоленты'),
  bankClass: 'tape-roll',
  keywords: {
    en: ['tape roll', 'masking tape', 'duct tape', 'electrical tape', 'adhesive tape'],
    ru: ['скотч', 'изолента', 'малярная лента', 'рулон ленты'],
  },
  schema: tapeSchema,
  presets: [
    {
      id: 'masking-120',
      label: L('Masking tape 120 / 76 / 50', 'Малярный скотч 120/76/50'),
      values: {},
    },
    {
      id: 'white-120',
      label: L('White tape 120 / 76 / 50', 'Белый скотч 120/76/50'),
      values: { tapeColor: '#f0eee8', coreColor: '#e4e0d4' },
    },
    {
      id: 'duct-100',
      label: L('Duct tape 100 / 76 / 48', 'Армированный скотч 100/76/48'),
      values: {
        outerDiameter: 100,
        width: 48,
        tapeType: 'duct',
        tapeColor: '#8d9096',
        coreColor: '#c7a56e',
      },
    },
    {
      id: 'electrical-50',
      label: L('Electrical tape 50 / 25 / 15 black', 'Изолента 50/25/15 чёрная'),
      values: {
        outerDiameter: 50,
        coreDiameter: 25,
        width: 15,
        tapeType: 'electrical',
        tapeColor: '#1b1c1e',
        coreColor: '#2b2c2f',
      },
    },
    {
      id: 'electrical-blue',
      label: L('Electrical tape 50 / 25 / 15 blue', 'Изолента 50/25/15 синяя'),
      values: {
        outerDiameter: 50,
        coreDiameter: 25,
        width: 15,
        tapeType: 'electrical',
        tapeColor: '#2455a8',
        coreColor: '#d8d4c8',
      },
    },
    {
      id: 'packing-110',
      label: L('Packing tape 110 / 76 / 48', 'Упаковочный скотч 110/76/48'),
      values: {
        outerDiameter: 110,
        width: 48,
        tapeType: 'packing',
        tapeColor: '#c9a46a',
        coreColor: '#9a7b4f',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const Ro = p.outerDiameter / 2;
    const rh = Math.min(p.coreDiameter / 2, Ro - 6);
    const w = p.width;
    const coreT = clamp(rh * 0.07, 1.4, 3.2);
    const rc = rh + coreT;
    const N = ctx.seg(128, 48);
    const e = Math.min(1.1, w * 0.08, (Ro - rc) * 0.2);
    const yc = Ro;
    const toRing = (m: Mesh): Mesh => place(m, rotX(90), at(0, yc, 0));
    const parts: Part[] = [];

    // tape ring, edges chamfered
    const tape: V2[] = [
      [rc - 0.4, -w / 2],
      [Ro - e, -w / 2],
      [Ro, -w / 2 + e],
      [Ro, w / 2 - e],
      [Ro - e, w / 2],
      [rc - 0.4, w / 2],
    ];
    parts.push(
      part('tape', 'tape', tapeMaterial(p.tapeType, p.tapeColor), toRing(revolveLoop(tape, N)), 40),
    );
    // core ring, standing 0.6 mm proud on both faces
    const cw = w / 2 + 0.6;
    const c2 = Math.min(0.5, coreT * 0.3);
    const core: V2[] = [
      [rh + c2, -cw],
      [rc, -cw],
      [rc, cw],
      [rh + c2, cw],
      [rh, cw - c2],
      [rh, -cw + c2],
    ];
    parts.push(
      part(
        'core',
        'core',
        { ...plastic(p.coreColor, 0.7, 'core'), kind: 'paper' },
        toRing(revolveLoop(core, N)),
        40,
      ),
    );
    // loose tail leaving the roll tangentially at the bottom right
    const a0 = (-78 * Math.PI) / 180;
    const arc = 12;
    const tail = 16 + Ro * 0.18;
    const thick = 0.55;
    const lower: V2[] = [];
    const upper: V2[] = [];
    const steps = ctx.seg(8, 4);
    for (let i = 0; i <= steps; i++) {
      const a = a0 - ((arc * Math.PI) / 180) * (1 - i / steps);
      lower.push([(Ro + 0.02) * Math.cos(a), yc + (Ro + 0.02) * Math.sin(a)]);
      upper.push([(Ro + thick) * Math.cos(a), yc + (Ro + thick) * Math.sin(a)]);
    }
    const P0 = lower[lower.length - 1] as V2;
    const t: V2 = [-Math.sin(a0), Math.cos(a0)];
    const n: V2 = [Math.cos(a0), Math.sin(a0)];
    const tips = 4;
    for (let i = 1; i <= tips; i++) {
      const s = (tail * i) / tips;
      const lift = 0.003 * s * s;
      lower.push([P0[0] + t[0] * s + n[0] * lift, P0[1] + t[1] * s + n[1] * lift]);
      upper.push([
        P0[0] + t[0] * s + n[0] * (lift + thick - 0.02),
        P0[1] + t[1] * s + n[1] * (lift + thick - 0.02),
      ]);
    }
    const outline: V2[] = [...lower, ...upper.reverse()];
    parts.push(
      part(
        'tail',
        'tape',
        tapeMaterial(p.tapeType, p.tapeColor),
        extrude(outline, -w / 2 + 0.2, w / 2 - 0.2),
      ),
    );

    return {
      parts,
      hang: { point: [0, yc, 0], kind: 'hole', diameterMm: rh * 2 },
      zones: [{ name: 'roll', y0: 0, y1: 2 * Ro }],
      dims: {
        length: p.outerDiameter,
        outerDiameter: p.outerDiameter,
        coreDiameter: rh * 2,
        width: w,
        thickness: w,
      },
    };
  },
});
