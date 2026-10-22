/**
 * Cordless-tool slide battery pack (12 V / 18 V class). Axis +Y along the pack (the end with the
 * terminals is +Y), +Z is the mating face carrying the slide platform, the two rails, the terminal
 * blades, the release tab and the fuel-gauge LEDs; a contrast band wraps the lower half and a rating label
 * sits on the +X side. Size source: HSW spare drill battery 70 x 85 x 36 mm (refit/scene_extra_tools.py),
 * 18 V packs 80-90 x 75-90 x 55-75 mm.
 */
import { clamp } from '../math.ts';
import { extrude } from '../build/primitives.ts';
import { METALS, WHITE_PAPER, plastic } from '../materials.ts';
import type { Mesh } from '../mesh.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { merge, part, rrect, slabX } from './power-kit.ts';

const schema = {
  width: num(L('Width', 'Ширина'), 70, 48, 95, { step: 0.5 }),
  length: num(L('Length', 'Длина'), 85, 60, 125, { step: 0.5 }),
  height: num(L('Case height', 'Высота корпуса'), 36, 26, 80, { step: 0.5 }),
  voltage: choice(L('Voltage class', 'Напряжение'), ['12V', '18V'] as const, '12V'),
  housingColor: color(L('Housing colour', 'Цвет корпуса'), '#1b1c1e'),
  accentColor: color(L('Accent colour', 'Цвет вставки и кнопки'), '#e8741e'),
};

export const batteryPack = defineToolClass({
  id: 'battery-pack',
  family: 'power',
  name: L('Battery pack', 'Аккумулятор'),
  bankClass: 'drill',
  keywords: {
    en: ['battery pack', 'drill battery', 'cordless battery', 'li-ion battery pack'],
    ru: ['аккумулятор', 'батарея шуруповёрта', 'аккумулятор для инструмента'],
  },
  schema,
  presets: [
    {
      id: 'orange-12v',
      label: L('12 V orange/black 70 x 85', 'Аккумулятор 12 В, оранжевый'),
      values: {},
    },
    {
      id: 'orange-18v',
      label: L('18 V orange/black 90 x 78', 'Аккумулятор 18 В, оранжевый'),
      values: { width: 88, length: 78, height: 66, voltage: '18V' },
    },
    {
      id: 'blue-12v-slim',
      label: L('12 V blue slim 56 x 78', 'Аккумулятор 12 В, синий'),
      values: {
        width: 56,
        length: 78,
        height: 40,
        accentColor: '#2455a8',
        housingColor: '#1d1e21',
      },
    },
    {
      id: 'yellow-20v',
      label: L('18 V yellow 82 x 86', 'Аккумулятор 18 В, жёлтый'),
      values: {
        width: 82,
        length: 86,
        height: 72,
        voltage: '18V',
        housingColor: '#f0c326',
        accentColor: '#1b1c1e',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const { width: w, length: Lp, height: h } = p;
    const yc = Lp / 2;
    const z0 = -h / 2;
    const zb = h / 2;
    const r = clamp(w * 0.09, 4, 8);
    const seg = ctx.seg(5, 2);
    const parts: Part[] = [];

    parts.push(
      part(
        'housing',
        'body',
        plastic(p.housingColor, 0.42, 'pack housing'),
        extrude(rrect(0, yc, w, Lp, r, seg), z0, zb, { bevelBack: 3, bevelFront: 2 }),
        45,
      ),
    );
    // contrast band round the lower part (a shell ring standing 0.6 mm proud)
    const bandZ0 = z0 + h * 0.2;
    const bandZ1 = z0 + h * 0.46;
    parts.push(
      part(
        'band',
        'accent',
        plastic(p.accentColor, 0.45, 'accent band'),
        extrude(rrect(0, yc, w + 1.2, Lp + 1.2, r + 0.6, seg), bandZ0, bandZ1, {
          holes: [rrect(0, yc, w - 4, Lp - 4, Math.max(r - 2, 1), seg)],
          bevel: 0.4,
        }),
        45,
      ),
    );
    // slide platform + rails
    const platW = w * 0.6;
    const platL = Lp * 0.8;
    const platY = Lp * 0.52;
    parts.push(
      part(
        'slide-platform',
        'body',
        plastic(p.housingColor, 0.4, 'slide platform'),
        extrude(rrect(0, platY, platW, platL, 3, 3), zb - 0.3, zb + 4, { bevelFront: 0.8 }),
        45,
      ),
    );
    const railW = clamp(w * 0.055, 2.4, 5);
    const rail = (x: number): Mesh =>
      extrude(rrect(x, platY, railW, platL * 0.9, 1, 2), zb + 3.6, zb + 8, { bevelFront: 0.8 });
    parts.push(
      part('rails', 'rail', METALS.darkSteel, merge(rail(-platW * 0.34), rail(platW * 0.34)), 45),
    );
    // terminal block: recess + blades
    const tY = platY + platL / 2 - 9;
    parts.push(
      part(
        'terminal-block',
        'contact',
        plastic('#101012', 0.5, 'terminal block'),
        extrude(rrect(0, tY, platW * 0.7, 12, 1.5, 2), zb + 3.8, zb + 5.2),
      ),
    );
    const blades = [-2, -1, 0, 1, 2].map((k) =>
      extrude(rrect(k * platW * 0.13, tY, 1.8, 8.5, 0.5, 2), zb + 5, zb + 9),
    );
    parts.push(part('contacts', 'contact', METALS.brass, merge(...blades)));
    // release tab at the rear end of the platform
    const tabY = Lp * 0.1 + 6;
    const tab = extrude(rrect(0, tabY, w * 0.42, 13, 3, 3), zb - 0.4, zb + 6.5, {
      bevelFront: 1.8,
    });
    parts.push(
      part('release-tab', 'control', plastic(p.accentColor, 0.42, 'release tab'), tab, 45),
    );
    if (ctx.detail) {
      const ridges = [-1.5, -0.5, 0.5, 1.5].map((k) =>
        extrude(rrect(0, tabY + k * 2.7, w * 0.3, 0.9, 0.3, 2), zb + 5.2, zb + 6.7),
      );
      parts.push(
        part('tab-ridges', 'control', plastic('#2b2c2f', 0.5, 'tab grip'), merge(...ridges)),
      );
    }
    // fuel gauge LEDs
    const leds = [-1.5, -0.5, 0.5, 1.5].map((k) =>
      extrude(rrect(k * w * 0.085, Lp * 0.32, w * 0.05, 3, 0.8, 2), zb + 3.8, zb + 4.5),
    );
    parts.push(
      part('fuel-gauge', 'indicator', plastic('#3fae5a', 0.3, 'gauge led'), merge(...leds)),
    );
    // rating label on the +X side, above the contrast band
    const labelZ = h * 0.17;
    const sideOutline = (cy: number, len: number, hh: number) =>
      rrect(Lp * 0.5, cy, len, hh, 1.5, 2).map(([a, b]): [number, number] => [b, a]);
    parts.push(
      part(
        'label',
        'label',
        WHITE_PAPER,
        slabX(sideOutline(labelZ, Lp * 0.62, h * 0.3), w / 2 - 0.2, w / 2 + 0.25),
      ),
    );
    parts.push(
      part(
        'label-voltage',
        'label',
        plastic(p.accentColor, 0.5, 'voltage mark'),
        slabX(sideOutline(labelZ, Lp * 0.2, h * 0.13), w / 2 + 0.2, w / 2 + 0.4),
      ),
    );

    return {
      parts,
      hang: { point: [0, Lp * 0.5, 0], kind: 'body' },
      zones: [
        { name: 'rear', y0: 0, y1: Lp * 0.3 },
        { name: 'platform', y0: Lp * 0.3, y1: Lp },
      ],
      dims: {
        length: Lp,
        width: w,
        thickness: h + 9,
        caseHeight: h,
      },
    };
  },
});
