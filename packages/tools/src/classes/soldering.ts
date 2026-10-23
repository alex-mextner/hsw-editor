/**
 * Soldering iron: pencil iron (cork / silicone / plastic grip, hex nut, stainless sleeve, tinned tip,
 * cord stub) or a small soldering station (slanted-panel base unit with LED display, temperature knob and
 * power switch, plus a wire stand with the iron resting in it). Axis +Y; the pencil starts at the cord end
 * (y = 0) and ends at the tip. In station form the base unit is centred on x = 0 and the stand with the
 * iron sits to its right. Sizes: 30-60 W pencil irons 180-230 mm over the cord stub, grip 14-24 mm;
 * Hakko FX-888D-class station 100 x 120 mm footprint.
 */
import { clamp, type V2, type V3 } from '../math.ts';
import {
  type Station,
  box,
  extrude,
  loft,
  lathe,
  place,
  at,
  rotX,
  rotZ,
  tube,
  roundedPath,
} from '../build/primitives.ts';
import { profileStations } from '../build/profile.ts';
import {
  circleRing,
  flutedRing,
  offsetRing,
  polygonRing,
  scaleRing,
  superellipse,
} from '../build/rings.ts';
import { METALS, SCREEN, type Material, plastic, rubber, wood } from '../materials.ts';
import type { Mesh } from '../mesh.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, type Values, choice, color, num } from '../params.ts';
import { defineToolClass, type BuildCtx } from '../registry.ts';
import {
  circle2,
  helix,
  merge,
  part,
  rrect,
  roundLoop,
  sevenSegment,
  slabX,
  slabY,
} from './power-kit.ts';

const schema = {
  form: choice(L('Setup', 'Исполнение'), ['pencil', 'station'] as const, 'pencil'),
  gripDiameter: num(L('Grip diameter', 'Диаметр рукоятки'), 19, 13, 26, { step: 0.5 }),
  gripLength: num(L('Grip length', 'Длина рукоятки'), 95, 70, 125, { step: 1 }),
  barrelLength: num(L('Sleeve length', 'Длина гильзы'), 46, 28, 70, { step: 1 }),
  tipLength: num(L('Tip length', 'Длина жала'), 17, 9, 32, { step: 0.5 }),
  tipStyle: choice(
    L('Tip shape', 'Форма жала'),
    ['conical', 'chisel', 'bevel'] as const,
    'conical',
  ),
  gripMaterial: choice(
    L('Grip material', 'Материал рукоятки'),
    ['cork', 'silicone', 'plastic'] as const,
    'cork',
  ),
  gripColor: color(L('Grip colour', 'Цвет рукоятки'), '#b3865a'),
  bodyColor: color(L('Station body colour', 'Цвет корпуса станции'), '#ece9e2'),
  panelColor: color(L('Station panel colour', 'Цвет панели станции'), '#1b1c1e'),
};

type Params = Values<typeof schema>;

function gripMaterial(kind: Params['gripMaterial'], colorHex: string): Material {
  if (kind === 'cork') return { ...wood('beech', 0.9), name: 'cork', color: colorHex };
  if (kind === 'silicone') return rubber(colorHex, 'soft-grip', 'silicone grip');
  return plastic(colorHex, 0.4, 'grip plastic');
}

interface Iron {
  parts: Part[];
  /** Local y of the end of the grip (where the hex nut starts) and of the tip end. */
  yGripStart: number;
  yGrip: number;
  yTip: number;
  gripRadius: number;
}

/** The iron in its own frame: axis +Y, cord end at y = 0. */
function buildIron(p: Params, ctx: BuildCtx): Iron {
  const rg = p.gripDiameter / 2;
  const N = ctx.seg(64, 28);
  const parts: Part[] = [];
  const yG0 = 46;
  const yG1 = yG0 + p.gripLength;
  const rc = clamp(rg * 0.5, 5, 8.5);
  const rBar = clamp(rg * 0.27, 3.6, 6.2);
  const yB0 = yG1 + 10;
  const yB1 = yB0 + p.barrelLength;
  const yT = yB1 + p.tipLength;

  // strain-relief boot
  parts.push(
    part(
      'boot',
      'cord',
      rubber('#18191b', 'smooth', 'strain relief'),
      lathe(
        [
          [2.6, 18],
          [3.0, 24],
          [3.9, 32],
          [rg * 0.66, 40],
          [rg * 0.8, yG0 + 2],
        ],
        ctx.seg(32, 16),
      ),
    ),
  );

  // grip
  const control: readonly V2[] = [
    [0, 0.8],
    [0.03, 0.93],
    [0.1, 1],
    [0.55, 0.98],
    [0.82, 0.88],
    [0.94, 0.78],
    [1, 0.76],
  ];
  const ribbed = p.gripMaterial !== 'cork';
  const gripStations = profileStations(
    control,
    yG0,
    yG1,
    (f, t) => {
      const r = rg * f;
      if (ribbed && ctx.detail)
        return flutedRing(r, 12, rg * 0.04 * Math.min(1, t * 6) * Math.min(1, (1 - t) * 6), 12 * 6);
      return circleRing(r, N);
    },
    ctx.seg(7, 3),
  );
  parts.push(
    part('grip', 'handle', gripMaterial(p.gripMaterial, p.gripColor), loft(gripStations), 55),
  );

  // hex nut + heat-shield cone
  const hexN = ctx.seg(36, 12);
  const hex = polygonRing(6, (rc / Math.cos(Math.PI / 6)) * 0.92, hexN, true);
  parts.push(
    part(
      'collar',
      'ferrule',
      METALS.steel,
      loft([
        { y: yG1 - 1, ring: scaleRing(hex, 0.93) },
        { y: yG1, ring: hex },
        { y: yG1 + 9, ring: hex },
        { y: yG1 + 10, ring: scaleRing(hex, 0.86) },
      ]),
      25,
    ),
  );

  // stainless sleeve: cone, vented tube, tip nut
  const sleeve: V2[] = [
    [rc * 0.8, yG1 + 9],
    [rBar * 1.3, yG1 + 14],
    [rBar * 1.05, yG1 + 18],
    [rBar, yG1 + 22],
  ];
  const tubeEnd = yB1 - 10;
  sleeve.push([rBar, tubeEnd]);
  sleeve.push([rBar * 0.84, tubeEnd + 3], [rBar * 0.8, yB1 - 3], [rBar * 0.68, yB1]);
  parts.push(part('sleeve', 'shaft', METALS.polishedSteel, lathe(sleeve, ctx.seg(40, 20))));
  if (ctx.detail) {
    // vent ring marks on the sleeve
    const rings: Mesh[] = [];
    for (let i = 0; i < 3; i++) {
      const y = yG1 + 28 + i * 3.4;
      if (y < tubeEnd - 4)
        rings.push(
          lathe(
            [
              [rBar * 1.02, y],
              [rBar * 1.02, y + 1.1],
            ],
            24,
          ),
        );
    }
    if (rings.length) parts.push(part('sleeve-vents', 'shaft', METALS.blackOxide, merge(...rings)));
  }

  // tip
  const rt = rBar * 0.7;
  const tipRing = (u: number): readonly V2[] => {
    const n = ctx.seg(40, 20);
    const shoulder = u < 0.08 ? 1 : 1 - 0.14 * Math.min(1, (u - 0.08) / 0.2);
    if (p.tipStyle === 'conical') {
      const taper = u < 0.5 ? 1 - 0.18 * (u / 0.5) : 0.82 * (1 - ((u - 0.5) / 0.5) ** 1.4 * 0.95);
      return circleRing(Math.max(0.02, rt * shoulder * taper), n);
    }
    const a = rt * shoulder * (u < 0.55 ? 1 : 1 + 0.18 * ((u - 0.55) / 0.45));
    const b = Math.max(0.3, rt * shoulder * (u < 0.55 ? 1 : 1 - 0.8 * ((u - 0.55) / 0.45) ** 0.8));
    const ring = superellipse(a, b, u < 0.55 ? 2 : 2 + 5 * ((u - 0.55) / 0.45), n);
    return p.tipStyle === 'bevel' ? offsetRing(ring, 0, b - rt * shoulder) : ring;
  };
  const tipStations = (u0: number, u1: number, k: number): Station[] =>
    Array.from({ length: k + 1 }, (_, i) => {
      const u = u0 + ((u1 - u0) * i) / k;
      return { y: yB1 - 4 + (yT - yB1 + 4) * u, ring: tipRing(u) };
    });
  const k = ctx.seg(12, 6);
  parts.push(
    part(
      'tip',
      'tip',
      { ...METALS.darkSteel, name: 'iron-plated tip', roughness: 0.38 },
      loft(tipStations(0, 0.7, k)),
      30,
    ),
  );
  parts.push(part('tip-tinned', 'tip', METALS.polishedSteel, loft(tipStations(0.66, 1, k)), 30));

  return { parts, yGripStart: yG0, yGrip: yG1, yTip: yT, gripRadius: rg };
}

/** Seven-segment LED display + knob etc. on the slanted panel, in panel-local coordinates. */
function panelItems(
  W: number,
  Ls: number,
  panelColor: string,
  ctx: BuildCtx,
): { name: string; role: string; material: Material; mesh: Mesh }[] {
  const out: { name: string; role: string; material: Material; mesh: Mesh }[] = [];
  const plate = extrude(rrect(0, Ls / 2, W - 14, Ls - 14, 4, 4), -0.6, 1.4, { bevelFront: 0.5 });
  out.push({
    name: 'station-panel',
    role: 'face',
    material: plastic(panelColor, 0.36, 'panel'),
    mesh: plate,
  });
  const dy = Ls * 0.72;
  const bezel = extrude(rrect(0, dy, 54, 22, 2.5, 3), 1.2, 2.4, {
    holes: [rrect(0, dy, 48, 16, 1.5, 3)],
  });
  out.push({
    name: 'display-bezel',
    role: 'display',
    material: plastic('#101012', 0.3, 'bezel'),
    mesh: bezel,
  });
  out.push({
    name: 'display',
    role: 'display',
    material: { ...SCREEN, name: 'led window', color: '#2a0d0c' },
    mesh: extrude(rrect(0, dy, 49, 17, 1.5, 3), 1.2, 2.0),
  });
  if (ctx.detail) {
    out.push({
      name: 'display-digits',
      role: 'display',
      material: plastic('#ff4a36', 0.3, 'led digits'),
      mesh: merge(...sevenSegment('350', -11, dy, 8.4, 13, 11, 2.0, 2.2)),
    });
  }
  const kr = 13;
  const ky = Ls * 0.3;
  const N = ctx.seg(72, 32);
  const knob = loft([
    { y: 0, ring: flutedRing(kr * 0.9, 18, 0, N) },
    { y: 1, ring: flutedRing(kr, 18, 0.7, N) },
    { y: 8, ring: flutedRing(kr, 18, 0.7, N) },
    { y: 9.4, ring: flutedRing(kr * 0.9, 18, 0.2, N) },
    { y: 10, ring: flutedRing(kr * 0.8, 18, 0, N) },
  ]);
  out.push({
    name: 'knob',
    role: 'control',
    material: plastic('#202124', 0.4, 'knob'),
    mesh: place(knob, rotX(90), at(0, ky, 1.2)),
  });
  out.push({
    name: 'knob-mark',
    role: 'control',
    material: plastic('#f2f0ea', 0.4, 'knob mark'),
    mesh: extrude(
      [
        [-0.8, ky + 2],
        [0.8, ky + 2],
        [0.8, ky + kr * 0.85],
        [-0.8, ky + kr * 0.85],
      ],
      11.2,
      11.5,
    ),
  });
  out.push({
    name: 'power-switch',
    role: 'control',
    material: plastic('#d4d0c6', 0.4, 'power rocker'),
    mesh: extrude(rrect(-W * 0.3, Ls * 0.2, 11, 17, 2, 3), 1.2, 4.4, { bevelFront: 1.4 }),
  });
  out.push({
    name: 'status-led',
    role: 'display',
    material: plastic('#e03a2e', 0.3, 'status led'),
    mesh: extrude(circle2(W * 0.3, Ls * 0.2, 2, 12), 1.2, 2.0),
  });
  return out;
}

export const solderingIron = defineToolClass({
  id: 'soldering-iron',
  family: 'power',
  name: L('Soldering iron / station', 'Паяльник / паяльная станция'),
  bankClass: 'soldering-iron',
  keywords: {
    en: ['soldering iron', 'soldering station', 'solder pencil', 'hakko station'],
    ru: ['паяльник', 'паяльная станция'],
  },
  schema,
  presets: [
    {
      id: 'pencil-cork-30w',
      label: L('30 W pencil, cork grip', 'Паяльник 30 Вт, пробка'),
      values: {},
    },
    {
      id: 'pencil-silicone-60w',
      label: L('60 W pencil, silicone grip', 'Паяльник 60 Вт, силикон'),
      values: {
        gripDiameter: 21,
        gripLength: 102,
        barrelLength: 54,
        tipLength: 19,
        tipStyle: 'chisel',
        gripMaterial: 'silicone',
        gripColor: '#e8741e',
      },
    },
    {
      id: 'pencil-fine-smd',
      label: L('Fine SMD pencil', 'Тонкий паяльник для SMD'),
      values: {
        gripDiameter: 14,
        gripLength: 78,
        barrelLength: 34,
        tipLength: 22,
        tipStyle: 'bevel',
        gripMaterial: 'plastic',
        gripColor: '#2b2c2f',
      },
    },
    {
      id: 'station-white',
      label: L('White station with stand', 'Белая станция со стойкой'),
      values: {
        form: 'station',
        gripDiameter: 18,
        gripLength: 98,
        barrelLength: 46,
        tipLength: 17,
        tipStyle: 'chisel',
        gripMaterial: 'silicone',
        gripColor: '#26272a',
        bodyColor: '#ece9e2',
        panelColor: '#1b1c1e',
      },
    },
    {
      id: 'station-dark',
      label: L('Dark station with stand', 'Тёмная станция со стойкой'),
      values: {
        form: 'station',
        gripDiameter: 20,
        gripLength: 96,
        barrelLength: 48,
        tipLength: 18,
        tipStyle: 'bevel',
        gripMaterial: 'plastic',
        gripColor: '#c8262b',
        bodyColor: '#34363a',
        panelColor: '#0f1012',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const iron = buildIron(p, ctx);
    const rg = iron.gripRadius;
    const cordSides = ctx.seg(16, 8);
    const cordMat = rubber('#18191b', 'smooth', 'cord');

    if (p.form === 'pencil') {
      const parts: Part[] = [
        part(
          'cord',
          'cord',
          cordMat,
          tube(
            [
              [0, 0, 0],
              [0, 26, 0],
            ],
            2.3,
            { sides: cordSides },
          ),
        ),
        ...iron.parts,
      ];
      const yEnd = iron.yTip;
      return {
        parts,
        hang: { point: [0, iron.yGrip, 0], kind: 'neck' },
        zones: [
          { name: 'cord', y0: 0, y1: iron.yGripStart },
          { name: 'grip', y0: iron.yGripStart, y1: iron.yGrip },
          { name: 'sleeve', y0: iron.yGrip, y1: yEnd - p.tipLength },
          { name: 'tip', y0: yEnd - p.tipLength, y1: yEnd },
        ],
        dims: {
          length: yEnd,
          gripDiameter: p.gripDiameter,
          gripLength: p.gripLength,
          sleeveDiameter: clamp(rg * 0.27, 3.6, 6.2) * 2,
          tipLength: p.tipLength,
        },
      };
    }

    // ---- station form ----
    const W = 100;
    const D = 112;
    const H = 104;
    const Hf = 22;
    const slopeRun = 32;
    const theta = (Math.atan2(slopeRun, H - Hf) * 180) / Math.PI;
    const Ls = Math.hypot(slopeRun, H - Hf);
    const parts: Part[] = [];
    const bodyOutline = roundLoop(
      [
        [-D / 2, 0, 5],
        [D / 2, 0, 5],
        [D / 2, Hf, 4],
        [D / 2 - slopeRun, H, 6],
        [-D / 2, H, 5],
      ],
      ctx.seg(4, 2),
    );
    parts.push(
      part(
        'station-body',
        'body',
        plastic(p.bodyColor, 0.45, 'station housing'),
        slabX(bodyOutline, -W / 2, W / 2, { bevel: 2 }),
        50,
      ),
    );
    for (const item of panelItems(W, Ls, p.panelColor, ctx)) {
      parts.push(
        part(
          item.name,
          item.role,
          item.material,
          place(item.mesh, rotX(-theta), at(0, Hf, D / 2)),
          40,
        ),
      );
    }

    // stand with the iron resting in it
    const alpha = 62;
    const sa = Math.sin((alpha * Math.PI) / 180);
    const ca = Math.cos((alpha * Math.PI) / 180);
    const xo = W / 2 + 14;
    const yo = 32;
    const restS = 46;
    const coilS = iron.yTip - 10;
    const restX = xo + restS * sa;
    const restY = yo + restS * ca;
    const coilX = xo + coilS * sa;
    const coilY = yo + coilS * ca;
    const baseX0 = restX - 24;
    const baseX1 = coilX + 26;
    const baseCx = (baseX0 + baseX1) / 2;
    parts.push(
      part(
        'stand-base',
        'body',
        plastic(p.panelColor, 0.4, 'stand base'),
        slabY(rrect(baseCx, 0, baseX1 - baseX0, 78, 7, 4), 0, 8, { bevel: 1.6 }),
        50,
      ),
    );
    const post = (x: number, yTop: number, r: number): Mesh =>
      place(
        lathe(
          [
            [r, 6],
            [r, yTop],
          ],
          ctx.seg(20, 10),
        ),
        at(x, 0, 0),
      );
    parts.push(part('stand-post', 'body', METALS.steel, post(coilX, coilY - 8, 3.2)));
    parts.push(
      part(
        'stand-rest',
        'body',
        plastic(p.panelColor, 0.4, 'stand rest'),
        place(
          box(18, restY - rg * 0.95 - 8 + 6, 26, 3, 2),
          at(restX, 8 + (restY - rg * 0.95 - 8 + 6) / 2 - 6, 0),
        ),
      ),
    );
    const coil = tube(helix(rg * 0.56 + 6.5, coilS - 16, 4.6, 6, ctx.seg(18, 10)), 1.1, {
      sides: ctx.seg(8, 5),
    });
    parts.push(
      part('stand-coil', 'body', METALS.polishedSteel, place(coil, rotZ(-alpha), at(xo, yo, 0))),
    );
    parts.push(
      part(
        'sponge',
        'body',
        rubber('#e5c040', 'smooth', 'cleaning sponge'),
        place(box(26, 16, 26, 2.5, 2), at(baseCx + (restX - coilX) * 0.5 - 10, 16, 24)),
      ),
    );
    // iron parts transformed into the stand
    const T = (m: Mesh): Mesh => place(m, rotZ(-alpha), at(xo, yo, 0));
    for (const ip of iron.parts) parts.push({ ...ip, mesh: T(ip.mesh) });
    // cord: from inside the boot along the axis, then down and into the station wall
    const wp = (y: number): V3 => [xo + y * sa, yo + y * ca, 0];
    const cordPath = roundedPath(
      [wp(24), wp(0), wp(-10), [W / 2 + 12, yo - 18, 0], [W / 2 - 3, 14, 0]],
      9,
      ctx.seg(8, 4),
    );
    parts.push(part('cord', 'cord', cordMat, tube(cordPath, 2.3, { sides: cordSides })));

    const tipTopY = yo + iron.yTip * ca;
    const yTop = Math.max(H + 1, tipTopY + 4);
    return {
      parts,
      hang: { point: [0, H, 0], kind: 'body' },
      zones: [
        { name: 'station', y0: 0, y1: H },
        { name: 'stand', y0: H, y1: yTop },
      ],
      dims: {
        length: yTop,
        stationWidth: W,
        stationDepth: D,
        stationHeight: H,
        gripDiameter: p.gripDiameter,
        tipLength: p.tipLength,
      },
    };
  },
});
