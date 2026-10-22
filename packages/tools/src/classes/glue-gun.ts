/**
 * Hot-melt glue gun, pistol grip standing on its base: Y runs up the grip (cord end at y = 0), the nozzle
 * points to +X and the glue stick feeds in from the rear (-X). Z is the slim thickness of the clamshell.
 * Parts: body (clamshell), grip (over-mould), trigger, nose shroud, heater tube, brass nozzle with
 * orifice, feed collar, glue stick, folding wire stand leg, cord, status LED. Sizes: mini 7 mm-stick gun
 * ~180 mm long, standard 11 mm-stick gun ~230 mm long over the nozzle, grip 28-36 mm wide.
 */
import { clamp, type V3 } from '../math.ts';
import { box, extrude, lathe, place, at, roundedPath, tube } from '../build/primitives.ts';
import { METALS, plastic, rubber, translucentPlastic } from '../materials.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { merge, part, revolveX, revolveZ, roundLoop } from './power-kit.ts';

/** Width (front to back) of the grip at its foot. */
const GRIP_FOOT = 30;

const schema = {
  bodyLength: num(L('Body length', 'Длина корпуса'), 128, 90, 170, { step: 1 }),
  gripHeight: num(L('Grip height', 'Высота рукоятки'), 88, 60, 115, { step: 1 }),
  bodyHeight: num(L('Body height', 'Высота корпуса'), 38, 26, 52, { step: 0.5 }),
  bodyWidth: num(L('Body thickness', 'Толщина корпуса'), 38, 26, 52, { step: 0.5 }),
  stickSize: choice(L('Glue stick diameter', 'Диаметр стержня'), ['7', '11'] as const, '11'),
  bodyColor: color(L('Body colour', 'Цвет корпуса'), '#1b1c1e'),
  gripColor: color(L('Grip colour', 'Цвет накладки'), '#2b2c2f'),
  accentColor: color(L('Trigger colour', 'Цвет курка'), '#e8741e'),
};

export const glueGun = defineToolClass({
  id: 'glue-gun',
  family: 'power',
  name: L('Hot glue gun', 'Клеевой пистолет'),
  bankClass: 'drill',
  keywords: {
    en: ['glue gun', 'hot glue gun', 'hot melt gun'],
    ru: ['клеевой пистолет', 'термоклеевой пистолет'],
  },
  schema,
  presets: [
    { id: 'standard-11mm', label: L('Standard 11 mm', 'Стандартный, стержень 11'), values: {} },
    {
      id: 'mini-7mm',
      label: L('Mini 7 mm', 'Мини, стержень 7'),
      values: {
        bodyLength: 104,
        gripHeight: 70,
        bodyHeight: 30,
        bodyWidth: 30,
        stickSize: '7',
        bodyColor: '#e8e4da',
        gripColor: '#d65a8e',
        accentColor: '#d65a8e',
      },
    },
    {
      id: 'pro-high-temp',
      label: L('Pro high-temp 11 mm', 'Профессиональный'),
      values: {
        bodyLength: 150,
        gripHeight: 104,
        bodyHeight: 48,
        bodyWidth: 46,
        bodyColor: '#f0c326',
        gripColor: '#1b1c1e',
        accentColor: '#1b1c1e',
      },
    },
    {
      id: 'craft-blue',
      label: L('Craft blue 11 mm', 'Синий хобби'),
      values: {
        bodyLength: 120,
        gripHeight: 82,
        bodyHeight: 36,
        bodyWidth: 36,
        bodyColor: '#2455a8',
        gripColor: '#1b1c1e',
        accentColor: '#e5e8ec',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const bl = p.bodyLength;
    const bh = p.bodyHeight;
    const bw = p.bodyWidth;
    const gw = bw * 0.8;
    const cordL = 30;
    const gb = cordL;
    const yU = gb + p.gripHeight;
    const yT = yU + bh;
    const xR = -bl * 0.45;
    const xF = bl * 0.55;
    const yN = yU + bh * 0.52;
    const steps = ctx.seg(5, 2);
    const parts: Part[] = [];

    const bodyOutline = roundLoop(
      [
        [-22, yU - 10, 8],
        [26, yU - 10, 8],
        [xF - 20, yU, 8],
        [xF, yU + bh * 0.3, 10],
        [xF, yT - bh * 0.3, 10],
        [xF - 30, yT, 16],
        [xR + 8, yT, 16],
        [xR, yT - bh * 0.3, 10],
        [xR, yU + bh * 0.2, 8],
      ],
      steps,
    );
    parts.push(
      part(
        'body',
        'body',
        plastic(p.bodyColor, 0.4, 'gun housing'),
        extrude(bodyOutline, -bw / 2, bw / 2, { bevel: Math.min(5, bw * 0.12) }),
        45,
      ),
    );

    const gripOutline = roundLoop(
      [
        [-GRIP_FOOT / 2, gb, 7],
        [GRIP_FOOT / 2, gb, 7],
        [20, gb + p.gripHeight * 0.45, 14],
        [25, yU + 4, 10],
        [-31, yU + 4, 10],
        [-22, gb + p.gripHeight * 0.55, 14],
      ],
      steps,
    );
    parts.push(
      part(
        'grip',
        'handle',
        rubber(p.gripColor, 'ribbed', 'over-mould grip'),
        extrude(gripOutline, -gw / 2, gw / 2, { bevel: Math.min(4.5, gw * 0.14) }),
        55,
      ),
    );

    // trigger sits in the front of the grip under the body
    const tw = clamp(gw * 0.45, 9, 16);
    const trig = roundLoop(
      [
        [14, yU - 8, 3],
        [28, yU - 10, 5],
        [31, yU - 38, 6],
        [24, yU - 44, 5],
        [17, yU - 36, 4],
      ],
      steps,
    );
    parts.push(
      part(
        'trigger',
        'control',
        plastic(p.accentColor, 0.38, 'trigger'),
        extrude(trig, -tw / 2, tw / 2, { bevel: 1.4 }),
        45,
      ),
    );

    // nose: shroud, heater tube, brass nozzle
    const rs = bh * 0.4;
    parts.push(
      part(
        'nose-shroud',
        'head',
        plastic(p.bodyColor, 0.4, 'nose shroud'),
        revolveX(
          [
            [rs * 1.05, xF - 8],
            [rs, xF + 2],
            [rs * 0.82, xF + 14],
            [rs * 0.66, xF + 18],
          ],
          yN,
          0,
          ctx.seg(40, 16),
        ),
      ),
    );
    const x1 = xF + 40;
    parts.push(
      part(
        'heater',
        'head',
        { ...METALS.aluminium, name: 'heater tube', roughness: 0.3 },
        revolveX(
          [
            [rs * 0.55, xF + 14],
            [rs * 0.52, xF + 30],
            [rs * 0.42, x1],
          ],
          yN,
          0,
          ctx.seg(32, 14),
        ),
      ),
    );
    parts.push(
      part(
        'nozzle',
        'head',
        METALS.brass,
        revolveX(
          [
            [0, x1 + 12],
            [1.0, x1 + 12],
            [1.0, x1 + 16],
            [2.2, x1 + 16],
            [4.4, x1 + 7],
            [5.6, x1],
            [0, x1 - 2],
          ],
          yN,
          0,
          ctx.seg(32, 14),
        ),
      ),
    );

    // glue stick and feed collar at the rear
    const rStick = p.stickSize === '11' ? 5.5 : 3.5;
    const stickLen = 68;
    parts.push(
      part(
        'feed-collar',
        'body',
        plastic('#3b3c3f', 0.4, 'feed collar'),
        revolveX(
          [
            [rStick * 1.9, xR - 7],
            [rStick * 1.9, xR - 1],
            [rStick * 1.5, xR + 3],
          ],
          yN,
          0,
          ctx.seg(32, 14),
        ),
      ),
    );
    parts.push(
      part(
        'glue-stick',
        'consumable',
        translucentPlastic('#f2ecd0', 0.88, 'hot melt stick'),
        revolveX(
          [
            [rStick, xR - 7 - stickLen],
            [rStick, xR + 8],
          ],
          yN,
          0,
          ctx.seg(24, 12),
        ),
      ),
    );

    // folding wire stand under the nose
    const wire: V3[] = [
      [xF - 40, yU + 1, -bw * 0.38],
      [xF + 2, gb + 3, -bw * 0.48],
      [xF + 2, gb + 3, bw * 0.48],
      [xF - 40, yU + 1, bw * 0.38],
    ];
    parts.push(
      part(
        'stand-leg',
        'stand',
        METALS.zinc,
        tube(roundedPath(wire, 5, ctx.seg(6, 3)), 1.4, { sides: ctx.seg(10, 6) }),
      ),
    );

    // cord and strain relief
    parts.push(
      part(
        'cord',
        'cord',
        rubber('#18191b', 'smooth', 'cord'),
        merge(
          lathe(
            [
              [2.4, 0],
              [2.4, gb + 2],
            ],
            ctx.seg(16, 8),
          ),
          lathe(
            [
              [2.8, gb - 12],
              [4.2, gb - 4],
              [6.2, gb + 1],
            ],
            ctx.seg(16, 8),
          ),
        ),
      ),
    );
    parts.push(
      part(
        'status-led',
        'indicator',
        plastic('#e8741e', 0.3, 'status led'),
        revolveZ(
          [
            [2, bw / 2 - 1.2],
            [2, bw / 2 + 0.3],
          ],
          xR + 22,
          yT - bh * 0.3,
          ctx.seg(16, 8),
        ),
      ),
    );
    if (ctx.detail) {
      // small switch plate on the side of the body
      parts.push(
        part(
          'switch',
          'control',
          plastic(p.accentColor, 0.4, 'power switch'),
          place(box(12, 5, 4, 1.2, 2), at(6, yT - bh * 0.3, bw / 2 + 0.2)),
        ),
      );
    }

    const xFront = x1 + 16;
    const xBack = xR - 7 - stickLen;
    return {
      parts,
      hang: { point: [0, gb + 6, 0], kind: 'butt' },
      zones: [
        { name: 'cord', y0: 0, y1: gb },
        { name: 'grip', y0: gb, y1: yU },
        { name: 'body', y0: yU, y1: yT },
      ],
      dims: {
        length: yT,
        bodyLength: xFront - xBack,
        gripWidth: GRIP_FOOT,
        gripThickness: gw,
        bodyHeight: bh,
        bodyThickness: bw,
        stickDiameter: rStick * 2,
      },
    };
  },
});
