/**
 * Cordless drill / driver (or impact driver), standing upright on its battery foot: Y runs up the pistol
 * grip (foot bottom at y = 0), the chuck points to +X, Z is the thickness. Parts: battery foot (+ accent
 * band, label), over-moulded grip, motor housing, gearbox, clutch ring, chuck sleeve + steel chuck with a
 * bit, trigger, forward/reverse slider, speed selector, work light. Size sources: HSW photo drill (body
 * 70 mm wide at the foot, grip 34 mm, orange/black 12 V), compact 12 V drills ~ 190 x 220 mm, 18 V drills
 * housing 62 mm.
 */
import { clamp, type V2 } from '../math.ts';
import { extrude, loft, lathe, place, at, rotZ, type Station } from '../build/primitives.ts';
import { profileStations } from '../build/profile.ts';
import { flutedRing, offsetRing, superellipse } from '../build/rings.ts';
import { METALS, WHITE_PAPER, plastic, rubber, translucentPlastic } from '../materials.ts';
import type { Mesh } from '../mesh.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { merge, part, revolveX, rrect, roundLoop, slabY } from './power-kit.ts';

const schema = {
  type: choice(L('Type', 'Тип'), ['drill-driver', 'impact-driver'] as const, 'drill-driver'),
  gripWidth: num(L('Grip width', 'Ширина рукоятки'), 34, 26, 44, { step: 0.5 }),
  gripHeight: num(L('Grip height', 'Высота рукоятки'), 84, 66, 110, { step: 1 }),
  housingDiameter: num(L('Motor housing diameter', 'Диаметр корпуса'), 56, 42, 72, { step: 0.5 }),
  housingLength: num(L('Housing length', 'Длина корпуса'), 112, 80, 150, { step: 1 }),
  footWidth: num(L('Battery foot width', 'Ширина основания'), 70, 52, 92, { step: 0.5 }),
  footHeight: num(L('Battery foot height', 'Высота основания'), 38, 28, 80, { step: 0.5 }),
  housingColor: color(L('Housing colour', 'Цвет корпуса'), '#e8741e'),
  gripColor: color(L('Grip and battery colour', 'Цвет накладок и батареи'), '#1b1c1e'),
  accentColor: color(L('Trigger colour', 'Цвет курка'), '#1b1c1e'),
};

export const cordlessDrill = defineToolClass({
  id: 'cordless-drill',
  family: 'power',
  name: L('Cordless drill / driver', 'Шуруповёрт / дрель'),
  bankClass: 'drill',
  keywords: {
    en: ['cordless drill', 'drill driver', 'impact driver', 'power drill', 'screw gun'],
    ru: ['шуруповёрт', 'шуруповерт', 'дрель', 'аккумуляторная дрель'],
  },
  schema,
  presets: [
    {
      id: 'orange-12v',
      label: L('12 V orange/black (HSW wall)', 'Шуруповёрт 12 В со стены'),
      values: {},
    },
    {
      id: 'blue-18v',
      label: L('18 V blue/black', 'Дрель-шуруповёрт 18 В, синяя'),
      values: {
        gripWidth: 38,
        gripHeight: 92,
        housingDiameter: 62,
        housingLength: 128,
        footWidth: 80,
        footHeight: 66,
        housingColor: '#2455a8',
        gripColor: '#1b1c1e',
        accentColor: '#1b1c1e',
      },
    },
    {
      id: 'yellow-20v',
      label: L('20 V yellow/black', 'Дрель 20 В, жёлтая'),
      values: {
        gripWidth: 40,
        gripHeight: 96,
        housingDiameter: 66,
        housingLength: 138,
        footWidth: 84,
        footHeight: 72,
        housingColor: '#f0c326',
        gripColor: '#1b1c1e',
        accentColor: '#1b1c1e',
      },
    },
    {
      id: 'impact-red',
      label: L('Impact driver red/black', 'Импакт-шуруповёрт, красный'),
      values: {
        type: 'impact-driver',
        gripWidth: 36,
        gripHeight: 80,
        housingDiameter: 54,
        housingLength: 96,
        footWidth: 68,
        footHeight: 44,
        housingColor: '#c8262b',
        gripColor: '#1b1c1e',
        accentColor: '#1b1c1e',
      },
    },
    {
      id: 'compact-green',
      label: L('Compact 12 V green', 'Компактный 12 В, зелёный'),
      values: {
        gripWidth: 30,
        gripHeight: 72,
        housingDiameter: 46,
        housingLength: 90,
        footWidth: 56,
        footHeight: 34,
        housingColor: '#2f8f4c',
        gripColor: '#1b1c1e',
        accentColor: '#c8262b',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const N = ctx.seg(72, 32);
    const seg = ctx.seg(5, 2);
    const parts: Part[] = [];
    const fh = p.footHeight;
    const gw = p.gripWidth;
    const gd = gw * 1.12;
    const Rp = p.housingDiameter / 2;
    const yG1 = fh + p.gripHeight;
    const yP = yG1 - 10 + Rp;
    const xR = -p.housingLength * 0.4;
    const xG = p.housingLength * 0.6;
    const lean = Math.tan((8 * Math.PI) / 180);

    // battery foot: shell, accent band, label
    const fz = p.footWidth * 0.8;
    const fx = p.footWidth * 0.06;
    parts.push(
      part(
        'battery',
        'battery',
        plastic(p.gripColor, 0.42, 'battery case'),
        slabY(rrect(fx, 0, p.footWidth, fz, 7, seg), 0, fh, { bevel: 2.5 }),
        45,
      ),
    );
    parts.push(
      part(
        'battery-band',
        'accent',
        plastic(p.housingColor, 0.45, 'battery band'),
        slabY(rrect(fx, 0, p.footWidth + 1.2, fz + 1.2, 7.6, seg), fh * 0.5, fh * 0.64, {
          holes: [rrect(fx, 0, p.footWidth - 4, fz - 4, 5, seg)],
          bevel: 0.35,
        }),
        45,
      ),
    );
    parts.push(
      part(
        'battery-label',
        'label',
        WHITE_PAPER,
        extrude(
          rrect(fx, fh * 0.3, p.footWidth * 0.46, fh * 0.28, 1.5, 2),
          fz / 2 - 0.2,
          fz / 2 + 0.25,
        ),
      ),
    );

    // grip: soft-touch over-mould, slightly leaning back
    const gripControl: readonly V2[] = [
      [0, 1.02],
      [0.18, 0.98],
      [0.42, 0.92],
      [0.72, 0.97],
      [1, 1.0],
    ];
    const gripStations: Station[] = profileStations(
      gripControl,
      fh - 3,
      yG1,
      (f, t) => {
        const ring = superellipse((gw / 2) * f, (gd / 2) * f, 2.5, N);
        const y = fh - 3 + (yG1 - fh + 3) * t;
        return offsetRing(ring, -(y - fh) * lean, 0);
      },
      ctx.seg(6, 3),
    );
    parts.push(
      part(
        'grip',
        'handle',
        rubber(p.gripColor, 'ribbed', 'soft-touch grip'),
        loft(gripStations),
        55,
      ),
    );

    // motor housing along +X
    const pod = profileStations(
      [
        [0, 0.86],
        [0.012, 0.95],
        [0.05, 0.99],
        [0.14, 1],
        [0.5, 1],
        [0.7, 0.92],
        [0.86, 0.82],
        [1, 0.76],
      ],
      0,
      xG - xR,
      (f) => superellipse(Rp * f, Rp * f * 0.9, 2.4, N),
      ctx.seg(6, 3),
    );
    parts.push(
      part(
        'housing',
        'body',
        plastic(p.housingColor, 0.4, 'motor housing'),
        place(loft(pod), rotZ(-90), at(xR, yP, 0)),
        50,
      ),
    );

    // gearbox, clutch ring
    const rGear = Rp * 0.74;
    const impact = p.type === 'impact-driver';
    const xCl = xG + (impact ? 26 : 14);
    parts.push(
      part(
        'gearbox',
        'head',
        plastic('#2b2c2f', 0.4, 'gearbox'),
        revolveX(
          [
            [rGear, xG - 6],
            [rGear * 0.98, xG + 1],
            [rGear * 0.9, xG + 1.01],
            [rGear * 0.9, xCl],
          ],
          yP,
          0,
          N,
        ),
      ),
    );
    const xChuck = xCl;
    if (!impact) {
      const stations: Station[] = [
        { y: 0, ring: flutedRing(rGear * 0.86, 28, 0, 28 * ctx.seg(3, 2)) },
        { y: 1, ring: flutedRing(rGear * 0.95, 28, 0.5, 28 * ctx.seg(3, 2)) },
        { y: 12, ring: flutedRing(rGear * 0.95, 28, 0.5, 28 * ctx.seg(3, 2)) },
        { y: 13, ring: flutedRing(rGear * 0.86, 28, 0, 28 * ctx.seg(3, 2)) },
      ];
      parts.push(
        part(
          'clutch-ring',
          'control',
          plastic('#44474c', 0.4, 'clutch collar'),
          place(loft(stations), rotZ(-90), at(xG + 1, yP, 0)),
          35,
        ),
      );
    }

    // chuck: rubber rear sleeve + knurled steel front with bore, bit
    const rc = clamp(Rp * (impact ? 0.46 : 0.56), 11, 20);
    const cl = impact ? 36 : 54;
    const xC1 = xChuck + cl;
    const rearEnd = xChuck + (impact ? 0 : cl * 0.44);
    if (!impact)
      parts.push(
        part(
          'chuck-sleeve',
          'head',
          rubber('#2b2c2f', 'ribbed', 'chuck rubber'),
          place(
            loft([
              { y: 0, ring: flutedRing(rc * 0.8, 24, 0, 24 * ctx.seg(4, 2)) },
              { y: 1, ring: flutedRing(rc * 0.96, 24, 0.6, 24 * ctx.seg(4, 2)) },
              { y: rearEnd - xChuck - 1, ring: flutedRing(rc * 0.98, 24, 0.6, 24 * ctx.seg(4, 2)) },
              { y: rearEnd - xChuck, ring: flutedRing(rc * 0.9, 24, 0.2, 24 * ctx.seg(4, 2)) },
            ]),
            rotZ(-90),
            at(xChuck, yP, 0),
          ),
          40,
        ),
      );
    const L2 = xC1 - rearEnd;
    const fl = (r: number, depth = 0): V2[] => flutedRing(r, 24, depth, 24 * ctx.seg(4, 2));
    const front: Station[] = [
      { y: 0, ring: fl(0) },
      { y: 0, ring: fl(rc * 0.92) },
      { y: L2 * 0.1, ring: fl(rc, 0.5) },
      { y: L2 * 0.62, ring: fl(rc * 0.97, 0.5) },
      { y: L2 * 0.88, ring: fl(rc * 0.74) },
      { y: L2 * 0.97, ring: fl(rc * 0.62) },
      { y: L2, ring: fl(rc * 0.55) },
      { y: L2, ring: fl(3.4) },
      { y: L2 - 16, ring: fl(3.4) },
      { y: L2 - 16, ring: fl(0) },
    ];
    parts.push(
      part(
        'chuck',
        'head',
        { ...METALS.chromeVanadium, name: 'chuck steel', roughness: 0.3 },
        place(loft(front), rotZ(-90), at(rearEnd, yP, 0)),
        35,
      ),
    );
    parts.push(
      part(
        'bit',
        'tool-bit',
        METALS.blackOxide,
        revolveX(
          [
            [3.1, xC1 - 14],
            [3.1, xChuck + cl + 22],
            [2.4, xChuck + cl + 22.01],
          ],
          yP,
          0,
          ctx.seg(20, 10),
        ),
      ),
    );

    // trigger and switches
    const yU = yP - Rp * 0.8;
    // grip front face at the trigger's mid-height (the grip leans back as it rises)
    const ux = gw * 0.48 - (yU - 16 - fh) * lean;
    const trigger = roundLoop(
      [
        [ux - 6, yU, 3],
        [ux + 8, yU - 2, 5],
        [ux + 12, yU - 22, 6],
        [ux + 6, yU - 32, 5],
        [ux - 4, yU - 28, 4],
      ],
      seg,
    );
    parts.push(
      part(
        'trigger',
        'control',
        plastic(p.accentColor, 0.4, 'trigger'),
        extrude(trigger, -gd * 0.17, gd * 0.17, { bevel: 1.6 }),
        45,
      ),
    );
    const slider = (z: number): Mesh =>
      extrude(rrect(ux - 2, yU + 6, 12, 5, 2, 2), z - 1.2, z + 1.2, { bevel: 0.5 });
    parts.push(
      part(
        'direction-switch',
        'control',
        plastic('#2b2c2f', 0.4, 'direction switch'),
        merge(slider(Rp * 0.9 * 0.82 + 0.5), slider(-(Rp * 0.9 * 0.82 + 0.5))),
      ),
    );
    parts.push(
      part(
        'speed-selector',
        'control',
        plastic('#2b2c2f', 0.4, 'speed selector'),
        extrude(rrect(xG * 0.35, yP + Rp * 0.96, 16, 6, 2, 2), -5, 5, { bevel: 0.8 }),
      ),
    );
    parts.push(
      part(
        'work-light',
        'indicator',
        translucentPlastic('#fff6d6', 0.9, 'led light'),
        place(
          lathe(
            [
              [0, yP - Rp * 0.5],
              [3.2, yP - Rp * 0.5],
              [3.2, yP - Rp * 0.9],
              [2.2, yP - Rp * 0.93],
              [0, yP - Rp * 0.93],
            ],
            ctx.seg(20, 10),
          ),
          at(xG - 12, 0, 0),
        ),
      ),
    );

    const xTip = xChuck + cl + 22;
    const yTop = yP + Rp;
    return {
      parts,
      hang: { point: [0, fh + p.gripHeight * 0.5, 0], kind: 'body' },
      zones: [
        { name: 'battery', y0: 0, y1: fh },
        { name: 'grip', y0: fh, y1: yG1 },
        { name: 'head', y0: yG1, y1: yTop },
      ],
      dims: {
        length: yTop,
        bodyWidth: p.footWidth,
        gripWidth: gw,
        gripThickness: gd,
        housingDiameter: p.housingDiameter,
        bodyLength: xTip - xR,
        chuckDiameter: rc * 2,
      },
    };
  },
});
