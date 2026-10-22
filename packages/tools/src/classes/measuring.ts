/**
 * Measuring and marking tools: steel rule, combination / try / framing square, spirit level, tape
 * measure, digital vernier caliper. All flat tools lie in the XY plane (thin in Z), axis +Y.
 * Sizes: DIN 866 steel rules (150..1000 x 12..30 x 0.5..1 mm), 300 mm combination square (blade 25 x
 * 2.5 mm, cast head ~100 mm), 400 x 600 mm framing square, DIN 876 caliper 150/200/300 mm (a 150 mm
 * digital caliper is ~239 mm long, as in the HSW carpet photo), tape cases measured in HSW
 * (refit/scene_extra_tools.py: ~71 x 61 x 34 mm for the 5 m tape), alu box-profile levels 60 x 25 mm.
 */
import { type V2, clamp } from '../math.ts';
import { type Mesh, boundsOf, mergeBounds, mergeMeshes } from '../mesh.ts';
import {
  at,
  extrude,
  insetLoop,
  loft,
  lathe,
  place,
  rotX,
  rotY,
  rotZ,
  torus,
} from '../build/primitives.ts';
import { flutedRing } from '../build/rings.ts';
import {
  type Rect,
  ellipseLoop,
  linearScale,
  loopRotate,
  loopMove,
  placeText,
  rectLoop,
  roundPolygon,
  roundedRectLoop,
  slabs,
} from '../build/flat.ts';
import {
  METALS,
  type Material,
  SCREEN,
  paint,
  plastic,
  rubber,
  translucentPlastic,
  wood,
} from '../materials.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass, type BuildCtx } from '../registry.ts';

const INK = paint('#17181a', 0.6, 'graduation ink');
const INK_Z = 0.05;

/** Marks lie on top of the surface at zTop and stand 0.05 mm proud (embedded 0.02 mm to avoid gaps). */
function marksPart(
  name: string,
  rects: readonly Rect[],
  zTop: number,
  material: Material = INK,
): Part[] {
  if (rects.length === 0) return [];
  return [
    { name, role: 'marks', material, mesh: slabs(rects, zTop - 0.02, zTop + INK_Z), crease: 20 },
  ];
}

// ---------------------------------------------------------------------------------------------
// ruler-steel
// ---------------------------------------------------------------------------------------------

const rulerSchema = {
  length: num(L('Length', 'Длина'), 300, 100, 1000, { step: 1 }),
  width: num(L('Width', 'Ширина'), 30, 10, 50, { step: 0.5 }),
  thickness: num(L('Thickness', 'Толщина'), 1, 0.4, 3, { step: 0.1 }),
  finish: choice(L('Finish', 'Покрытие'), ['satin', 'polished', 'black'] as const, 'satin'),
  hangHole: choice(L('Hang hole', 'Отверстие для подвеса'), ['yes', 'no'] as const, 'yes'),
};

defineToolClass({
  id: 'ruler-steel',
  family: 'measuring',
  name: L('Steel ruler', 'Стальная линейка'),
  bankClass: 'ruler',
  keywords: {
    en: ['steel ruler', 'steel rule', 'metal ruler', 'ruler', 'straight edge'],
    ru: ['стальная линейка', 'металлическая линейка', 'линейка'],
  },
  schema: rulerSchema,
  presets: [
    {
      id: 'rule-150',
      label: L('150 mm rule', 'Линейка 150 мм'),
      values: { length: 150, width: 19 },
    },
    { id: 'rule-300', label: L('300 mm rule', 'Линейка 300 мм'), values: {} },
    {
      id: 'rule-500',
      label: L('500 mm rule', 'Линейка 500 мм'),
      values: { length: 500, width: 30, thickness: 1 },
    },
    {
      id: 'rule-1000',
      label: L('1 m rule', 'Линейка 1 м'),
      values: { length: 1000, width: 35, thickness: 1.2 },
    },
    {
      id: 'rule-300-polished',
      label: L('300 mm polished', 'Линейка 300 мм, полированная'),
      values: { finish: 'polished', width: 25 },
    },
  ],
  build(p, ctx): BuiltTool {
    const { length: Lr, width: W, thickness: T } = p;
    const holeY = Lr - Math.min(9, W * 0.4);
    const holes = p.hangHole === 'yes' ? [ellipseLoop(2.3, 2.3, ctx.seg(20, 10), 0, holeY)] : [];
    const outline = roundedRectLoop(-W / 2, 0, W / 2, Lr, Math.min(1.2, W / 4), ctx.seg(3, 1));
    const material =
      p.finish === 'polished'
        ? METALS.polishedSteel
        : p.finish === 'black'
          ? METALS.blackOxide
          : METALS.steel;
    const parts: Part[] = [
      {
        name: 'blade',
        role: 'blade',
        material,
        mesh: extrude(outline, -T / 2, T / 2, { holes, bevel: Math.min(0.15, T / 3) }),
        crease: 35,
      },
    ];
    if (ctx.detail) {
      // tick lengths shrink on narrow rules so they stay clear of the hang hole
      const k = Math.min(1, W / 27);
      const rects: Rect[] = linearScale({
        axis: 'y',
        origin: 0.6,
        dir: 1,
        length: Lr - 1.5,
        edge: -W / 2 + 0.3,
        inward: 1,
        numbers: W >= 14 ? Math.min(3.6, W * 0.16) : 0,
        numbersUpTo: Lr - 16,
        lens: [2.6 * k, 4 * k, 6 * k],
      });
      if (Lr <= 400 && W >= 18)
        rects.push(
          ...linearScale({
            axis: 'y',
            origin: 0.6,
            dir: 1,
            length: Lr - 1.5,
            step: 0.5,
            edge: W / 2 - 0.3,
            inward: -1,
            lens: [1.6, 2.4, 3.6],
          }),
        );
      parts.push(...marksPart('graduations', rects, T / 2));
    }
    return {
      parts,
      hang:
        p.hangHole === 'yes'
          ? { point: [0, holeY, 0], kind: 'hole', diameterMm: 4.6 }
          : { point: [0, Lr, 0], kind: 'butt' },
      zones: [{ name: 'blade', y0: 0, y1: Lr }],
      dims: { length: Lr, width: W, thickness: T },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// square-try: combination square, try (engineer's / carpenter's) square, framing square
// ---------------------------------------------------------------------------------------------

const squareSchema = {
  style: choice(L('Style', 'Тип'), ['combination', 'try', 'framing'] as const, 'combination'),
  bladeLength: num(L('Blade length', 'Длина линейки'), 300, 100, 600, { step: 1 }),
  bladeWidth: num(L('Blade width', 'Ширина линейки'), 25, 15, 50, { step: 0.5 }),
  bladeThickness: num(L('Blade thickness', 'Толщина линейки'), 2.5, 1.2, 4, { step: 0.1 }),
  headLength: num(L('Head / stock / tongue length', 'Длина головки / колодки'), 100, 60, 420, {
    step: 1,
  }),
  headHeight: num(L('Head height', 'Высота головки'), 36, 12, 50, { step: 0.5 }),
  headThickness: num(L('Head thickness', 'Толщина головки'), 18, 6, 30, { step: 0.5 }),
  headColor: color(L('Head colour', 'Цвет головки'), '#25272b'),
  stock: choice(L('Try square stock', 'Колодка угольника'), ['wood', 'steel'] as const, 'wood'),
};

defineToolClass({
  id: 'square-try',
  family: 'measuring',
  name: L('Combination / try square', 'Угольник'),
  bankClass: 'ruler',
  keywords: {
    en: [
      'combination square',
      'try square',
      'framing square',
      'carpenter square',
      'square',
      'set square',
    ],
    ru: ['угольник', 'комбинированный угольник', 'столярный угольник', 'малка'],
  },
  schema: squareSchema,
  presets: [
    {
      id: 'combination-300',
      label: L('Combination square 300 mm', 'Комбинированный угольник 300 мм'),
      values: {},
    },
    {
      id: 'combination-150',
      label: L('Combination square 150 mm', 'Комбинированный угольник 150 мм'),
      values: {
        bladeLength: 150,
        bladeWidth: 19,
        bladeThickness: 1.8,
        headLength: 76,
        headHeight: 28,
        headThickness: 14,
        headColor: '#c8262b',
      },
    },
    {
      id: 'try-wood-250',
      label: L('Wooden try square 250 mm', 'Столярный угольник с деревянной колодкой'),
      values: {
        style: 'try',
        bladeLength: 250,
        bladeWidth: 26,
        bladeThickness: 2.2,
        headLength: 130,
        headHeight: 26,
        headThickness: 22,
        headColor: '#6b3d22',
        stock: 'wood',
      },
    },
    {
      id: 'engineer-square-150',
      label: L('Engineer square 150 mm', 'Слесарный угольник 150 мм'),
      values: {
        style: 'try',
        bladeLength: 150,
        bladeWidth: 18,
        bladeThickness: 3,
        headLength: 100,
        headHeight: 12,
        headThickness: 6,
        stock: 'steel',
      },
    },
    {
      id: 'framing-600',
      label: L('Framing square 600 x 400', 'Плотницкий угольник 600 x 400'),
      values: {
        style: 'framing',
        bladeLength: 600,
        bladeWidth: 40,
        bladeThickness: 1.8,
        headLength: 400,
        headHeight: 25,
        headThickness: 6,
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const { bladeLength: BL, bladeWidth: BW, bladeThickness: BT } = p;
    const HL = Math.max(p.headLength, p.style === 'combination' ? BW + 45 : BW + 12);
    const HH = p.headHeight;
    const HT = Math.max(p.headThickness, BT + 2);
    const bladeMat = METALS.steel;
    const parts: Part[] = [];
    const holeY = BL - Math.min(8, BW * 0.4);

    if (p.style === 'framing') {
      const tongueW = Math.min(HH, BW * 0.65);
      const half = BW / 2;
      const leg = Math.max(HL, BW + 20);
      const outline = roundPolygon(
        [
          [-half, 0],
          [-half + leg, 0],
          [-half + leg, tongueW],
          [half, tongueW],
          [half, BL],
          [-half, BL],
        ],
        0.6,
        ctx.seg(3, 1),
      );
      parts.push({
        name: 'blade',
        role: 'blade',
        material: bladeMat,
        mesh: extrude(outline, -BT / 2, BT / 2, {
          holes: [ellipseLoop(2.6, 2.6, ctx.seg(20, 10), 0, holeY)],
          bevel: Math.min(0.15, BT / 3),
        }),
        crease: 35,
      });
      if (ctx.detail) {
        const rects: Rect[] = [
          ...linearScale({
            axis: 'y',
            origin: tongueW,
            dir: 1,
            length: BL - tongueW - 12,
            edge: -half + 0.3,
            inward: 1,
            numbers: 4,
            numbersUpTo: BL - tongueW - 28,
          }),
          ...linearScale({
            axis: 'x',
            origin: -half + 0.5,
            dir: 1,
            length: leg - 1,
            edge: tongueW - 0.3,
            inward: -1,
            numbers: tongueW > 14 ? 3.4 : 0,
            numbersUpTo: leg - 14,
          }),
        ];
        parts.push(...marksPart('graduations', rects, BT / 2));
      }
      return {
        parts,
        hang: { point: [0, holeY, 0], kind: 'hole', diameterMm: 5 },
        zones: [
          { name: 'tongue', y0: 0, y1: tongueW },
          { name: 'blade', y0: tongueW, y1: BL },
        ],
        dims: {
          length: BL,
          bladeLength: BL,
          bladeWidth: BW,
          width: leg,
          thickness: BT,
          headLength: leg,
        },
      };
    }

    const yBlade0 = p.style === 'combination' ? 2 : 3;
    const bladeOutline = roundedRectLoop(-BW / 2, yBlade0, BW / 2, BL, 0.8, ctx.seg(3, 1));
    parts.push({
      name: 'blade',
      role: 'blade',
      material: bladeMat,
      mesh: extrude(bladeOutline, -BT / 2, BT / 2, {
        holes: [ellipseLoop(2.2, 2.2, ctx.seg(20, 10), 0, holeY)],
        bevel: Math.min(0.15, BT / 3),
      }),
      crease: 35,
    });
    if (ctx.detail) {
      const rects: Rect[] = linearScale({
        axis: 'y',
        origin: HH,
        dir: 1,
        length: BL - HH - 10,
        edge: -BW / 2 + 0.3,
        inward: 1,
        numbers: Math.min(3.4, BW * 0.15),
        numbersUpTo: BL - HH - 24,
        lens: [2.6, 4, 6],
      });
      if (BL <= 320)
        rects.push(
          ...linearScale({
            axis: 'y',
            origin: HH,
            dir: 1,
            length: BL - HH - 10,
            step: 0.5,
            edge: BW / 2 - 0.3,
            inward: -1,
            lens: [1.6, 2.4, 3.6],
          }),
        );
      parts.push(...marksPart('graduations', rects, BT / 2));
    }

    if (p.style === 'combination') {
      const cast = paint(p.headColor, 0.5, 'enamelled casting');
      const slotHalf = BW / 2 + 7;
      const left = -0.45 * HL;
      const right = 0.55 * HL;
      const chamferY = Math.max(3, HH - (-left - slotHalf));
      const outline = roundPolygon(
        [
          [left, 0],
          [right, 0],
          [right, HH * 0.3],
          [slotHalf, HH],
          [-slotHalf, HH],
          [left, chamferY],
        ],
        3,
        ctx.seg(5, 2),
      );
      const vialX = HL * 0.3;
      const halfLen = clamp(HL * 0.12, 6, 12);
      const topAt = (x: number): number =>
        x >= slotHalf ? HH * 0.3 + ((right - x) / (right - slotHalf)) * HH * 0.7 : HH;
      const yTopMax = topAt(vialX + halfLen) - 1.8;
      const halfH = clamp((yTopMax - 1.6) / 2, 1.8, 4.2);
      const vialY = Math.min(Math.max(HH * 0.28, 1.6 + halfH), yTopMax - halfH);
      const vialR = Math.min(3.3, halfH - 0.9);
      const window = roundedRectLoop(
        vialX - halfLen,
        vialY - halfH,
        vialX + halfLen,
        vialY + halfH,
        Math.min(1.6, halfH - 0.2),
        ctx.seg(3, 1),
      );
      parts.push({
        name: 'head',
        role: 'head',
        material: cast,
        mesh: extrude(outline, -HT / 2, HT / 2, { holes: [window], bevel: 0.8 }),
        crease: 40,
      });
      parts.push({
        name: 'vial',
        role: 'vial',
        material: translucentPlastic('#c8e87a', 0.55, 'spirit vial'),
        mesh: place(
          lathe(
            [
              [vialR * 0.88, -halfLen + 0.5],
              [vialR, -halfLen + 2],
              [vialR, halfLen - 2],
              [vialR * 0.88, halfLen - 0.5],
            ],
            ctx.seg(16, 8),
          ),
          rotZ(90),
          at(vialX, vialY, 0),
        ),
      });
      parts.push({
        name: 'bubble',
        role: 'vial',
        material: plastic('#f4f6ee', 0.2, 'bubble'),
        mesh: place(
          lathe(
            [
              [0, -halfLen * 0.2],
              [vialR * 0.5, -halfLen * 0.12],
              [vialR * 0.5, halfLen * 0.12],
              [0, halfLen * 0.2],
            ],
            ctx.seg(12, 6),
          ),
          rotZ(90),
          at(vialX + 1, vialY, 0),
        ),
      });
      // knurled locking nut on the front face
      const nutR = Math.min(7.5, HH * 0.22 + 2);
      parts.push({
        name: 'lock-nut',
        role: 'knob',
        material: METALS.blackOxide,
        mesh: place(
          loft([
            { y: 0, ring: flutedRing(nutR, ctx.seg(14, 6), 0.5, ctx.seg(112, 36)) },
            { y: 6.5, ring: flutedRing(nutR, ctx.seg(14, 6), 0.5, ctx.seg(112, 36)) },
          ]),
          rotX(90),
          at(0, HH * 0.6, HT / 2 - 0.3),
        ),
        crease: 30,
      });
      // scribe pin
      const pinX = slotHalf - 2.6;
      parts.push({
        name: 'scribe',
        role: 'scribe',
        material: METALS.polishedSteel,
        mesh: place(
          lathe(
            [
              [0, HH + 14],
              [0.45, HH + 12],
              [0.9, HH + 5],
              [0.9, HH - 2],
              [0, HH - 2],
            ],
            ctx.seg(10, 6),
          ),
          at(pinX, 0, 0),
        ),
      });
      return {
        parts,
        hang: { point: [0, holeY, 0], kind: 'hole', diameterMm: 4.4 },
        zones: [
          { name: 'head', y0: 0, y1: HH },
          { name: 'blade', y0: HH, y1: BL },
        ],
        dims: {
          length: BL,
          bladeLength: BL,
          bladeWidth: BW,
          width: HL,
          thickness: HT,
          headLength: HL,
          headHeight: HH,
        },
      };
    }

    // try square: L shaped, stock on one side of the blade
    const x0 = -BW / 2 - 4;
    const x1 = x0 + HL;
    const stockOutline = roundedRectLoop(
      x0,
      0,
      x1,
      HH,
      p.stock === 'wood' ? 2.5 : 0.8,
      ctx.seg(4, 2),
    );
    const stockMat: Material =
      p.stock === 'wood' ? { ...wood('walnut', 0.45), color: p.headColor } : METALS.darkSteel;
    parts.push({
      name: 'stock',
      role: 'head',
      material: stockMat,
      mesh: extrude(stockOutline, -HT / 2, HT / 2, { bevel: Math.min(1, HT / 4) }),
      crease: 40,
    });
    if (p.stock === 'wood') {
      parts.push({
        name: 'brass-facing',
        role: 'facing',
        material: METALS.brass,
        mesh: extrude(rectLoop(x0 + 1, HH - 0.4, x1 - 1, HH + 1.4), -HT / 2 + 0.4, HT / 2 - 0.4),
      });
      const rivets = [0.18, 0.5, 0.82].map((u) =>
        place(
          lathe(
            [
              [0, 0],
              [1.9, 0],
              [1.9, 0.5],
              [1.4, 1.0],
              [0, 1.0],
            ],
            ctx.seg(12, 6),
          ),
          rotX(90),
          at(x0 + (x1 - x0) * u, HH * 0.5, HT / 2 - 0.2),
        ),
      );
      parts.push({
        name: 'rivets',
        role: 'fastener',
        material: METALS.brass,
        mesh: mergeMeshes(rivets),
      });
    }
    return {
      parts,
      hang: { point: [0, holeY, 0], kind: 'hole', diameterMm: 4.4 },
      zones: [
        { name: 'stock', y0: 0, y1: HH },
        { name: 'blade', y0: HH, y1: BL },
      ],
      dims: {
        length: BL,
        bladeLength: BL,
        bladeWidth: BW,
        width: HL + 4,
        thickness: HT,
        headLength: HL,
        headHeight: HH,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// spirit-level: aluminium box-profile level and torpedo level
// ---------------------------------------------------------------------------------------------

const levelSchema = {
  style: choice(L('Style', 'Тип'), ['box', 'torpedo'] as const, 'box'),
  length: num(L('Length', 'Длина'), 600, 150, 1200, { step: 5 }),
  width: num(L('Profile height', 'Высота профиля'), 60, 28, 80, { step: 0.5 }),
  thickness: num(L('Profile thickness', 'Толщина профиля'), 25, 14, 40, { step: 0.5 }),
  vials: num(L('Vials', 'Колбы'), 3, 1, 3, { step: 1, unit: 'count', dimension: false }),
  handHoles: num(L('Hand holes', 'Отверстия для руки'), 2, 0, 2, {
    step: 1,
    unit: 'count',
    dimension: false,
  }),
  bodyColor: color(L('Body colour', 'Цвет корпуса'), '#e2b114'),
  capColor: color(L('End cap colour', 'Цвет заглушек'), '#1b1c1e'),
};

function vialMeshes(
  cx: number,
  cy: number,
  angle: number,
  len: number,
  r: number,
  ctx: BuildCtx,
): { vial: Mesh; bubble: Mesh } {
  const seg = ctx.seg(20, 10);
  const place2 = (m: Mesh): Mesh => place(m, rotZ(angle), at(cx, cy, 0));
  const vial = lathe(
    [
      [r * 0.7, -len / 2],
      [r, -len / 2 + r * 0.3],
      [r, len / 2 - r * 0.3],
      [r * 0.7, len / 2],
    ],
    seg,
  );
  const bl = Math.max(len * 0.1, 2.5);
  const bubble = lathe(
    [
      [0, -bl - 0.6],
      [r * 0.55, -bl * 0.5],
      [r * 0.6, 0],
      [r * 0.55, bl * 0.5],
      [0, bl + 0.6],
    ],
    ctx.seg(14, 8),
  );
  return {
    vial: place2(vial),
    bubble: place(bubble, at(0, len * 0.04, 0), rotZ(angle), at(cx, cy, 0)),
  };
}

defineToolClass({
  id: 'spirit-level',
  family: 'measuring',
  name: L('Spirit level', 'Уровень'),
  bankClass: 'ruler',
  keywords: {
    en: ['spirit level', 'bubble level', 'torpedo level', 'level', 'carpenter level'],
    ru: ['уровень', 'строительный уровень', 'пузырьковый уровень', 'ватерпас'],
  },
  schema: levelSchema,
  presets: [
    {
      id: 'level-600',
      label: L('Box level 600 mm', 'Уровень 600 мм'),
      values: {},
    },
    {
      id: 'level-1200',
      label: L('Box level 1200 mm', 'Уровень 1200 мм'),
      values: { length: 1200, width: 70, thickness: 28, bodyColor: '#c8262b' },
    },
    {
      id: 'level-400',
      label: L('Box level 400 mm', 'Уровень 400 мм'),
      values: {
        length: 400,
        width: 50,
        thickness: 22,
        vials: 2,
        handHoles: 0,
        bodyColor: '#2455a8',
      },
    },
    {
      id: 'level-300-compact',
      label: L('Compact level 300 mm', 'Уровень 300 мм'),
      values: {
        length: 300,
        width: 44,
        thickness: 20,
        vials: 2,
        handHoles: 0,
        bodyColor: '#2f8f4c',
      },
    },
    {
      id: 'torpedo-230',
      label: L('Torpedo level 230 mm', 'Уровень-торпеда 230 мм'),
      values: {
        style: 'torpedo',
        length: 230,
        width: 42,
        thickness: 22,
        vials: 3,
        handHoles: 0,
        bodyColor: '#e2b114',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const Lv = p.length;
    const W = p.width;
    const T = p.thickness;
    const half = W / 2;
    const capLen = 12;
    const y0 = 1;
    const y1 = Lv - 1;
    const endHalf = p.style === 'torpedo' ? half * 0.6 : half;
    const bodyMat: Material = {
      name: 'anodised aluminium',
      kind: 'metal',
      color: p.bodyColor,
      metallic: 0.45,
      roughness: 0.36,
      alpha: 1,
    };
    const outline =
      p.style === 'torpedo'
        ? roundPolygon(
            [
              [-endHalf, y0],
              [endHalf, y0],
              [endHalf, Lv * 0.14],
              [half, Lv * 0.32],
              [half, Lv * 0.68],
              [endHalf, Lv * 0.86],
              [endHalf, y1],
              [-endHalf, y1],
              [-endHalf, Lv * 0.86],
              [-half, Lv * 0.68],
              [-half, Lv * 0.32],
              [-endHalf, Lv * 0.14],
            ],
            3,
            ctx.seg(4, 2),
          )
        : roundedRectLoop(-half, y0, half, y1, 1.6, ctx.seg(3, 1));

    interface VialSpec {
      y: number;
      angle: number;
      len: number;
      r: number;
    }
    const mid = Lv / 2;
    const dP = Math.max(clamp(Lv * 0.16, 40, 90), clamp(W * 0.8, 38, 66) / 2 + 16);
    const vr = Math.min(clamp(W * 0.085, 3.4, 6), T * 0.2);
    const plumbLen = Math.min(W * 0.55, 36);
    const specs: VialSpec[] = [
      { y: mid, angle: 0, len: clamp(W * 0.8, 38, 66), r: vr },
      { y: mid + dP, angle: 90, len: plumbLen, r: vr * 0.92 },
    ];
    if (p.vials >= 3)
      specs.push(
        p.style === 'torpedo'
          ? { y: mid - dP, angle: 45, len: 22, r: 3.4 }
          : { y: mid - dP, angle: 90, len: plumbLen, r: vr * 0.92 },
      );
    const active = p.vials >= 2 ? specs : specs.slice(0, 1);
    /** Vial window outline, rotated to the vial angle and moved to its place along the body. */
    const vialWindow = (v: VialSpec, grow: number): V2[] => {
      const w = roundedRectLoop(
        -v.r - 1.1 - grow,
        -v.len / 2 - 1 - grow,
        v.r + 1.1 + grow,
        v.len / 2 + 1 + grow,
        v.r + 1.1,
        ctx.seg(4, 2),
      );
      return loopMove(loopRotate(w, v.angle), 0, v.y);
    };
    const holes: V2[][] = active.map((v) => vialWindow(v, 0));

    const handCount = Lv >= 450 && p.style === 'box' ? p.handHoles : 0;
    const handY: number[] = [];
    if (handCount >= 1) handY.push(mid + Math.max(130, Lv * 0.3));
    if (handCount >= 2) handY.push(mid - Math.max(130, Lv * 0.3));
    const hl = Math.min(45, Lv * 0.12);
    const hw = Math.min(13, W * 0.19);
    for (const y of handY) holes.push(roundedRectLoop(-hw, y - hl, hw, y + hl, hw, ctx.seg(6, 3)));

    const parts: Part[] = [
      {
        name: 'body',
        role: 'body',
        material: bodyMat,
        mesh: extrude(outline, -T / 2, T / 2, { holes, bevel: Math.min(1.2, T * 0.06) }),
        crease: 35,
      },
    ];
    const capMat = rubber(p.capColor, 'soft-grip', 'rubber end cap');
    const capOutline = (ya: number, yb: number): V2[] =>
      roundedRectLoop(-endHalf - 0.9, ya, endHalf + 0.9, yb, 2.2, ctx.seg(3, 1));
    parts.push({
      name: 'cap-bottom',
      role: 'cap',
      material: capMat,
      mesh: extrude(capOutline(0, capLen), -T / 2 - 0.8, T / 2 + 0.8, { bevel: 1 }),
      crease: 35,
    });
    parts.push({
      name: 'cap-top',
      role: 'cap',
      material: capMat,
      mesh: extrude(capOutline(Lv - capLen, Lv), -T / 2 - 0.8, T / 2 + 0.8, { bevel: 1 }),
      crease: 35,
    });

    const vials: Mesh[] = [];
    const bubbles: Mesh[] = [];
    const frames: Mesh[] = [];
    for (const v of active) {
      const m = vialMeshes(0, v.y, v.angle, v.len, v.r, ctx);
      vials.push(m.vial);
      bubbles.push(m.bubble);
      frames.push(
        extrude(vialWindow(v, 2.2), -T / 2 - 0.35, T / 2 + 0.35, {
          holes: [vialWindow(v, 0)],
        }),
      );
    }
    parts.push({
      name: 'vial-frames',
      role: 'vial',
      material: plastic('#f1efe6', 0.4, 'vial surround'),
      mesh: mergeMeshes(frames),
    });
    parts.push({
      name: 'vials',
      role: 'vial',
      material: translucentPlastic('#d6f05a', 0.5, 'spirit vial'),
      mesh: mergeMeshes(vials),
    });
    parts.push({
      name: 'bubbles',
      role: 'vial',
      material: plastic('#fbfcf4', 0.15, 'bubble'),
      mesh: mergeMeshes(bubbles),
    });
    if (ctx.detail && p.style === 'box') {
      // flange grooves on both faces
      const stripes: Rect[] = [];
      for (const s of [-1, 1])
        stripes.push([s * (half - 3.6), capLen + 2, s * (half - 2.4), Lv - capLen - 2]);
      parts.push(
        ...marksPart('flange-lines', stripes, T / 2 + 0.35, paint('#2b2c2e', 0.5, 'groove')),
      );
    }
    const hang =
      handY.length > 0
        ? ({ point: [0, handY[0] ?? mid, 0], kind: 'hole', diameterMm: hw * 2 } as const)
        : ({ point: [0, Lv / 2, 0], kind: 'body' } as const);
    return {
      parts,
      hang,
      zones: [
        { name: 'cap-bottom', y0: 0, y1: capLen },
        { name: 'body', y0: capLen, y1: Lv - capLen },
        { name: 'cap-top', y0: Lv - capLen, y1: Lv },
      ],
      dims: {
        length: Lv,
        width: W + 1.8,
        thickness: T + 1.6,
        vialCount: active.length,
        handHoleCount: handY.length,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// tape-measure: rounded case, over-mould bumper, belt clip, lock slider, curved graduated tape + hook
// ---------------------------------------------------------------------------------------------

const tapeSchema = {
  caseWidth: num(L('Case width', 'Ширина корпуса'), 71, 50, 95, { step: 0.5 }),
  caseHeight: num(L('Case height', 'Высота корпуса'), 62, 45, 90, { step: 0.5 }),
  caseDepth: num(L('Case depth', 'Толщина корпуса'), 32, 20, 50, { step: 0.5 }),
  tapeWidth: num(L('Tape width', 'Ширина ленты'), 19, 10, 32, { step: 0.5 }),
  tapeOut: num(L('Tape pulled out', 'Вытянутая лента'), 80, 0, 600, { step: 5 }),
  caseColor: color(L('Case colour', 'Цвет корпуса'), '#1b1c1e'),
  bumperColor: color(L('Bumper colour', 'Цвет обрезинки'), '#c8262b'),
  tapeColor: color(L('Tape colour', 'Цвет ленты'), '#f1c21b'),
  beltClip: choice(L('Belt clip', 'Клипса'), ['yes', 'no'] as const, 'yes'),
};

defineToolClass({
  id: 'tape-measure',
  family: 'measuring',
  name: L('Tape measure', 'Рулетка'),
  bankClass: 'tape-measure',
  keywords: {
    en: ['tape measure', 'measuring tape', 'retractable tape measure', 'steel tape'],
    ru: ['рулетка', 'измерительная рулетка', 'строительная рулетка'],
  },
  schema: tapeSchema,
  presets: [
    {
      id: 'tape-5m-black-red',
      label: L('5 m tape, black/red (HSW)', 'Рулетка 5 м, чёрная/красная'),
      values: {},
    },
    {
      id: 'tape-3m-compact',
      label: L('3 m compact tape', 'Рулетка 3 м'),
      values: {
        caseWidth: 60,
        caseHeight: 54,
        caseDepth: 26,
        tapeWidth: 16,
        tapeOut: 60,
        caseColor: '#c8262b',
        bumperColor: '#1b1c1e',
      },
    },
    {
      id: 'tape-8m-yellow',
      label: L('8 m tape, yellow', 'Рулетка 8 м, жёлтая'),
      values: {
        caseWidth: 82,
        caseHeight: 76,
        caseDepth: 40,
        tapeWidth: 25,
        tapeOut: 100,
        caseColor: '#f0c326',
        bumperColor: '#1b1c1e',
      },
    },
    {
      id: 'tape-5m-extended',
      label: L('5 m tape, 400 mm out', 'Рулетка 5 м, вытянута на 400 мм'),
      values: { tapeOut: 400, caseColor: '#2455a8', bumperColor: '#1b1c1e' },
    },
  ],
  build(p, ctx): BuiltTool {
    const W = p.caseWidth;
    const H = p.caseHeight;
    const D = p.caseDepth;
    const tw = Math.min(p.tapeWidth, D - 8, W * 0.62);
    const out = p.tapeOut;
    const arch = Math.min(1.1, tw * 0.07);
    const tapeTh = 0.3;
    const r = 0.18 * Math.min(W, H);
    const outline = roundPolygon(
      [
        [-W / 2, 0],
        [W / 2, 0],
        [W / 2, 0.78 * H],
        [0.36 * W, H],
        [-0.36 * W, H],
        [-W / 2, 0.78 * H],
      ],
      r,
      ctx.seg(8, 4),
    );
    const parts: Part[] = [];
    const bumperMat = rubber(p.bumperColor, 'soft-grip', 'rubber bumper');
    parts.push({
      name: 'case',
      role: 'body',
      material: plastic(p.caseColor, 0.4, 'case plastic'),
      mesh: extrude(insetLoop(outline, 0.5), -D / 2 + 0.9, D / 2 - 0.9, { bevel: 1 }),
      crease: 40,
    });
    parts.push({
      name: 'bumper',
      role: 'grip',
      material: bumperMat,
      mesh: extrude(outline, -D / 2, D / 2, {
        holes: [insetLoop(outline, 3.4)],
        bevel: 1.2,
      }),
      crease: 40,
    });
    // round badges on both faces
    const badgeR = 0.3 * Math.min(W, H);
    const badge = (z: number, dir: 1 | -1): Mesh =>
      extrude(
        ellipseLoop(badgeR, badgeR, ctx.seg(40, 18), 0, 0.46 * H),
        dir === 1 ? z : z - 0.9,
        dir === 1 ? z + 0.9 : z,
      );
    parts.push({
      name: 'badges',
      role: 'label',
      material: paint(p.bumperColor, 0.4, 'badge'),
      mesh: mergeMeshes([badge(D / 2 - 1, 1), badge(-D / 2 + 1, -1)]),
    });
    // mouth guard
    const aw = arch + 5;
    parts.push({
      name: 'mouth',
      role: 'nose',
      material: METALS.darkSteel,
      mesh: extrude(
        roundedRectLoop(-aw, H - 6, aw, H + 0.9, 1.2, ctx.seg(3, 1)),
        -tw / 2 - 2.4,
        tw / 2 + 2.4,
        {
          bevel: 0.4,
        },
      ),
      crease: 35,
    });
    // lock slider
    const lx = -0.27 * W;
    const lockMesh = extrude(
      roundedRectLoop(lx - 6, H - 3, lx + 6, H + 3.4, 1.8, ctx.seg(3, 1)),
      -D * 0.27,
      D * 0.27,
      {
        bevel: 0.7,
      },
    );
    parts.push({
      name: 'lock',
      role: 'button',
      material: rubber('#c8262b', 'ribbed', 'lock slider'),
      mesh: lockMesh,
      crease: 40,
    });
    // lanyard loop at the lower left corner
    const loopC: readonly [number, number] = [-W / 2 + 1.5, 6.5];
    parts.push({
      name: 'lanyard-loop',
      role: 'strap',
      material: plastic('#1b1c1e', 0.6, 'strap'),
      mesh: place(
        torus(4.2, 1.1, ctx.seg(20, 10), ctx.seg(8, 5)),
        rotX(90),
        at(loopC[0] - 3, loopC[1], 0),
      ),
    });
    // belt clip on the back
    if (p.beltClip === 'yes') {
      const zb = -D / 2 - 1.7;
      const yTop = 0.8 * H;
      const yBot = 0.14 * H;
      const stripSection: V2[] = [
        [-(zb - 1.1), yTop],
        [-(zb - 1.1), yBot],
        [-(zb + 1.5), yBot],
        [-(zb + 1.5), yBot + 1.2],
        [-zb, yBot + 1.2],
        [-zb, yTop],
      ];
      // profile x = -z, y = y; extrusion axis becomes +X after rotY(90)
      const clip = place(extrude(stripSection, -6.5, 6.5, { bevel: 0.3 }), rotY(90));
      const root = place(
        extrude(roundedRectLoop(D / 2 - 0.4, yTop - 9, -(zb - 1.1), yTop, 0.5, 2), -7, 7, {
          bevel: 0.2,
        }),
        rotY(90),
      );
      parts.push({
        name: 'belt-clip',
        role: 'clip',
        material: METALS.zinc,
        mesh: mergeMeshes([clip, root]),
        crease: 35,
      });
    }
    // tape
    const yMouth = H - 9;
    const yEnd = H + out;
    const n = ctx.seg(10, 5);
    const xAt = (z: number): number => -arch * (1 - ((2 * z) / tw) ** 2);
    const upper: V2[] = [];
    const lower: V2[] = [];
    for (let i = 0; i <= n; i++) {
      const z = -tw / 2 + (tw * i) / n;
      upper.push([xAt(z) + tapeTh / 2, -z]);
      lower.push([xAt(z) - tapeTh / 2, -z]);
    }
    const section = [...upper, ...lower.reverse()];
    const tapeMesh = place(extrude(section, yMouth, yEnd), rotX(-90));
    parts.push({
      name: 'tape',
      role: 'blade',
      material: paint(p.tapeColor, 0.42, 'tape blade'),
      mesh: tapeMesh,
      crease: 45,
    });
    // end hook
    const hookT = 1.1;
    const hookW = tw / 2 + 0.8;
    const hookSection = roundedRectLoop(-7.5, -hookW, 7.5, hookW, 1.2, ctx.seg(3, 1));
    const slot = roundedRectLoop(-0.9, -(hookW - 3.6), 0.9, hookW - 3.6, 0.85, ctx.seg(4, 2));
    parts.push({
      name: 'hook',
      role: 'hook',
      material: METALS.zinc,
      mesh: place(
        extrude(hookSection, 0, hookT, { holes: [slot], bevel: 0.2 }),
        rotX(-90),
        at(0, yEnd, 0),
      ),
      crease: 35,
    });
    parts.push({
      name: 'hook-rivets',
      role: 'fastener',
      material: METALS.steel,
      mesh: mergeMeshes(
        [-1, 1].map((s) =>
          place(
            lathe(
              [
                [0, 0],
                [1.5, 0],
                [1.5, 0.6],
                [1.0, 1.1],
                [0, 1.1],
              ],
              ctx.seg(10, 6),
            ),
            at(s * 5.4, yEnd + hookT, 0),
          ),
        ),
      ),
    });
    // graduations on the concave face
    if (ctx.detail && out > 20) {
      const rects = linearScale({
        axis: 'y',
        origin: yEnd - 0.4,
        dir: -1,
        length: out - 0.4,
        edge: -tw / 2 + 0.3,
        inward: 1,
        numbers: Math.min(5, tw * 0.28),
        lens: [2.6, 4.6, 6.4],
        numbersUpTo: out - 10,
        numberQuarter: 1,
      });
      // the tape is arched across its width: cut every mark into 1.6 mm strips that follow the surface
      const strips: Mesh[] = [];
      for (const [rx0, ry0, rx1, ry1] of rects) {
        const lo = Math.min(rx0, rx1);
        const hi = Math.max(rx0, rx1);
        const n = Math.max(1, Math.ceil((hi - lo) / 1.6));
        for (let i = 0; i < n; i++) {
          const a = lo + ((hi - lo) * i) / n;
          const b = lo + ((hi - lo) * (i + 1)) / n;
          const level = xAt(-(a + b) / 2) + tapeTh / 2;
          strips.push(slabs([[a, ry0, b, ry1]], level - 0.15, level + 0.12));
        }
      }
      parts.push({
        name: 'graduations',
        role: 'marks',
        material: INK,
        mesh: place(mergeMeshes(strips), rotY(90)),
        crease: 20,
      });
    }
    const bb = mergeBounds(parts.map((part) => boundsOf(part.mesh)));
    return {
      parts,
      hang: { point: [loopC[0] - 3, loopC[1], 0], kind: 'loop', diameterMm: 7 },
      zones: [
        { name: 'case', y0: 0, y1: H },
        { name: 'tape', y0: H, y1: yEnd + hookT },
      ],
      dims: {
        length: yEnd + hookT,
        caseWidth: W,
        caseHeight: H,
        caseDepth: D,
        width: W,
        thickness: bb.max[2] - bb.min[2],
        tapeWidth: tw,
        tapeOut: out,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// caliper: digital (LCD) or vernier slide caliper, 100..300 mm range
// ---------------------------------------------------------------------------------------------

const caliperSchema = {
  type: choice(L('Type', 'Тип'), ['digital', 'vernier'] as const, 'digital'),
  range: num(L('Measuring range', 'Диапазон измерения'), 150, 100, 300, { step: 50 }),
  opening: num(L('Jaw opening', 'Раскрытие губок'), 0, 0, 300, { step: 0.5 }),
  jawLength: num(L('Outside jaw length', 'Длина губок'), 38, 25, 60, { step: 0.5 }),
  beamWidth: num(L('Beam width', 'Ширина штанги'), 17, 13, 22, { step: 0.5 }),
  beamThickness: num(L('Beam thickness', 'Толщина штанги'), 4, 2.5, 6, { step: 0.1 }),
  housingColor: color(L('Housing colour', 'Цвет корпуса'), '#26282c'),
  buttonColor: color(L('Button colour', 'Цвет кнопок'), '#c8262b'),
};

defineToolClass({
  id: 'caliper',
  family: 'measuring',
  name: L('Caliper', 'Штангенциркуль'),
  bankClass: 'caliper',
  keywords: {
    en: ['caliper', 'digital caliper', 'vernier caliper', 'slide caliper', 'calipers'],
    ru: ['штангенциркуль', 'электронный штангенциркуль', 'цифровой штангенциркуль'],
  },
  schema: caliperSchema,
  presets: [
    {
      id: 'digital-150',
      label: L('Digital caliper 150 mm (239 mm long)', 'Электронный штангенциркуль 150 мм'),
      values: { opening: 23.45 },
    },
    {
      id: 'digital-150-closed',
      label: L('Digital caliper 150 mm, closed', 'Электронный 150 мм, закрыт'),
      values: { opening: 0, housingColor: '#2455a8' },
    },
    {
      id: 'digital-200',
      label: L('Digital caliper 200 mm', 'Электронный штангенциркуль 200 мм'),
      values: {
        range: 200,
        opening: 48.1,
        jawLength: 45,
        beamWidth: 19,
        housingColor: '#1b1c1e',
        buttonColor: '#e8741e',
      },
    },
    {
      id: 'digital-300',
      label: L('Digital caliper 300 mm', 'Электронный штангенциркуль 300 мм'),
      values: { range: 300, opening: 20, jawLength: 60, beamWidth: 22, beamThickness: 5 },
    },
    {
      id: 'vernier-150',
      label: L('Vernier caliper 150 mm', 'Штангенциркуль ШЦ-1 150 мм'),
      values: { type: 'vernier', opening: 18.2 },
    },
  ],
  build(p, ctx): BuiltTool {
    const range = p.range;
    const open = Math.min(p.opening, range);
    const xb = p.beamWidth / 2;
    const bt = p.beamThickness;
    const jl = p.jawLength;
    const Lb = range + 90;
    const yF = Lb - 14;
    const yS = yF - open;
    const sliderLen = 64;
    const ijl = 14;
    const digital = p.type === 'digital';
    const steel = digital ? METALS.polishedSteel : METALS.chrome;
    const parts: Part[] = [];

    const beamOutline = roundedRectLoop(-xb, 0, xb, Lb, 1.2, ctx.seg(3, 1));
    parts.push({
      name: 'beam',
      role: 'blade',
      material: steel,
      mesh: extrude(beamOutline, -bt / 2, bt / 2, { bevel: Math.min(0.3, bt / 6) }),
      crease: 35,
    });
    const outerFixed = roundPolygon(
      [
        [-xb + 0.5, yF],
        [-xb - jl, yF],
        [-xb - jl, yF + 2.4],
        [-xb - jl * 0.35, Lb],
        [-xb + 0.5, Lb],
      ],
      0.6,
      ctx.seg(3, 1),
    );
    const innerFixed = roundPolygon(
      [
        [xb - 0.5, yF],
        [xb + ijl, yF],
        [xb + ijl, yF + 6],
        [xb + ijl - 4, yF + 10],
        [xb - 0.5, yF + 10],
      ],
      0.5,
      ctx.seg(3, 1),
    );
    const jawZ = bt / 2;
    parts.push({
      name: 'fixed-jaw',
      role: 'jaw',
      material: steel,
      mesh: mergeMeshes([
        extrude(outerFixed, -jawZ, jawZ, { bevel: 0.25 }),
        extrude(innerFixed, -jawZ, jawZ, { bevel: 0.25 }),
      ]),
      crease: 35,
    });
    const outerSlide = roundPolygon(
      [
        [-xb + 0.5, yS],
        [-xb - jl, yS],
        [-xb - jl, yS - 2.4],
        [-xb - jl * 0.35, yS - 14],
        [-xb + 0.5, yS - 14],
      ],
      0.6,
      ctx.seg(3, 1),
    ).reverse();
    const innerSlide = roundPolygon(
      [
        [xb - 0.5, yS],
        [xb + ijl, yS],
        [xb + ijl, yS - 6],
        [xb + ijl - 4, yS - 10],
        [xb - 0.5, yS - 10],
      ],
      0.5,
      ctx.seg(3, 1),
    ).reverse();
    const carriage = roundedRectLoop(-xb - 2.8, yS - 30, xb + 2.8, yS, 1.2, ctx.seg(3, 1));
    parts.push({
      name: 'slider-jaw',
      role: 'jaw',
      material: steel,
      mesh: mergeMeshes([
        extrude(outerSlide, -jawZ, jawZ, { bevel: 0.25 }),
        extrude(innerSlide, -jawZ, jawZ, { bevel: 0.25 }),
        extrude(carriage, -jawZ - 0.9, jawZ + 0.9, { bevel: 0.3 }),
      ]),
      crease: 35,
    });

    // slider housing
    const hy0 = yS - sliderLen;
    const hy1 = yS - 12;
    const hxh = xb + 4.6;
    const zTop = jawZ + 6.5;
    const housingMat = digital ? plastic(p.housingColor, 0.45, 'housing plastic') : METALS.chrome;
    parts.push({
      name: 'slider-housing',
      role: 'body',
      material: housingMat,
      mesh: extrude(roundedRectLoop(-hxh, hy0, hxh, hy1, 4.2, ctx.seg(5, 2)), -jawZ - 2.2, zTop, {
        bevel: 1.5,
      }),
      crease: 40,
    });
    // thumb roller (axis along X) and lock screw
    const rollerR = 5.6;
    const rollerRing = flutedRing(rollerR, ctx.seg(20, 10), 0.45, ctx.seg(160, 60));
    parts.push({
      name: 'thumb-roller',
      role: 'knob',
      material: METALS.zinc,
      mesh: place(
        loft([
          { y: -4, ring: rollerRing },
          { y: 4, ring: rollerRing },
        ]),
        rotZ(90),
        at(xb - 3.2, yS - 18.5, zTop - 3.3),
      ),
      crease: 30,
    });
    const screwRing = flutedRing(3, ctx.seg(10, 6), 0.4, ctx.seg(80, 36));
    parts.push({
      name: 'lock-screw',
      role: 'knob',
      material: METALS.zinc,
      mesh: place(
        loft([
          { y: 0, ring: screwRing },
          { y: 3.4, ring: screwRing },
        ]),
        rotX(90),
        at(-xb + 3.2, yS - 18.5, zTop - 0.5),
      ),
      crease: 30,
    });
    if (digital) {
      const lcdTop = zTop;
      parts.push({
        name: 'lcd',
        role: 'screen',
        material: SCREEN,
        mesh: extrude(
          roundedRectLoop(-hxh + 3.2, yS - 53, hxh - 3.2, yS - 27, 1.4, ctx.seg(3, 1)),
          lcdTop - 0.4,
          lcdTop + 0.35,
          {
            bevel: 0.12,
          },
        ),
      });
      const btns = [-7.5, 0, 7.5].map((x) =>
        place(
          lathe(
            [
              [0, 0],
              [2.7, 0],
              [2.7, 0.9],
              [2.2, 1.2],
              [0, 1.2],
            ],
            ctx.seg(14, 8),
          ),
          rotX(90),
          at(x, yS - 58.5, lcdTop - 0.2),
        ),
      );
      parts.push({
        name: 'buttons',
        role: 'button',
        material: rubber(p.buttonColor, 'smooth', 'button'),
        mesh: mergeMeshes(btns),
      });
      if (ctx.detail) {
        const txt = open.toFixed(2);
        const h = 5.4;
        // reads along -Y with glyph up = +X, i.e. upright when the caliper is held jaws-left
        const rr = placeText(txt, h, 3, -h / 2, yS - 40);
        parts.push(
          ...marksPart('lcd-digits', rr, lcdTop + 0.35, paint('#232b22', 0.3, 'lcd segments')),
        );
      }
    } else if (ctx.detail) {
      // vernier scale: 10 divisions over 9 mm
      const rr: Rect[] = [];
      for (let i = 0; i <= 10; i++) {
        const y = yS - 22 - i * 0.9 - 8;
        rr.push([xb - 3.4 - (i % 5 === 0 ? 1.8 : 0), y - 0.07, xb + 0.9, y + 0.07]);
      }
      parts.push(...marksPart('vernier-scale', rr, zTop, INK));
    }
    // depth rod: emerges from the butt as the slider opens
    parts.push({
      name: 'depth-rod',
      role: 'rod',
      material: METALS.steel,
      mesh: extrude(rectLoop(xb - 5.6, -open, xb - 2.8, hy0 + 20), -0.8, 0.8),
    });
    // graduations
    if (ctx.detail) {
      const rects = linearScale({
        axis: 'y',
        origin: yF,
        dir: -1,
        length: range,
        edge: -xb + 0.4,
        inward: 1,
        numbers: Math.min(3.2, xb * 0.33),
        lens: [2.4, 3.6, 5],
        skip: [[hy0 - 1, yS + 0.5]],
      });
      parts.push(...marksPart('graduations', rects, bt / 2, INK));
    }
    // The depth rod sticks out of the beam butt by `open`; lift everything so the lowest point is y = 0.
    const lift = open;
    const lifted = parts.map((part) => ({ ...part, mesh: place(part.mesh, at(0, lift, 0)) }));
    return {
      parts: lifted,
      hang: { point: [0, lift + 2, 0], kind: 'butt' },
      zones: [
        { name: 'beam', y0: 0, y1: lift + Math.max(1, hy0) },
        { name: 'slider', y0: lift + Math.max(1, hy0), y1: lift + yS },
        { name: 'jaws', y0: lift + yS, y1: lift + Lb },
      ],
      dims: {
        length: Lb + lift,
        range,
        beamWidth: p.beamWidth,
        width: p.beamWidth + jl + ijl,
        thickness: zTop + jawZ + 2.2,
        jawLength: jl,
        jawOpening: open,
      },
    };
  },
});
