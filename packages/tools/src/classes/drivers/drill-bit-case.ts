/**
 * Indexed drill-bit case, metal or plastic, 13-19 HSS twist drills in half-round grooves sorted by size
 * (0.5 mm steps from `minDiameter`: 13 bits 2-8 mm, 19 bits 1-10 mm). Each shank sits in a graded hole of
 * the index plate at the butt end, so the tips form a staircase; the hinged lid is open or closed. The
 * bits are the real `drill-bit` meshes (DIN 338 jobber lengths). Axis +Y, hinge on the +X edge.
 */
import { type Mesh, mergeMeshes } from '../../mesh.ts';
import { METALS, type Material, plastic } from '../../materials.ts';
import { type BuiltTool, type Part, boundsOfParts } from '../../model.ts';
import { sizeOf } from '../../math.ts';
import { L, choice, color, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { at, extrude, place } from '../../build/primitives.ts';
import { circleRing } from '../../build/rings.ts';
import { drillFinishMaterials, drillLengths, drillMeshes } from './drill-bit.ts';
import {
  FLOOR,
  INSERT_MATERIAL,
  WALL,
  grooveBlock,
  hingedCase,
  lidMaterial,
  planeXZ,
} from './shared.ts';

const BODY_MATERIALS = ['metal', 'plastic'] as const;
const LID_STATES = ['open', 'closed'] as const;
const LID_STYLES = ['clear', 'smoke', 'solid'] as const;
const FINISHES = ['bright', 'black-oxide', 'titanium', 'bronze'] as const;

const PLATE_T = 2.4;
const SPACING = 1.0;

const schema = {
  bitCount: num(L('Number of drills', 'Количество свёрл'), 19, 13, 19, { step: 1, unit: 'count' }),
  minDiameter: num(L('Smallest drill', 'Минимальный диаметр'), 1, 1, 4, { step: 0.5 }),
  bodyMaterial: choice(L('Case material', 'Материал кейса'), BODY_MATERIALS, 'metal'),
  lid: choice(L('Lid', 'Крышка'), LID_STATES, 'open'),
  lidStyle: choice(L('Lid (plastic case)', 'Крышка пластикового кейса'), LID_STYLES, 'smoke'),
  finish: choice(L('Drill finish', 'Покрытие свёрл'), FINISHES, 'bright'),
  caseColor: color(L('Case colour', 'Цвет кейса'), '#b9bcc1'),
  lidColor: color(L('Lid colour', 'Цвет крышки'), '#d8e4ea'),
};

function paintedMetal(c: string): Material {
  return {
    name: 'painted sheet metal',
    kind: 'metal',
    color: c,
    metallic: 0.85,
    roughness: 0.4,
    alpha: 1,
  };
}

export const drillBitCase = defineToolClass({
  id: 'drill-bit-case',
  family: 'drivers',
  name: L('Drill-bit case', 'Кейс со свёрлами'),
  bankClass: 'bit-set',
  keywords: {
    en: [
      'drill bit case',
      'drill bit set',
      'drill index',
      'drill bit organizer',
      'metal drill set',
    ],
    ru: ['набор свёрл', 'кейс со свёрлами', 'набор сверл по металлу', 'свёрла в кейсе'],
  },
  schema,
  presets: [
    {
      id: 'drills19-metal-open',
      label: L('19 drills 1-10, metal, open', '19 свёрл 1-10, металл'),
      values: {},
    },
    {
      id: 'drills19-metal-closed',
      label: L('19 drills 1-10, metal, closed', '19 свёрл, закрыт'),
      values: { lid: 'closed' },
    },
    {
      id: 'drills13-plastic-open',
      label: L('13 drills 2-8, plastic, open', '13 свёрл 2-8, пластик'),
      values: {
        bitCount: 13,
        minDiameter: 2,
        bodyMaterial: 'plastic',
        lidStyle: 'smoke',
        caseColor: '#c8262b',
        finish: 'bronze',
      },
    },
    {
      id: 'drills16-titanium-open',
      label: L('16 drills, TiN, blue metal', '16 свёрл TiN, синий металл'),
      values: { bitCount: 16, minDiameter: 1.5, caseColor: '#2455a8', finish: 'titanium' },
    },
    {
      id: 'drills13-plastic-closed',
      label: L('13 drills, plastic, closed', '13 свёрл, пластик, закрыт'),
      values: {
        bitCount: 13,
        minDiameter: 2,
        bodyMaterial: 'plastic',
        lid: 'closed',
        lidStyle: 'solid',
        lidColor: '#2b2d31',
        caseColor: '#e8741e',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const count = Math.round(p.bitCount);
    const sizes = Array.from({ length: count }, (_, i) => p.minDiameter + 0.5 * i);
    const radii = sizes.map((d) => d / 2 + 0.3);
    const rmax = Math.max(...radii);
    const lengths = sizes.map((d) => drillLengths(d, 'jobber').total);
    const lmax = Math.max(...lengths);

    // row centres along X
    const centres: number[] = [];
    let cursor = 0;
    radii.forEach((r, i) => {
      cursor += i === 0 ? r : (radii[i - 1] as number) + r + SPACING;
      centres.push(cursor);
    });
    const span = cursor + rmax;
    const innerMargin = 3;
    const W = span + 2 * (WALL + innerMargin);
    const xRow = (i: number): number => -span / 2 + (centres[i] as number);

    const trayT = 0.9 * rmax + 1.8;
    const baseHeight = FLOOR + trayT + 0.5 * rmax;
    const lidHeight = 0.5 * rmax + 3.5;
    const yBit = WALL + 1.2;
    const Dlen = yBit + lmax + 5 + WALL;

    const metal = p.bodyMaterial === 'metal';
    const cs = hingedCase(
      {
        width: W,
        length: Dlen,
        baseHeight,
        lidHeight,
        open: p.lid === 'open',
        openAngle: 112,
        base: metal ? paintedMetal(p.caseColor) : plastic(p.caseColor, 0.42, 'case plastic'),
        lid: metal ? paintedMetal(p.caseColor) : lidMaterial(p.lidStyle, p.lidColor),
        accent: metal ? METALS.chrome : plastic(p.caseColor, 0.5, 'latch plastic'),
        corner: metal ? 3 : 5,
      },
      ctx,
    );
    const zt = cs.zFloor + trayT;

    const grooves = radii.map((r, i) => ({ c: xRow(i), r }));
    const tray = planeXZ(
      grooveBlock(cs.x0, cs.x1, cs.zFloor - 0.3, zt, grooves, cs.y0, cs.y1, ctx.seg(16, 12)),
    );

    // index plate with graded holes at the butt end
    const plateTop = zt + rmax + 1.2;
    const plateOuter: [number, number][] = [
      [cs.x0, cs.zFloor - 0.3],
      [cs.x1, cs.zFloor - 0.3],
      [cs.x1, plateTop],
      [cs.x0, plateTop],
    ];
    const holes = radii.map((r, i) =>
      circleRing(r - 0.05, ctx.seg(28, 12)).map(
        ([x, z]) => [x + xRow(i), z + zt + 0.1 * r] as const,
      ),
    );
    const plate = planeXZ(extrude(plateOuter, WALL + 0.2, WALL + 0.2 + PLATE_T, { holes }));

    const parts: Part[] = [
      ...cs.parts,
      { name: 'tray', role: 'insert', material: INSERT_MATERIAL, mesh: tray, crease: 40 },
      {
        name: 'index-plate',
        role: 'insert',
        material: metal ? METALS.aluminium : plastic('#3a3d42', 0.5, 'index plate'),
        mesh: plate,
        crease: 40,
      },
    ];

    // drills
    const bodies: Mesh[] = [];
    const shanks: Mesh[] = [];
    sizes.forEach((d, i) => {
      const { total, flute } = drillLengths(d, 'jobber');
      const m = drillMeshes({
        diameter: d,
        total,
        flute,
        pointAngle: 118,
        shank: 'straight',
        N: ctx.seg(36, 18),
        perRev: ctx.seg(16, 12),
        coneSteps: ctx.seg(8, 4),
      });
      const place1 = (mesh: Mesh): Mesh =>
        place(mesh, at(xRow(i), yBit, zt + 0.1 * (radii[i] as number)));
      bodies.push(place1(m.body));
      shanks.push(place1(m.shank));
    });
    const mats = drillFinishMaterials(p.finish);
    parts.push(
      {
        name: 'drill-bodies',
        role: 'tip',
        material: mats.body,
        mesh: mergeMeshes(bodies),
        crease: 55,
      },
      {
        name: 'drill-shanks',
        role: 'shank',
        material: mats.shank,
        mesh: mergeMeshes(shanks),
        crease: 35,
      },
    );

    const extent = sizeOf(boundsOfParts(parts));
    return {
      parts,
      hang: { point: [0, Dlen / 2, 0], kind: 'body' },
      zones: [{ name: 'case', y0: 0, y1: Dlen }],
      dims: {
        length: extent[1],
        width: extent[0],
        thickness: extent[2],
        closedThickness: baseHeight + lidHeight,
        bitCount: count,
        minDiameter: p.minDiameter,
        maxDiameter: sizes[count - 1] as number,
      },
    };
  },
});
