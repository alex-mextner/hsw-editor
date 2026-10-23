/**
 * Reversible ratchet wrench with a 1/4, 3/8 or 1/2 inch square drive. Round head (axis along Z) with a
 * domed gear cover, the drive square with a detent ball on the front, the reversing lever and the quick
 * release button on the back, a forged oval handle with a hang hole and an optional dip or rubber grip.
 * Sizes: 1/4 in = 150 mm long, 3/8 in = 200 mm, 1/2 in = 260 mm (catalogue standard); square 6.35 / 9.525 /
 * 12.7 mm; head diameters 24 / 31 / 40 mm.
 */
import { type V2 } from '../math.ts';
import { type Mesh, mergeMeshes } from '../mesh.ts';
import { METALS, plastic } from '../materials.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import type { BuiltTool, Part } from '../model.ts';
import { at, box, extrude, lathe, place, rotX, rotZ, sphere } from '../build/primitives.ts';
import {
  type BarSection,
  DRIVES,
  DRIVE_MM,
  type Drive,
  FINISHES,
  arcPoints,
  barLoft,
  finishMaterial,
  gripMaterial,
  handleOutline,
  headOutline,
  placeOutline,
  plate,
  sleeve,
  stationYs,
} from './wrench-shared.ts';

interface DriveSpec {
  squareLength: number;
  headRadius: number;
  headThick: number;
  handleWidth: number;
  handleThick: number;
}

const DRIVE_SPECS: Record<Drive, DriveSpec> = {
  '1/4': {
    squareLength: 6.5,
    headRadius: 12,
    headThick: 11,
    handleWidth: 16,
    handleThick: 7,
  },
  '3/8': {
    squareLength: 9.5,
    headRadius: 15.5,
    headThick: 14.5,
    handleWidth: 20,
    handleThick: 8.5,
  },
  '1/2': {
    squareLength: 12.7,
    headRadius: 20,
    headThick: 19,
    handleWidth: 26,
    handleThick: 11,
  },
};

const schema = {
  drive: choice(L('Drive square', 'Квадрат'), DRIVES, '3/8'),
  length: num(L('Overall length', 'Общая длина'), 200, 110, 340, { step: 5 }),
  finish: choice(L('Finish', 'Покрытие'), FINISHES, 'chrome'),
  grip: choice(L('Handle', 'Рукоять'), ['bare', 'dipped', 'rubber'] as const, 'rubber'),
  gripColor: color(L('Grip colour', 'Цвет рукояти'), '#1b1c1e'),
  leverColor: color(L('Lever colour', 'Цвет рычага'), '#c8262b'),
};

export const wrenchRatchet = defineToolClass({
  id: 'wrench-ratchet',
  family: 'wrenches',
  name: L('Ratchet wrench', 'Трещотка'),
  bankClass: 'wrench',
  keywords: {
    en: ['ratchet', 'ratchet wrench', 'socket ratchet', 'reversible ratchet handle'],
    ru: ['трещотка', 'трещотка для головок', 'храповой ключ'],
  },
  schema,
  presets: [
    {
      id: '1-4-chrome',
      label: L('1/4 in chrome, 150 mm', '1/4" хромированная, 150 мм'),
      values: { drive: '1/4', length: 150, grip: 'bare' },
    },
    {
      id: '3-8-soft-grip',
      label: L('3/8 in soft grip, 200 mm', '3/8" с мягкой рукоятью, 200 мм'),
      values: { drive: '3/8', length: 200, grip: 'rubber' },
    },
    {
      id: '3-8-dipped-blue',
      label: L('3/8 in blue dipped, 200 mm', '3/8" с синей рукоятью, 200 мм'),
      values: {
        drive: '3/8',
        length: 200,
        grip: 'dipped',
        gripColor: '#2455a8',
        leverColor: '#1b1c1e',
      },
    },
    {
      id: '1-2-soft-grip',
      label: L('1/2 in soft grip, 260 mm', '1/2" с мягкой рукоятью, 260 мм'),
      values: {
        drive: '1/2',
        length: 260,
        grip: 'rubber',
        gripColor: '#e8741e',
        leverColor: '#1b1c1e',
      },
    },
    {
      id: '1-2-black-long',
      label: L('1/2 in black, 340 mm', '1/2" чёрная длинная, 340 мм'),
      values: { drive: '1/2', length: 340, grip: 'bare', finish: 'black-oxide' },
    },
  ],
  build(p, ctx): BuiltTool {
    const d = DRIVE_SPECS[p.drive];
    const sq = DRIVE_MM[p.drive];
    const Lt = Math.max(p.length, 6 * d.headRadius);
    const R = d.headRadius;
    const Th = d.headThick;
    const w = d.handleWidth;
    const t = d.handleThick;
    const yH = Lt - R;
    const steps = ctx.seg(10, 5);
    const material = finishMaterial(p.finish);
    const parts: Part[] = [];

    // Head plate: circle blended into the neck; thickness gently dished by the cover disc on the front.
    const outline = headOutline({
      radius: R,
      neckHalf: w / 2,
      fillet: 0.55 * R,
      neckExtra: 1,
      steps,
    });
    const headPlate = plate(placeOutline(outline.ring, yH, 1), 0, Th, Math.min(2.2, 0.16 * Th));

    // Handle: eyelet blank with the hang hole, then the oval grip body lofted over it up to the head.
    const holeR = Math.min(6, Math.max(2.6, 0.2 * w));
    const wButt = 0.84 * w;
    const holeY = 0.52 * wButt;
    const yBody0 = holeY + holeR + 0.2 * w;
    const yBody1 = yH - 0.7 * R;
    const blank = handleOutline({
      y0: 0,
      y1: yBody0 + 6,
      wButt,
      wTop: 0.88 * w,
      buttRound: 0.32 * wButt,
      hole: { y: holeY, r: holeR },
      steps,
    });
    const eyelet = extrude(blank.outer, -0.36 * t, 0.36 * t, {
      bevel: Math.min(1, 0.1 * t),
      holes: [blank.hole],
    });
    const ys = stationYs(yBody0, yBody1, ctx.seg(12, 5), [yH - 1.95 * R]);
    const widthAt = (y: number): number => {
      const u = (y - yBody0) / (yBody1 - yBody0);
      return w * (0.88 + 0.12 * u);
    };
    const thickAt = (y: number): number => {
      const u = (y - yBody0) / (yBody1 - yBody0);
      const grow = (y - (yH - 1.95 * R)) / (0.85 * R);
      return t * (0.92 + 0.08 * u) + (Th - t) * Math.max(0, Math.min(1, grow)) ** 2;
    };
    const body: BarSection[] = ys.map((y) => ({ y, width: widthAt(y), thick: thickAt(y), z: 0 }));
    parts.push({
      name: 'handle',
      role: 'handle',
      material,
      mesh: mergeMeshes([eyelet, barLoft(body, ctx.seg(5, 2)), headPlate]),
      crease: 40,
    });

    if (p.grip !== 'bare') {
      const gy0 = yBody0 + 0.12 * Lt;
      const gy1 = yH - 1.6 * R;
      const grooves: number[] = [];
      if (p.grip === 'rubber' && ctx.detail) {
        for (let y = gy0 + 0.05 * Lt; y < gy1 - 0.03 * Lt; y += 0.04 * Lt) grooves.push(y);
      }
      parts.push({
        name: 'grip',
        role: 'grip',
        material: gripMaterial(p.grip, p.gripColor),
        mesh: sleeve({
          y0: gy0,
          y1: gy1,
          width: widthAt,
          thick: thickAt,
          over: p.grip === 'rubber' ? 1.9 : 0.8,
          count: ctx.seg(10, 4),
          grooves,
          grooveDepth: 0.8,
          bulge: p.grip === 'rubber' ? 0.05 : 0,
          perCorner: ctx.seg(4, 2),
        }),
      });
    }

    // Gear cover on the front, drive square, detent ball.
    const coverR = 0.72 * R;
    const lathePart = (profile: readonly V2[], z0: number, sides: number): Mesh =>
      place(lathe(profile, sides), rotX(90), at(0, yH, z0));
    const cover = lathePart(
      [
        [coverR * 0.82, 0],
        [coverR, 0.5],
        [coverR, 1.6],
        [coverR * 0.62, 2.6],
        [coverR * 0.6, 2.9],
      ],
      Th / 2 - 0.2,
      ctx.seg(36, 16),
    );
    parts.push({
      name: 'cover',
      role: 'head',
      material: p.finish === 'black-oxide' ? METALS.blackOxide : METALS.polishedSteel,
      mesh: cover,
      crease: 40,
    });
    const zSq0 = Th / 2 + 2.4;
    const squareMesh = place(
      box(sq, sq, d.squareLength + 0.6, 0.7, 2),
      at(0, yH, zSq0 + (d.squareLength + 0.6) / 2 - 0.6),
    );
    const ball = place(
      sphere(0.14 * sq, ctx.seg(14, 8)),
      at(sq / 2 + 0.05 * sq - 0.4, yH, zSq0 + d.squareLength * 0.62),
    );
    parts.push({
      name: 'drive-square',
      role: 'tip',
      material: METALS.chromeVanadium,
      mesh: mergeMeshes([squareMesh, ball]),
      crease: 30,
    });

    // Back: reversing lever (stadium plate pivoting about the head centre) and the release button.
    const leverLen = 0.9 * R;
    const leverW = 0.5 * R;
    const lever: V2[] = [
      ...arcPoints(0, 0, leverW / 2, 90, 270, steps),
      ...arcPoints(leverLen - leverW / 2, 0, leverW / 2, -90, 90, steps),
    ];
    const leverMesh = place(
      extrude(lever, -2.2, 2.2, { bevel: 0.7 }),
      rotZ(-20),
      at(0, yH, -Th / 2 - 2.2 + 0.3),
    );
    const buttonMesh = place(
      lathe(
        [
          [0.26 * R, 0],
          [0.3 * R, 0.5],
          [0.3 * R, 2.4],
          [0.24 * R, 3.2],
        ],
        ctx.seg(24, 12),
      ),
      rotX(-90),
      at(0, yH, -Th / 2 - 3.9),
    );
    parts.push({
      name: 'lever',
      role: 'lever',
      material: plastic(p.leverColor, 0.4, 'lever'),
      mesh: leverMesh,
      crease: 40,
    });
    parts.push({
      name: 'release-button',
      role: 'lever',
      material: METALS.polishedSteel,
      mesh: buttonMesh,
      crease: 40,
    });

    return {
      parts,
      hang: { point: [0, holeY, 0], kind: 'hole', diameterMm: 2 * holeR },
      zones: [
        { name: 'handle', y0: 0, y1: yH - R },
        { name: 'head', y0: yH - R, y1: Lt },
      ],
      dims: {
        length: Lt,
        width: 2 * R,
        thickness: Th + d.squareLength + 9.5,
        headDiameter: 2 * R,
        headThickness: Th,
        handleWidth: w,
        handleThickness: t + (p.grip === 'bare' ? 0 : p.grip === 'rubber' ? 3.8 : 1.6),
        driveSquare: sq,
        driveLength: d.squareLength,
      },
    };
  },
});
