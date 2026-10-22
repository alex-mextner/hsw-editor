/**
 * Handheld digital multimeter. Origin on the vertical centre line at the bottom edge, +Y towards the
 * display, +Z towards the viewer (the face). A rubber holster ring + back plate wraps a pale face plate
 * that carries the LCD (bezel, screen, seven-segment digits), a button row, the rotary selector (fluted
 * knob, pointer, scale ticks) and the lead jacks. Size sources: HSW photo unit 88 x 146 x 31 mm
 * (refit/scene_extra_tools.py), Fluke 117-class 100 x 203 x 50 mm, budget 830-class 70 x 125 x 28 mm.
 */
import { clamp, type V2 } from '../math.ts';
import { loft, extrude, place, rotX, at } from '../build/primitives.ts';
import { flutedRing } from '../build/rings.ts';
import { type Mesh } from '../mesh.ts';
import { SCREEN, hexToRgb, plastic, rubber } from '../materials.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { circle2, merge, part, rrect, sevenSegment } from './power-kit.ts';

const schema = {
  width: num(L('Width', 'Ширина'), 88, 55, 105, { step: 0.5 }),
  length: num(L('Length', 'Длина'), 146, 100, 210, { step: 1 }),
  thickness: num(L('Thickness', 'Толщина'), 31, 18, 52, { step: 0.5 }),
  jacks: choice(L('Lead jacks', 'Гнёзда щупов'), ['3', '4'] as const, '3'),
  holsterColor: color(L('Holster colour', 'Цвет чехла'), '#1b1c1e'),
  faceColor: color(L('Face colour', 'Цвет панели'), '#e9e6dc'),
  dialColor: color(L('Selector colour', 'Цвет переключателя'), '#1b1c1e'),
  accentColor: color(L('Button accent colour', 'Цвет акцентной кнопки'), '#d9a521'),
};

export const multimeter = defineToolClass({
  id: 'multimeter',
  family: 'power',
  name: L('Multimeter', 'Мультиметр'),
  bankClass: 'multimeter',
  keywords: {
    en: ['multimeter', 'digital multimeter', 'voltmeter', 'tester'],
    ru: ['мультиметр', 'тестер', 'вольтметр'],
  },
  schema,
  presets: [
    { id: 'hsw-black', label: L('HSW wall unit 88x146', 'Мультиметр со стены 88x146'), values: {} },
    {
      id: 'fluke-style',
      label: L('Rugged yellow 100x203', 'Защищённый жёлтый 100x203'),
      values: {
        width: 100,
        length: 203,
        thickness: 50,
        jacks: '4',
        holsterColor: '#f0c326',
        faceColor: '#8d9196',
        dialColor: '#26272a',
        accentColor: '#c8262b',
      },
    },
    {
      id: 'budget-830',
      label: L('Budget pocket 70x125', 'Бюджетный карманный 70x125'),
      values: {
        width: 70,
        length: 125,
        thickness: 28,
        holsterColor: '#c8262b',
        faceColor: '#2b2c2f',
        dialColor: '#eceae2',
        accentColor: '#2455a8',
      },
    },
    {
      id: 'bench-blue',
      label: L('Bench 85x175', 'Настольный синий 85x175'),
      values: {
        width: 85,
        length: 175,
        thickness: 40,
        jacks: '4',
        holsterColor: '#2455a8',
        faceColor: '#dcdfe3',
        accentColor: '#e8741e',
      },
    },
    {
      id: 'mini-orange',
      label: L('Mini clamp-less 62x112', 'Мини оранжевый 62x112'),
      values: {
        width: 62,
        length: 112,
        thickness: 22,
        holsterColor: '#e8741e',
        faceColor: '#e9e6dc',
        accentColor: '#1b1c1e',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const { width: w, length: Lm, thickness: t } = p;
    const z0 = -t / 2;
    const zTop = t / 2 - 2.6;
    const zf = zTop - clamp(t * 0.07, 1.4, 3);
    const cx = 0;
    const yc = Lm / 2;
    const rim = clamp(w * 0.05, 3, 6);
    const parts: Part[] = [];

    // rubber holster: back plate + bumper ring that stands proud of the face
    const outer = rrect(cx, yc, w, Lm, clamp(w * 0.11, 6, 11), ctx.seg(5, 3));
    const hole = rrect(cx, yc, w - 2 * rim, Lm - 2 * rim, clamp(w * 0.07, 4, 8), ctx.seg(5, 3));
    const back = extrude(outer, z0, z0 + 1.6, { bevelBack: 1.2 });
    const ring = extrude(outer, z0 + 1.5, zTop, { holes: [hole], bevelFront: 1.2 });
    parts.push(
      part(
        'holster',
        'body',
        rubber(p.holsterColor, 'soft-grip', 'holster'),
        merge(back, ring),
        55,
      ),
    );
    // hard case face
    const plate = rrect(
      cx,
      yc,
      w - 2 * rim + 0.8,
      Lm - 2 * rim + 0.8,
      clamp(w * 0.07, 4, 8),
      ctx.seg(5, 3),
    );
    parts.push(
      part(
        'case',
        'face',
        plastic(p.faceColor, 0.5, 'case face'),
        extrude(plate, z0 + 1.2, zf, { bevelFront: 0.5 }),
        45,
      ),
    );

    // LCD
    const lw = w * 0.7;
    // vertical stack between the jacks and the display: dial (plate) + button row, centred in the gap
    const ringW = clamp(w * 0.07, 4, 7);
    const btnH = Lm * 0.04 + 3;
    const spaceBottom = Lm * 0.115 + 10;
    const spaceTop = Lm * 0.7075 - 3.5;
    const plateMax = (spaceTop - spaceBottom - 3 - btnH) / 2;
    const dialR = Math.min(clamp(w * 0.235, 11, 26), plateMax - ringW);
    const plateR = dialR + ringW;
    const stackBottom = spaceBottom + (spaceTop - spaceBottom - (2 * plateR + 3 + btnH)) / 2;
    const dy = stackBottom + plateR;
    const by = dy + plateR + 1.5 + btnH / 2;
    const lh = Lm * 0.165;
    const ly = Lm * 0.79;
    const bezelHole = rrect(cx, ly, lw - 0.8, lh - 0.8, 2, 3);
    parts.push(
      part(
        'lcd-bezel',
        'display',
        plastic('#1b1c1e', 0.3, 'bezel'),
        extrude(rrect(cx, ly, lw + 5, lh + 5, 3.5, 4), zf - 0.2, zf + 1.3, {
          holes: [bezelHole],
          bevelFront: 0.4,
        }),
        45,
      ),
    );
    parts.push(part('lcd', 'display', SCREEN, extrude(rrect(cx, ly, lw, lh, 2, 3), zf, zf + 0.9)));
    if (ctx.detail) {
      const dH = Math.min(lh * 0.62, (lw - 4) / 4.9 / 0.52);
      const dW = dH * 0.52;
      const step = dW * 1.55;
      const x0 = cx - step * 1.5 + dW * 0.25;
      const digits = sevenSegment('1234', x0, ly, dW, dH, step, zf + 0.9, zf + 1.0);
      digits.push(
        extrude(circle2(x0 + step + dW * 0.775, ly - dH * 0.5, dW * 0.1, 8), zf + 0.9, zf + 1.0),
      );
      parts.push(
        part('lcd-digits', 'display', plastic('#1b1c1e', 0.35, 'lcd ink'), merge(...digits)),
      );
    }

    // function buttons
    const bw = w * 0.15;
    const bx = [-1.5, -0.5, 0.5, 1.5].map((k) => k * (bw + w * 0.04));
    const btn = (x: number): Mesh =>
      extrude(rrect(x, by, bw, btnH, 2, 3), zf, zf + 2, { bevelFront: 0.7 });
    parts.push(
      part(
        'buttons',
        'control',
        plastic('#4a4d52', 0.5, 'button plastic'),
        merge(btn(bx[0] ?? 0), btn(bx[1] ?? 0), btn(bx[2] ?? 0)),
      ),
    );
    parts.push(
      part(
        'button-accent',
        'control',
        plastic(p.accentColor, 0.45, 'accent button'),
        btn(bx[3] ?? 0),
      ),
    );

    // rotary selector
    const knobH = clamp(t * 0.13, 3.2, 6);
    const N = ctx.seg(96, 40);
    const knobStations = [
      { y: 0, ring: flutedRing(dialR * 0.88, 24, 0, 24 * ctx.seg(4, 2)) },
      { y: knobH * 0.12, ring: flutedRing(dialR * 0.96, 24, 0.4, 24 * ctx.seg(4, 2)) },
      { y: knobH * 0.3, ring: flutedRing(dialR, 24, 0.9, 24 * ctx.seg(4, 2)) },
      { y: knobH * 0.78, ring: flutedRing(dialR, 24, 0.9, 24 * ctx.seg(4, 2)) },
      { y: knobH * 0.93, ring: flutedRing(dialR * 0.92, 24, 0.3, 24 * ctx.seg(4, 2)) },
      { y: knobH, ring: flutedRing(dialR * 0.84, 24, 0, 24 * ctx.seg(4, 2)) },
    ];
    parts.push(
      part(
        'dial-plate',
        'control',
        plastic('#1b1c1e', 0.4, 'dial plate'),
        extrude(circle2(cx, dy, plateR, N), zf, zf + 0.5),
      ),
    );
    parts.push(
      part(
        'dial',
        'control',
        plastic(p.dialColor, 0.38, 'selector knob'),
        place(loft(knobStations), rotX(90), at(cx, dy, zf + 0.4)),
        50,
      ),
    );
    const pa = (-35 * Math.PI) / 180;
    const pointer: V2[] = [
      [0, -dialR * 0.05],
      [dialR * 0.8, -dialR * 0.07],
      [dialR * 0.93, 0],
      [dialR * 0.8, dialR * 0.07],
      [0, dialR * 0.05],
    ].map(([x, y]) => [
      cx + (x ?? 0) * Math.cos(pa) - (y ?? 0) * Math.sin(pa),
      dy + (x ?? 0) * Math.sin(pa) + (y ?? 0) * Math.cos(pa),
    ]);
    const [dr, dg, db] = hexToRgb(p.dialColor);
    const markColor = 0.299 * dr + 0.587 * dg + 0.114 * db < 110 ? '#f2f0ea' : '#26272a';
    parts.push(
      part(
        'dial-pointer',
        'control',
        plastic(markColor, 0.4, 'pointer'),
        extrude(pointer, zf + 0.4 + knobH, zf + 0.4 + knobH + 0.35),
      ),
    );
    if (ctx.detail) {
      const ticks: Mesh[] = [];
      const n = 16;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const r0 = dialR + 1.8;
        const r1 = plateR - 0.9;
        const hw = 0.45;
        const [c, s] = [Math.cos(a), Math.sin(a)];
        const poly: V2[] = [
          [r0 * c - hw * s, r0 * s + hw * c],
          [r1 * c - hw * s, r1 * s + hw * c],
          [r1 * c + hw * s, r1 * s - hw * c],
          [r0 * c + hw * s, r0 * s - hw * c],
        ].map(([x, y]) => [cx + (x ?? 0), dy + (y ?? 0)]);
        ticks.push(extrude(poly, zf + 0.5, zf + 0.65));
      }
      parts.push(
        part('dial-scale', 'label', plastic('#f2f0ea', 0.5, 'printed scale'), merge(...ticks)),
      );
    }

    // lead jacks
    const jy = Lm * 0.115;
    const nj = p.jacks === '4' ? 4 : 3;
    const span = nj === 4 ? w * 0.22 : w * 0.27;
    const xs = Array.from({ length: nj }, (_, i) => (i - (nj - 1) / 2) * span);
    const comIdx = nj - 2;
    const jackR = clamp(w * 0.05, 3.2, 5);
    const collar = (x: number): Mesh =>
      extrude(circle2(x, jy, jackR, ctx.seg(24, 12)), zf, zf + 1.8, {
        holes: [circle2(x, jy, jackR * 0.52, ctx.seg(16, 8))],
        bevelFront: 0.4,
      });
    parts.push(
      part('jack-com', 'socket', plastic('#1b1c1e', 0.35, 'COM jack'), collar(xs[comIdx] ?? 0)),
    );
    parts.push(
      part(
        'jacks-red',
        'socket',
        plastic('#c8262b', 0.35, 'input jacks'),
        merge(...xs.filter((_, i) => i !== comIdx).map(collar)),
      ),
    );
    parts.push(
      part(
        'jack-bores',
        'socket',
        plastic('#0e0e10', 0.8, 'socket bore'),
        merge(
          ...xs.map((x) =>
            extrude(circle2(x, jy, jackR * 0.6, ctx.seg(16, 8)), zf + 0.05, zf + 0.5),
          ),
        ),
      ),
    );
    if (ctx.detail) {
      // legend bar under the jacks
      parts.push(
        part(
          'legend',
          'label',
          plastic('#26272a', 0.5, 'printed legend'),
          merge(
            ...xs.map((x) =>
              extrude(rrect(x, jy + jackR + 3.2, span * 0.6, 1.2, 0.5, 2), zf, zf + 0.12),
            ),
          ),
        ),
      );
    }

    return {
      parts,
      hang: { point: [cx, Lm, 0], kind: 'body' },
      zones: [
        { name: 'jacks', y0: 0, y1: Lm * 0.25 },
        { name: 'selector', y0: Lm * 0.25, y1: Lm * 0.6 },
        { name: 'display', y0: Lm * 0.6, y1: Lm },
      ],
      dims: {
        length: Lm,
        width: w,
        thickness: t,
        lcdWidth: lw,
        dialDiameter: dialR * 2,
      },
    };
  },
});
