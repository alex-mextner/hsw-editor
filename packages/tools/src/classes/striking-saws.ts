/**
 * Hand saws. `saw-hand`: panel saw with a tapered, toothed steel blade (the teeth are part of the blade
 * outline polygon), open D-handle with hand hole (wood or plastic with soft grip) and three saw bolts;
 * 350..600 mm (14".."24"), 8 TPI = 3.2 mm pitch. `hacksaw`: tubular steel bow with a telescoping sleeve,
 * pistol-grip handle with soft over-mould, blade between two pins, wing-nut tensioner; 300 mm blade at
 * 18 TPI = 1.4 mm pitch (DIN 6494). Axis +Y: handle butt at y = 0, blade towards +Y; the blade plane is
 * XY (thin in Z), teeth towards -X.
 */
import { type V2, type V3, lerp } from '../math.ts';
import {
  at,
  box,
  cylinder,
  extrude,
  mergeMeshes,
  place,
  roundedPath,
  rotX,
  tube,
} from '../build/primitives.ts';
import { type Mesh } from '../mesh.ts';
import { METALS, type WoodSpecies, WOODS, paint, plastic, rubber, wood } from '../materials.ts';
import { type Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { roundCorners, stadium, toothEdge } from './striking-util.ts';

const WOOD_LIST = Object.keys(WOODS) as WoodSpecies[];

/** Cylinder through the tool thickness (axis Z) centred at (x, y). */
function zPin(x: number, y: number, r: number, h: number, seg: number): Mesh {
  return place(cylinder(r, h, seg), rotX(90), at(x, y, 0));
}

// ------------------------------------------------------------------ panel saw

const handSawSchema = {
  length: num(L('Overall length', 'Общая длина'), 560, 350, 600, { step: 5 }),
  heelHeight: num(L('Blade height at heel', 'Высота полотна у рукоятки'), 120, 90, 150, {
    step: 1,
  }),
  toeHeight: num(L('Blade height at toe', 'Высота полотна на конце'), 50, 30, 90, { step: 1 }),
  toothPitch: num(L('Tooth pitch', 'Шаг зуба'), 3.2, 2, 6, { step: 0.1 }),
  bladeThickness: num(L('Blade thickness', 'Толщина полотна'), 1, 0.6, 1.5, { step: 0.05 }),
  teeth: choice(L('Teeth', 'Зубья'), ['crosscut', 'rip'] as const, 'crosscut'),
  handle: choice(L('Handle', 'Рукоятка'), ['plastic', 'wood'] as const, 'plastic'),
  handleWood: choice(L('Wood species', 'Порода дерева'), WOOD_LIST, 'beech'),
  handleColor: color(L('Handle colour', 'Цвет рукоятки'), '#d9b21c'),
  gripColor: color(L('Soft grip colour', 'Цвет накладки'), '#1b1c1e'),
};

const HANDLE_LEN = 150;

export const sawHand = defineToolClass({
  id: 'saw-hand',
  family: 'striking',
  name: L('Hand saw', 'Ножовка по дереву'),
  bankClass: 'saw',
  keywords: {
    en: ['hand saw', 'panel saw', 'wood saw', 'saw', 'crosscut saw'],
    ru: ['ножовка', 'ножовка по дереву', 'пила', 'ручная пила'],
  },
  schema: handSawSchema,
  presets: [
    { id: 'panel-560', label: L('Panel saw 22", plastic', 'Ножовка 560 мм, пластик'), values: {} },
    {
      id: 'panel-wood-500',
      label: L('Panel saw 20", wood handle', 'Ножовка 500 мм, дерево'),
      values: {
        length: 500,
        heelHeight: 110,
        toeHeight: 45,
        handle: 'wood',
        handleWood: 'beech',
        toothPitch: 3.6,
      },
    },
    {
      id: 'rip-600',
      label: L('Rip saw 24"', 'Продольная пила 600 мм'),
      values: {
        length: 600,
        heelHeight: 130,
        toeHeight: 60,
        teeth: 'rip',
        toothPitch: 4.2,
        handle: 'wood',
        handleWood: 'walnut',
      },
    },
    {
      id: 'tenon-350',
      label: L('Tenon saw 14"', 'Ножовка с обушком 350 мм'),
      values: {
        length: 350,
        heelHeight: 100,
        toeHeight: 85,
        toothPitch: 2.2,
        bladeThickness: 0.8,
        handleColor: '#c8262b',
      },
    },
    {
      id: 'fine-450',
      label: L('Fine-tooth saw 18"', 'Ножовка мелкий зуб 450 мм'),
      values: {
        length: 450,
        heelHeight: 112,
        toeHeight: 48,
        toothPitch: 2.4,
        handleColor: '#2455a8',
      },
    },
  ],
  build(p, ctx) {
    const Lt = p.length;
    const yb = 84;
    const x0 = -0.5 * p.heelHeight;
    const pitch = p.toothPitch * ctx.seg(1, 2.4);
    const depth = Math.min(0.78 * p.toothPitch, 4.2);
    const rake = p.teeth === 'rip' ? 0.8 : 0.25;
    const toe = Math.min(p.toeHeight, p.heelHeight);
    const bladeOutline: V2[] = [
      ...toothEdge(x0, yb, Lt - 6, pitch, depth, -1, rake),
      [x0 + 3, Lt - 1.5],
      [x0 + 9, Lt],
      [x0 + toe, Lt - 3],
      [x0 + p.heelHeight, yb],
    ];
    const parts: Part[] = [];
    parts.push({
      name: 'blade',
      role: 'blade',
      material: METALS.polishedSteel,
      mesh: extrude(bladeOutline, -p.bladeThickness / 2, p.bladeThickness / 2),
      crease: 40,
    });

    // handle plate (D-shaped, rear grip post, front mounting plate) with the hand hole
    const hx0 = -52;
    const outline = roundCorners(
      [
        [hx0, 14],
        [hx0, HANDLE_LEN],
        [60, HANDLE_LEN],
        [88, 116],
        [90, 56],
        [82, 14],
      ],
      [16, 12, 14, 26, 28, 18],
      ctx.seg(6, 3),
    );
    const hole = stadium(14, 58, 88, 36, ctx.seg(8, 4));
    const T = 14;
    parts.push({
      name: 'handle',
      role: 'handle',
      material:
        p.handle === 'wood'
          ? wood(p.handleWood, 0.5)
          : plastic(p.handleColor, 0.4, 'handle plastic'),
      mesh: extrude(outline, -T, T, { holes: [hole], bevel: 3.5 }),
      crease: 40,
    });
    if (p.handle === 'plastic') {
      // soft over-mould on the rear grip post
      const post = roundCorners(
        [
          [-47, 15.5],
          [-47, 40],
          [86, 40],
          [80, 15.5],
        ],
        [10, 6, 12, 14],
        ctx.seg(5, 3),
      );
      parts.push({
        name: 'grip',
        role: 'grip',
        material: rubber(p.gripColor, 'soft-grip'),
        mesh: extrude(post, -T - 1.1, T + 1.1, { bevel: 3 }),
        crease: 40,
      });
    }
    const boltAt: readonly V2[] = [
      [-30, 100],
      [4, 126],
      [38, 100],
    ];
    const bolts = mergeMeshes(boltAt.map(([x, y]) => zPin(x, y, 5, 2 * T + 3.2, ctx.seg(20, 10))));
    parts.push({ name: 'bolts', role: 'fastener', material: METALS.brass, mesh: bolts });
    if (p.handle === 'wood') {
      parts.push({
        name: 'medallion',
        role: 'badge',
        material: METALS.brass,
        mesh: zPin(60, 104, 8, 2 * T + 0.8, ctx.seg(28, 12)),
      });
    }

    return {
      parts,
      hang: { point: [14, 58, 0], kind: 'hole', diameterMm: 36 },
      zones: [
        { name: 'handle', y0: 0, y1: yb },
        { name: 'blade', y0: yb, y1: Lt },
      ],
      dims: {
        length: Lt,
        handleLength: yb,
        bladeLength: Lt - yb,
        width: 90 - (x0 - depth),
        bladeWidth: p.heelHeight,
        toeWidth: toe,
        thickness: 2 * (T + 1.1),
        bladeThickness: p.bladeThickness,
        holeDiameter: 36,
      },
    };
  },
});

// ------------------------------------------------------------------ hacksaw

const hacksawSchema = {
  bladeLength: num(L('Blade length (pin to pin)', 'Длина полотна'), 300, 200, 400, { step: 5 }),
  bowHeight: num(L('Bow height above blade', 'Высота дуги над полотном'), 58, 40, 80, { step: 1 }),
  tubeWidth: num(L('Bow tube width', 'Ширина трубы дуги'), 15, 10, 22, { step: 0.5 }),
  tubeThickness: num(L('Bow tube thickness', 'Толщина трубы дуги'), 10, 6, 16, { step: 0.5 }),
  toothPitch: num(L('Tooth pitch (18 TPI = 1.4)', 'Шаг зуба'), 1.4, 0.8, 2.5, { step: 0.1 }),
  frameColor: color(L('Frame colour', 'Цвет рамы'), '#2455a8'),
  handleColor: color(L('Handle colour', 'Цвет рукоятки'), '#1b1c1e'),
  gripColor: color(L('Soft grip colour', 'Цвет накладки'), '#e8741e'),
};

const PIN_REAR_Y = 88;
const BLOCK_Z = 13;

export const hacksaw = defineToolClass({
  id: 'hacksaw',
  family: 'striking',
  name: L('Hacksaw', 'Ножовка по металлу'),
  bankClass: 'saw',
  keywords: {
    en: ['hacksaw', 'metal saw', 'saw', 'junior hacksaw'],
    ru: ['ножовка по металлу', 'ножовка', 'пила по металлу'],
  },
  schema: hacksawSchema,
  presets: [
    {
      id: 'hacksaw-300',
      label: L('Hacksaw 300 mm, blue frame', 'Ножовка по металлу 300 мм'),
      values: {},
    },
    {
      id: 'hacksaw-300-red',
      label: L('Hacksaw 300 mm, red frame', 'Ножовка 300 мм, красная'),
      values: { frameColor: '#c8262b', gripColor: '#1b1c1e', handleColor: '#1b1c1e' },
    },
    {
      id: 'hacksaw-250',
      label: L('Hacksaw 250 mm, compact', 'Ножовка 250 мм'),
      values: {
        bladeLength: 250,
        bowHeight: 50,
        tubeWidth: 13,
        frameColor: '#2f8f4c',
        toothPitch: 1.8,
      },
    },
    {
      id: 'hacksaw-junior-150',
      label: L('Junior hacksaw 200 mm', 'Малая ножовка по металлу'),
      values: {
        bladeLength: 200,
        bowHeight: 42,
        tubeWidth: 11,
        tubeThickness: 7,
        frameColor: '#c8c9cc',
        gripColor: '#e8741e',
        toothPitch: 1.0,
      },
    },
  ],
  build(p, ctx) {
    const yR = PIN_REAR_Y;
    const yF = yR + p.bladeLength;
    const bowX = p.bowHeight;
    const parts: Part[] = [];
    const sides = ctx.seg(20, 10);

    // blade with ground teeth along its lower (-X) edge, 12.7 mm wide, 0.65 mm thick
    const pitch = p.toothPitch * ctx.seg(1, 3);
    const bx0 = -6.35;
    const blade: V2[] = [
      ...toothEdge(bx0, yR - 8, yF + 8, pitch, 1.1, -1, 0.7),
      [bx0 + 1.5, yF + 11],
      [bx0 + 11, yF + 11],
      [bx0 + 12.7, yF + 8],
      [bx0 + 12.7, yR - 8],
    ];
    parts.push({
      name: 'blade',
      role: 'blade',
      material: METALS.darkSteel,
      mesh: extrude(blade, -0.33, 0.33),
      crease: 40,
    });

    // frame: inverted U tube from the handle block over the blade to the front fitting
    const rz = p.tubeThickness / 2;
    const rw = p.tubeWidth / 2;
    const frontLegX = 5;
    const path = roundedPath(
      [
        [26, yR - 4, 0],
        [bowX, yR - 4, 0],
        [bowX, yF + 10, 0],
        [frontLegX, yF + 10, 0],
      ] as V3[],
      Math.min(16, bowX * 0.4),
      ctx.seg(8, 4),
    );
    parts.push({
      name: 'bow',
      role: 'frame',
      material: paint(p.frameColor, 0.32, 'frame paint'),
      mesh: tube(path, [rz, rw], { sides, up: [0, 0, 1] }),
    });
    parts.push({
      name: 'sleeve',
      role: 'frame',
      material: METALS.zinc,
      mesh: tube(
        [
          [bowX, yR + 34, 0],
          [bowX, yR + 34 + Math.min(0.3 * p.bladeLength, 80), 0],
        ] as V3[],
        [rz + 1, rw + 1],
        { sides, up: [0, 0, 1] },
      ),
    });

    // pistol grip: hard shell + soft over-mould with finger scallops
    const shell = roundCorners(
      [
        [-108, 3],
        [-108, 42],
        [-14, 48],
        [-12, 94],
        [28, 98],
        [32, 18],
        [8, 9],
      ],
      [10, 12, 8, 6, 10, 12, 8],
      ctx.seg(5, 3),
    );
    parts.push({
      name: 'handle',
      role: 'handle',
      material: plastic(p.handleColor, 0.4, 'handle plastic'),
      mesh: extrude(shell, -BLOCK_Z, BLOCK_Z, { bevel: 3 }),
      crease: 40,
    });
    const scallops: V2[] = [];
    const nS = ctx.seg(40, 8);
    for (let k = 0; k <= nS; k++) {
      const x = lerp(-96, -24, k / nS);
      const y = 43 - 2.4 * (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 96)) / 18));
      scallops.push([x, y]);
    }
    const grip = roundCorners([[-104, 4.5], ...scallops, [-22, 26], [-24, 18]] as V2[], 0);
    parts.push({
      name: 'grip',
      role: 'grip',
      material: rubber(p.gripColor, 'soft-grip'),
      mesh: extrude(grip, -BLOCK_Z - 1.2, BLOCK_Z + 1.2, { bevel: 2.5 }),
      crease: 40,
    });

    // blade pins and the front tensioner: barrel along Y plus a wing nut
    const pins = mergeMeshes([
      zPin(0, yR, 2.2, 22, ctx.seg(14, 8)),
      zPin(0, yF, 2.2, 22, ctx.seg(14, 8)),
    ]);
    parts.push({ name: 'pins', role: 'fastener', material: METALS.steel, mesh: pins });
    const barrel = place(cylinder(6, 34, sides), at(0, yF + 14, 0));
    parts.push({ name: 'front-fitting', role: 'fitting', material: METALS.zinc, mesh: barrel });
    const nutY = yF + 34;
    parts.push({
      name: 'wing-nut',
      role: 'fastener',
      material: METALS.zinc,
      mesh: mergeMeshes([
        place(cylinder(6.5, 11, sides), at(0, nutY, 0)),
        place(box(38, 8, 4.4, 1.4, 2), at(0, nutY - 1, 0)),
        place(box(8, 8, 8, 1.4, 2), at(0, nutY + 1, 0)),
      ]),
    });
    const yEnd = nutY + 6;
    return {
      parts,
      hang: { point: [bowX, 0.5 * (yR + yF), 0], kind: 'body' },
      zones: [
        { name: 'handle', y0: 0, y1: yR - 8 },
        { name: 'frame', y0: yR - 8, y1: yEnd },
      ],
      dims: {
        length: yEnd,
        bladeLength: p.bladeLength,
        bowHeight: bowX,
        handleLength: yR - 8,
        handleHeight: 108,
        width: bowX + rw + 108,
        thickness: 2 * (BLOCK_Z + 1.2),
        tubeWidth: p.tubeWidth,
      },
    };
  },
});
