/**
 * Flip-top plastic bit case: base with a moulded tray holding 20-32 hex-shank bits (two columns, tips
 * pointing outwards, hex flats down in half-round grooves), a hinged lid (clear / smoked / solid) and a snap
 * latch. `lid` selects the open or closed state. Axis +Y along the long edge, hinge on the +X edge. The bits
 * are real `driver-bit` meshes (PH / PZ / slotted / Torx / hex / square), 7.6 mm row pitch like a 32 pc box
 * (about 64 x 135 x 20 mm).
 */
import { type Mesh, mergeMeshes, transformMesh } from '../../mesh.ts';
import { METALS, plastic } from '../../materials.ts';
import { type BuiltTool, type Part, boundsOfParts } from '../../model.ts';
import { sizeOf } from '../../math.ts';
import { L, choice, color, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { at, box, rotZ, place } from '../../build/primitives.ts';
import { type BitTip, bitMesh } from './driver-bit.ts';
import {
  FLOOR,
  INSERT_MATERIAL,
  WALL,
  grooveBlock,
  hingedCase,
  lidMaterial,
  planeYZ,
} from './shared.ts';

const LID_STATES = ['open', 'closed'] as const;
const LID_STYLES = ['clear', 'smoke', 'solid'] as const;

const PITCH = 7.6;
const GAP = 8;
const TRAY = 6;
const RIM_ABOVE_TRAY = 3.2;
const LID_HEIGHT = 9.2;
const GROOVE_R = 3.4;

const BIT_TYPES: readonly { tip: BitTip; size: number }[] = [
  { tip: 'phillips', size: 3.4 },
  { tip: 'phillips', size: 5 },
  { tip: 'pozidriv', size: 5 },
  { tip: 'slotted', size: 5.5 },
  { tip: 'torx', size: 3.9 },
  { tip: 'hex', size: 4 },
  { tip: 'slotted', size: 4.5 },
  { tip: 'torx', size: 4.4 },
  { tip: 'square', size: 4.2 },
  { tip: 'phillips', size: 6 },
];

const schema = {
  bitCount: num(L('Number of bits', 'Количество бит'), 32, 20, 32, { step: 2, unit: 'count' }),
  bitLength: num(L('Bit length', 'Длина бит'), 25, 25, 50, { step: 5 }),
  lid: choice(L('Lid', 'Крышка'), LID_STATES, 'open'),
  lidStyle: choice(L('Lid material', 'Материал крышки'), LID_STYLES, 'smoke'),
  caseColor: color(L('Case colour', 'Цвет кейса'), '#e8741e'),
  lidColor: color(L('Lid colour (solid / clear tint)', 'Цвет крышки'), '#d8e4ea'),
};

export const bitCase = defineToolClass({
  id: 'bit-case',
  family: 'drivers',
  name: L('Bit case', 'Кейс с битами'),
  bankClass: 'bit-set',
  keywords: {
    en: ['bit case', 'bit box', 'screwdriver bit set', 'bit set in case', 'driver bit organizer'],
    ru: ['набор бит', 'кейс с битами', 'коробка с битами', 'набор насадок'],
  },
  schema,
  presets: [
    { id: 'bits32-open-orange', label: L('32 bits, open, orange', '32 биты, открыт'), values: {} },
    {
      id: 'bits32-closed-orange',
      label: L('32 bits, closed, orange', '32 биты, закрыт'),
      values: { lid: 'closed' },
    },
    {
      id: 'bits24-open-blue',
      label: L('24 bits, clear lid, blue', '24 биты, прозрачная крышка'),
      values: { bitCount: 24, lidStyle: 'clear', caseColor: '#2455a8' },
    },
    {
      id: 'bits20-closed-black',
      label: L('20 bits, closed, black', '20 бит, закрыт, чёрный'),
      values: { bitCount: 20, lid: 'closed', caseColor: '#26272a', lidStyle: 'smoke' },
    },
    {
      id: 'bits28-50mm-open',
      label: L('28 bits, 50 mm, solid lid', '28 бит 50 мм, глухая крышка'),
      values: {
        bitCount: 28,
        bitLength: 50,
        lidStyle: 'solid',
        caseColor: '#c8262b',
        lidColor: '#2b2d31',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const total = Math.round(p.bitCount / 2) * 2;
    const rows = total / 2;
    const margin = 4;
    const Dlen = rows * PITCH + 2 * (WALL + margin);
    const W = 2 * (p.bitLength + GAP / 2 + 2 + WALL);
    const baseHeight = FLOOR + TRAY + RIM_ABOVE_TRAY;

    const cs = hingedCase(
      {
        width: W,
        length: Dlen,
        baseHeight,
        lidHeight: LID_HEIGHT,
        open: p.lid === 'open',
        openAngle: 115,
        base: plastic(p.caseColor, 0.42, 'case plastic'),
        lid: lidMaterial(p.lidStyle, p.lidColor),
        accent: plastic(p.caseColor, 0.5, 'latch plastic'),
        corner: 5,
      },
      ctx,
    );
    const zt = cs.zFloor + TRAY;
    const zAxis = zt + 0.3;
    const rowY = (k: number): number => WALL + margin + PITCH * (k + 0.5);

    // tray: one grooved block per column plus the centre ridge
    const arcSteps = ctx.seg(10, 5);
    const grooves = (n: number): { c: number; r: number }[] =>
      Array.from({ length: n }, (_, k) => ({ c: rowY(k), r: GROOVE_R }));
    const left = planeYZ(
      grooveBlock(cs.y0, cs.y1, cs.zFloor - 0.3, zt, grooves(rows), cs.x0, -GAP / 2, arcSteps),
    );
    const right = planeYZ(
      grooveBlock(cs.y0, cs.y1, cs.zFloor - 0.3, zt, grooves(rows), GAP / 2, cs.x1, arcSteps),
    );
    const ridge = transformMesh(
      box(GAP - 0.2, cs.y1 - cs.y0, zt + 1 - (cs.zFloor - 0.3), 0.6, 2),
      at(0, Dlen / 2, (zt + 1 + cs.zFloor - 0.3) / 2),
    );
    const parts: Part[] = [
      ...cs.parts,
      {
        name: 'tray',
        role: 'insert',
        material: INSERT_MATERIAL,
        mesh: mergeMeshes([left, right, ridge]),
        crease: 40,
      },
    ];

    // bits
    const N = ctx.seg(24, 12);
    const meshes: Mesh[] = BIT_TYPES.map((b) =>
      bitMesh({
        tip: b.tip,
        tipSize: b.size,
        length: p.bitLength,
        style: 'standard',
        N,
        tipSteps: ctx.seg(5, 3),
      }),
    );
    const bright: Mesh[] = [];
    const dark: Mesh[] = [];
    for (let k = 0; k < rows; k++) {
      const m = meshes[(2 * k) % meshes.length] as Mesh;
      (k % 3 === 2 ? dark : bright).push(place(m, rotZ(90), at(-GAP / 2, rowY(k), zAxis)));
    }
    for (let k = 0; k < rows; k++) {
      const m = meshes[(2 * k + 1) % meshes.length] as Mesh;
      (k % 3 === 0 ? dark : bright).push(place(m, rotZ(-90), at(GAP / 2, rowY(k), zAxis)));
    }
    parts.push({
      name: 'bits',
      role: 'tip',
      material: METALS.chromeVanadium,
      mesh: mergeMeshes(bright),
      crease: 30,
    });
    if (dark.length > 0)
      parts.push({
        name: 'bits-black',
        role: 'tip',
        material: METALS.blackOxide,
        mesh: mergeMeshes(dark),
        crease: 30,
      });

    const extent = sizeOf(boundsOfParts(parts));
    return {
      parts,
      hang: { point: [0, Dlen / 2, 0], kind: 'body' },
      zones: [{ name: 'case', y0: 0, y1: Dlen }],
      dims: {
        length: extent[1],
        width: extent[0],
        thickness: extent[2],
        closedThickness: baseHeight + LID_HEIGHT,
        bitCount: total,
        bitLength: p.bitLength,
      },
    };
  },
});
