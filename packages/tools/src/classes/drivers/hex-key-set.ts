/**
 * Folding hex key set (fan set): 6-8 metric hex keys (1.5..8 mm) on one pivot rivet between two plastic
 * side plates with a lanyard hole. State: closed (keys folded in the handle, tips peeking out), fan
 * (keys spread over the fan angle) or one-open (largest key at 90 degrees). Axis +Y: butt at y = 0,
 * pivot at y = 24, keys point to +Y. Plates ~17 mm wide, 2.8 mm thick each, key layers 3 mm apart.
 */
import { type Mesh, mergeMeshes } from '../../mesh.ts';
import { METALS, plastic } from '../../materials.ts';
import { type BuiltTool, type Part, boundsOfParts } from '../../model.ts';
import { sizeOf } from '../../math.ts';
import { L, choice, color, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { at, extrude, lathe, loft, place, rotX, rotZ } from '../../build/primitives.ts';
import { circleRing, roundedRectRing, scaleRing } from '../../build/rings.ts';
import { hexRing } from './shared.ts';

const STATES = ['closed', 'fan', 'one-open'] as const;
const FINISHES = ['chrome', 'black-oxide'] as const;
const SETS: Record<number, readonly number[]> = {
  6: [2, 2.5, 3, 4, 5, 6],
  7: [1.5, 2, 2.5, 3, 4, 5, 6],
  8: [1.5, 2, 2.5, 3, 4, 5, 6, 8],
};

const PIVOT_Y = 24;
const HOLE_Y = 9;
const PLATE_W = 17;
const PLATE_T = 2.8;
const CLEARANCE = 0.25;

const schema = {
  keys: num(L('Number of keys', 'Количество ключей'), 7, 6, 8, { step: 1, unit: 'count' }),
  handleLength: num(L('Handle length', 'Длина рукоятки'), 92, 75, 120, { step: 1 }),
  state: choice(L('State', 'Положение'), STATES, 'fan'),
  fanAngle: num(L('Fan angle', 'Угол веера'), 100, 50, 140, { step: 5, unit: 'deg' }),
  keyFinish: choice(L('Key finish', 'Покрытие ключей'), FINISHES, 'chrome'),
  plateColor: color(L('Plate colour', 'Цвет накладок'), '#c8262b'),
};

/** One straight key bar: pivot end at y = 0 (rounded off), working end at y = len. */
function keyBar(af: number, len: number, N: number): Mesh {
  const hex = hexRing(af, N);
  const cham = Math.min(1, af * 0.16);
  return loft([
    { y: -af * 0.6, ring: scaleRing(hex, 0.7) },
    { y: -af * 0.6 + 0.6, ring: hex },
    { y: len - cham, ring: hex },
    { y: len, ring: scaleRing(hex, 0.8) },
  ]);
}

export const hexKeySet = defineToolClass({
  id: 'hex-key-set',
  family: 'drivers',
  name: L('Folding hex key set', 'Складной набор шестигранников'),
  bankClass: 'hex-key-set',
  keywords: {
    en: ['folding hex key set', 'allen key set', 'fan hex key set', 'folding allen keys'],
    ru: ['набор шестигранников', 'складной набор шестигранников', 'набор имбусовых ключей'],
  },
  schema,
  presets: [
    { id: 'set7-fan-red', label: L('7 keys, fanned, red', '7 ключей, веер, красный'), values: {} },
    {
      id: 'set7-closed',
      label: L('7 keys, folded', '7 ключей, сложен'),
      values: { state: 'closed', plateColor: '#2455a8' },
    },
    {
      id: 'set8-fan-black',
      label: L('8 keys 1.5-8, fanned, black', '8 ключей 1,5-8, веер'),
      values: {
        keys: 8,
        handleLength: 100,
        keyFinish: 'black-oxide',
        plateColor: '#26272a',
        fanAngle: 110,
      },
    },
    {
      id: 'set6-one-open',
      label: L('6 keys, one open', '6 ключей, один открыт'),
      values: { keys: 6, handleLength: 84, state: 'one-open', plateColor: '#e8741e' },
    },
    {
      id: 'set8-closed-yellow',
      label: L('8 keys, folded, yellow', '8 ключей, сложен, жёлтый'),
      values: { keys: 8, state: 'closed', handleLength: 100, plateColor: '#f0c326' },
    },
  ],
  build(p, ctx): BuiltTool {
    const n = Math.round(p.keys);
    const sizes = SETS[n] as readonly number[];
    const count = sizes.length;
    const N = ctx.seg(36, 18);
    const Lh = p.handleLength;
    // each key is af thick (flats face +-z): layers stack by their real thickness
    const layerZ: number[] = [];
    let stack = 0;
    for (const af of sizes) {
      layerZ.push(stack + af / 2);
      stack += af + CLEARANCE;
    }
    stack -= CLEARANCE;
    const zIn = stack / 2 + 0.3;

    const parts: Part[] = [];
    // plates
    const outer = roundedRectRing(PLATE_W, Lh, PLATE_W * 0.48, ctx.seg(6, 3)).map(
      ([x, y]) => [x, y + Lh / 2] as const,
    );
    const hole = circleRing(2.4, ctx.seg(20, 10)).map(([x, y]) => [x, y + HOLE_Y] as const);
    const plateMesh = (sign: 1 | -1): Mesh => {
      const z0 = sign * zIn;
      const z1 = sign * (zIn + PLATE_T);
      const bevels =
        sign > 0 ? { bevelFront: 0.5, bevelBack: 0.2 } : { bevelBack: 0.5, bevelFront: 0.2 };
      const base = extrude(outer, z0, z1, { holes: [hole], ...bevels });
      if (!ctx.detail) return base;
      // finger ribs across the grip zone
      const ribs: Mesh[] = [];
      for (let k = 0; k < 7; k++) {
        const y = Lh * 0.42 + k * 4.4;
        if (y > Lh - 14) break;
        const rib = roundedRectRing(PLATE_W * 0.66, 1.6, 0.7, 3).map(
          ([x, v]) => [x, v + y] as const,
        );
        ribs.push(extrude(rib, z1 - sign * 0.2, z1 + sign * 0.5));
      }
      return mergeMeshes([base, ...ribs]);
    };
    const plateMat = plastic(p.plateColor, 0.4, 'plate plastic');
    parts.push(
      { name: 'plate-front', role: 'handle', material: plateMat, mesh: plateMesh(1), crease: 50 },
      { name: 'plate-back', role: 'handle', material: plateMat, mesh: plateMesh(-1), crease: 50 },
    );
    const H = zIn + PLATE_T + 1.2;
    parts.push({
      name: 'pivot',
      role: 'pivot',
      material: METALS.chrome,
      mesh: place(
        lathe(
          [
            [0, -H],
            [3.6, -H],
            [4, -H + 0.4],
            [4, -H + 1.1],
            [2.4, -H + 1.1],
            [2.4, H - 1.1],
            [4, H - 1.1],
            [4, H - 0.4],
            [3.6, H],
            [0, H],
          ],
          ctx.seg(24, 12),
        ),
        rotX(90),
        at(0, PIVOT_Y, 0),
      ),
      crease: 45,
    });

    // keys
    const keyMat = p.keyFinish === 'chrome' ? METALS.chromeVanadium : METALS.blackOxide;
    let yTop = Lh;
    sizes.forEach((af, i) => {
      const f = count > 1 ? i / (count - 1) : 0;
      const len = Lh - PIVOT_Y - 1.5 + 3 * f;
      yTop = Math.max(yTop, PIVOT_Y + len);
      const angle =
        p.state === 'fan' ? p.fanAngle * f : p.state === 'one-open' && i === count - 1 ? 90 : 0;
      const z = -stack / 2 + (layerZ[i] as number);
      parts.push({
        name: `key-${String(af).replace('.', 'p')}`,
        role: 'key',
        material: keyMat,
        mesh: place(keyBar(af, len, N), rotZ(-angle), at(0, PIVOT_Y, z)),
        crease: 35,
      });
    });

    const biggest = sizes[count - 1] as number;
    const extent = sizeOf(boundsOfParts(parts));
    return {
      parts,
      hang: { point: [0, HOLE_Y, 0], kind: 'hole', diameterMm: 4.8 },
      zones: [
        { name: 'butt', y0: 0, y1: PIVOT_Y },
        { name: 'handle', y0: PIVOT_Y, y1: yTop },
      ],
      dims: {
        length: extent[1],
        handleLength: Lh,
        width: extent[0],
        thickness: extent[2],
        keys: count,
        smallestKey: sizes[0] as number,
        largestKey: biggest,
        holeDiameter: 4.8,
      },
    };
  },
});
