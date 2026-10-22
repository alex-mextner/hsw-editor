/**
 * Hammer: claw, ball-peen, cross-peen, sledge and mallet heads on wood, fibreglass or steel-tube
 * handles. Axis +Y: butt at y = 0, head on top, the head axis along X (face towards -X, claw / peen
 * towards +X, lying in the XY plane). Sizes: claw 16 oz = 115 mm head / 25 mm face / 330 mm handle
 * (DIN 1041 / Stanley), ball-peen 300 g..1 kg 25-32 mm face, sledge (club) 1.5..4 kg 40-45 mm face on
 * 400..700 mm handles, rubber mallet 50-60 mm barrel. Handle section is an oval, long in the swing plane (X).
 */
import { lerp, smoothstep, translation } from '../math.ts';
import { box, cylinder, loft, mergeMeshes } from '../build/primitives.ts';
import { type Mesh, transformMesh } from '../mesh.ts';
import {
  METALS,
  type Material,
  type WoodSpecies,
  WOODS,
  paint,
  rubber,
  wood,
} from '../materials.ts';
import { type Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import { HEAD_FRAME, type Keyed, keyedStations } from './striking-util.ts';

const HEADS = ['claw', 'ball-peen', 'cross-peen', 'sledge', 'mallet'] as const;
const HANDLES = ['wood', 'fibreglass', 'steel-tube'] as const;
const FINISHES = ['steel', 'darkSteel', 'blackOxide', 'chrome'] as const;
const WOOD_LIST = Object.keys(WOODS) as WoodSpecies[];

const schema = {
  head: choice(L('Head type', 'Тип головки'), HEADS, 'claw'),
  handle: choice(L('Handle', 'Рукоятка'), HANDLES, 'wood'),
  headLength: num(L('Head length', 'Длина головки'), 115, 70, 200, { step: 1 }),
  faceDiameter: num(L('Face diameter', 'Диаметр бойка'), 25, 18, 70, { step: 0.5 }),
  handleLength: num(L('Handle length', 'Длина рукоятки'), 330, 250, 700, { step: 1 }),
  handleWidth: num(L('Handle width (swing plane)', 'Ширина рукоятки'), 30, 22, 42, { step: 0.5 }),
  headFinish: choice(L('Head finish', 'Покрытие головки'), FINISHES, 'steel'),
  handleWood: choice(L('Wood species', 'Порода дерева'), WOOD_LIST, 'hickory'),
  handleColor: color(L('Handle / tube colour', 'Цвет рукоятки'), '#e8741e'),
  gripColor: color(L('Grip colour', 'Цвет накладки'), '#1b1c1e'),
  malletMaterial: choice(L('Mallet head', 'Боёк киянки'), ['rubber', 'wood'] as const, 'rubber'),
  headColor: color(L('Mallet rubber colour', 'Цвет резины киянки'), '#2b2c2f'),
};

const FINISH_MAT: Record<(typeof FINISHES)[number], Material> = {
  steel: METALS.steel,
  darkSteel: METALS.darkSteel,
  blackOxide: METALS.blackOxide,
  chrome: METALS.chrome,
};

interface HeadShape {
  /** Head loft meshes in the world frame (not yet at the handle position). */
  meshes: Mesh[];
  faces: Mesh[];
  /** x of the face end (negative) and of the rear end. */
  xMin: number;
  xMax: number;
  /** Half height of the head body (handle top sits at the head top). */
  bTop: number;
  /** Half width across Z of the eye body. */
  aE: number;
}

const toWorld = (mesh: Mesh): Mesh => transformMesh(mesh, HEAD_FRAME);

function buildHead(
  kind: (typeof HEADS)[number],
  length: number,
  R: number,
  exE: number,
  ezE: number,
  ctx: { seg(hi: number, lo: number): number },
): HeadShape {
  const N = ctx.seg(40, 20);
  const aE = ezE + 3.5;
  const eyeHalf = exE + 4.5;
  const bE = Math.max(0.155 * length, eyeHalf * 0.95);
  const faceLen = Math.max(0.4 * length, eyeHalf + 14);
  const tipX = Math.max(0.6 * length, eyeHalf + 26);
  const meshes: Mesh[] = [];
  const faces: Mesh[] = [];

  if (kind === 'mallet') {
    const half = length / 2;
    const keys: Keyed[] = [
      { y: -half, a: R * 0.9, b: R * 0.9 },
      { y: -half + 2, a: R * 0.99, b: R * 0.99 },
      { y: -half + 7, a: R, b: R },
      { y: 0, a: R * 0.97, b: R * 0.97 },
      { y: half - 7, a: R, b: R },
      { y: half - 2, a: R * 0.99, b: R * 0.99 },
      { y: half, a: R * 0.9, b: R * 0.9 },
    ];
    meshes.push(toWorld(loft(keyedStations(keys, N, 3))));
    return { meshes, faces, xMin: -half, xMax: half, bTop: R, aE: R };
  }

  if (kind === 'sledge') {
    const half = Math.max(length / 2, eyeHalf + 30);
    const mid = eyeHalf + 0.5 * (half - eyeHalf);
    const waistA = Math.max(aE, 0.8 * R);
    const waistB = 0.96 * R;
    const faceKeys = (sign: 1 | -1): Keyed[] => {
      const pts: Keyed[] = [
        { y: sign * half, a: R * 0.88, b: R * 0.88, n: 2.4, oct: 0.8 },
        { y: sign * (half - 2.4), a: R * 1.0, b: R * 1.0, n: 2.4, oct: 0.8 },
      ];
      return pts;
    };
    const keys: Keyed[] = [
      ...faceKeys(-1),
      { y: -half + 7, a: R * 1.0, b: R, n: 2.4, oct: 0.75 },
      { y: -mid, a: lerp(R, waistA, 0.5), b: lerp(R, waistB, 0.5), n: 3.2, oct: 0.4 },
      { y: -eyeHalf, a: waistA, b: waistB, n: 4.5, oct: 0 },
      { y: 0, a: waistA * 1.02, b: waistB, n: 4.5 },
      { y: eyeHalf, a: waistA, b: waistB, n: 4.5, oct: 0 },
      { y: mid, a: lerp(R, waistA, 0.5), b: lerp(R, waistB, 0.5), n: 3.2, oct: 0.4 },
      { y: half - 7, a: R * 1.0, b: R, n: 2.4, oct: 0.75 },
      ...faceKeys(1).reverse(),
    ];
    meshes.push(toWorld(loft(keyedStations(keys, N, 3))));
    const faceMesh = (sign: 1 | -1): Mesh => {
      const k: Keyed[] = [
        { y: sign * (half + 0.02), a: R * 0.88, b: R * 0.88, n: 2.4, oct: 0.8 },
        { y: sign * (half - 2.4), a: R * 1.0 + 0.04, b: R + 0.04, n: 2.4, oct: 0.8 },
        { y: sign * (half - 5.5), a: R * 1.0 + 0.04, b: R + 0.04, n: 2.4, oct: 0.8 },
      ];
      return toWorld(loft(keyedStations(k, N, 2)));
    };
    faces.push(faceMesh(-1), faceMesh(1));
    return { meshes, faces, xMin: -half, xMax: half, bTop: waistB, aE: waistA };
  }

  // claw / ball-peen / cross-peen: face end
  const m = faceLen - eyeHalf;
  const neckR = R * 0.8;
  const front: Keyed[] = [
    { y: -faceLen, a: R * 0.9, b: R * 0.9 },
    { y: -faceLen + 1.6, a: R, b: R },
    { y: -faceLen + 4.5, a: R * 0.98, b: R * 0.98 },
    { y: -eyeHalf - 0.62 * m, a: neckR * 1.04, b: neckR * 1.04, n: 2.2, oct: 0.9 },
    { y: -eyeHalf - 0.28 * m, a: lerp(neckR, aE, 0.3), b: lerp(neckR, bE, 0.38), n: 3, oct: 0.55 },
    { y: -eyeHalf, a: aE, b: bE, n: 4.5 },
    { y: 0, a: aE * 1.02, b: bE, n: 4.5 },
    { y: eyeHalf, a: aE, b: bE, n: 4.5 },
  ];
  const tail = tipX - eyeHalf;
  let rear: Keyed[] = [];
  if (kind === 'claw') {
    const shoulder: Keyed = { y: eyeHalf + 6, a: aE * 0.97, b: bE * 0.78, n: 4, cz: -0.12 * bE };
    meshes.push(toWorld(loft(keyedStations([...front, shoulder], N, 3))));
    const bSteps = [1, 0.88, 0.62, 0.4, 0.24, 0.13];
    const prong = (sign: 1 | -1): Mesh => {
      const keys: Keyed[] = bSteps.map((bf, i) => {
        const u = i / (bSteps.length - 1);
        const pa = aE * lerp(0.56, 0.27, smoothstep(0, 1, u));
        return {
          y: lerp(0.3 * eyeHalf, tipX, u),
          a: pa,
          b: bE * bf,
          n: 3,
          cx: sign * (aE * lerp(1, 0.985, u) - pa),
          cz: -1.5 * bE * u ** 2.1,
        };
      });
      return toWorld(loft(keyedStations(keys, ctx.seg(28, 14), 4)));
    };
    meshes.push(prong(1), prong(-1));
    return { meshes, faces: [faceDisc(-faceLen, R, N)], xMin: -faceLen, xMax: tipX, bTop: bE, aE };
  }
  if (kind === 'ball-peen') {
    rear = [
      { y: eyeHalf + 0.18 * tail, a: lerp(aE, 0.8 * R, 0.7), b: lerp(bE, 0.8 * R, 0.7), n: 3 },
      { y: eyeHalf + 0.42 * tail, a: 0.72 * R, b: 0.72 * R },
      { y: eyeHalf + 0.7 * tail, a: 0.92 * R, b: 0.92 * R },
      { y: eyeHalf + 0.86 * tail, a: 0.8 * R, b: 0.8 * R },
      { y: eyeHalf + 0.96 * tail, a: 0.45 * R, b: 0.45 * R },
      { y: tipX, a: 0.06 * R, b: 0.06 * R },
    ];
  } else {
    rear = [
      { y: eyeHalf + 0.3 * tail, a: aE, b: lerp(bE, 0.45 * bE, 0.6), n: 4 },
      { y: eyeHalf + 0.7 * tail, a: aE * 0.97, b: Math.max(1.6, 0.16 * bE), n: 3.5 },
      { y: tipX, a: aE * 0.95, b: Math.max(0.9, 0.05 * bE), n: 3.5 },
    ];
  }
  meshes.push(toWorld(loft(keyedStations([...front, ...rear], N, 3))));
  return { meshes, faces: [faceDisc(-faceLen, R, N)], xMin: -faceLen, xMax: tipX, bTop: bE, aE };
}

/** Polished strike face: short collar with the bevel at the face end. */
function faceDisc(xFace: number, R: number, count: number): Mesh {
  return toWorld(
    loft(
      keyedStations(
        [
          { y: xFace - 0.02, a: R * 0.9, b: R * 0.9 },
          { y: xFace + 1.6, a: R + 0.04, b: R + 0.04 },
          { y: xFace + 4.2, a: R + 0.04, b: R + 0.04 },
        ],
        count,
        2,
      ),
    ),
  );
}

export const hammer = defineToolClass({
  id: 'hammer',
  family: 'striking',
  name: L('Hammer', 'Молоток'),
  bankClass: 'hammer',
  keywords: {
    en: ['hammer', 'claw hammer', 'ball-peen hammer', 'mallet', 'rubber mallet', 'sledge hammer'],
    ru: ['молоток', 'гвоздодёр', 'киянка', 'кувалда', 'слесарный молоток'],
  },
  schema,
  presets: [
    { id: 'claw-450g', label: L('Claw hammer 450 g, wood', 'Столярный молоток 450 г'), values: {} },
    {
      id: 'claw-fibreglass',
      label: L('Claw hammer 570 g, fibreglass', 'Молоток 570 г, фибергласс'),
      values: {
        handle: 'fibreglass',
        headLength: 122,
        faceDiameter: 26,
        handleLength: 340,
        handleWidth: 28,
        headFinish: 'darkSteel',
        handleColor: '#e8741e',
        gripColor: '#1b1c1e',
      },
    },
    {
      id: 'ball-peen-500g',
      label: L('Ball-peen hammer 500 g', 'Слесарный молоток 500 г'),
      values: {
        head: 'ball-peen',
        headLength: 108,
        faceDiameter: 27,
        handleLength: 320,
        handleWidth: 27,
        handleWood: 'ash',
        headFinish: 'darkSteel',
      },
    },
    {
      id: 'cross-peen-300g',
      label: L('Cross-peen hammer 300 g, steel tube', 'Молоток с клином 300 г'),
      values: {
        head: 'cross-peen',
        handle: 'steel-tube',
        headLength: 95,
        faceDiameter: 22,
        handleLength: 280,
        handleWidth: 24,
        headFinish: 'blackOxide',
        handleColor: '#2455a8',
        gripColor: '#c8262b',
      },
    },
    {
      id: 'rubber-mallet',
      label: L('Rubber mallet 60 mm', 'Резиновая киянка 60 мм'),
      values: {
        head: 'mallet',
        headLength: 100,
        faceDiameter: 58,
        handleLength: 320,
        handleWidth: 30,
        handleWood: 'beech',
        headColor: '#2b2c2f',
      },
    },
    {
      id: 'sledge-2kg',
      label: L('Sledge 2 kg (club hammer)', 'Кувалда 2 кг'),
      values: {
        head: 'sledge',
        headLength: 150,
        faceDiameter: 42,
        handleLength: 400,
        handleWidth: 34,
        handleWood: 'hickory',
        headFinish: 'darkSteel',
      },
    },
  ],
  build(p, ctx) {
    const Lh = p.handleLength;
    const A = p.handleWidth / 2;
    const B = A * 0.72;
    const eyeCap = p.head === 'mallet' ? p.faceDiameter * 0.4 : Infinity;
    const exE = Math.min(A * 0.85, eyeCap);
    const ezE = Math.min(B * 0.85, eyeCap);
    const R = p.faceDiameter / 2;
    const head = buildHead(p.head, p.headLength, R, exE, ezE, ctx);
    const cy = Lh - head.bTop;
    const top = Lh + 0.5;
    const parts: Part[] = [];
    const N = ctx.seg(48, 24);
    const ribs = ctx.detail ? 14 : 0;
    const place = (m: Mesh): Mesh => transformMesh(m, translation(0, cy, 0));

    // handle
    if (p.handle === 'wood') {
      const keys: Keyed[] = [
        { y: 0, a: A * 0.72, b: B * 0.72, n: 2.6 },
        { y: 3, a: A * 0.92, b: B * 0.92, n: 2.6 },
        { y: 13, a: A * 1.06, b: B * 1.04, n: 2.6 },
        { y: 0.2 * Lh, a: A * 1.0, b: B, n: 2.6 },
        { y: 0.46 * Lh, a: A * 0.86, b: B * 0.88, n: 2.6 },
        { y: 0.74 * Lh, a: A * 0.8, b: B * 0.84, n: 2.6 },
        { y: Math.max(Lh - 2 * head.bTop - 6, 0.74 * Lh + 2), a: A * 0.85, b: B * 0.86, n: 2.6 },
        { y: top, a: exE, b: ezE, n: 2.6 },
      ];
      parts.push({
        name: 'handle',
        role: 'handle',
        material: wood(p.handleWood, 0.55),
        mesh: loft(keyedStations(keys, N, 4)),
      });
    } else {
      const core: Keyed[] =
        p.handle === 'fibreglass'
          ? [
              { y: 0, a: A * 0.6, b: B * 0.6, n: 3 },
              { y: 0.4 * Lh, a: A * 0.66, b: B * 0.66, n: 3 },
              { y: Lh - 2 * head.bTop, a: A * 0.72, b: B * 0.72, n: 3 },
              { y: top, a: exE * 0.9, b: ezE * 0.9, n: 3 },
            ]
          : [
              { y: 0, a: A * 0.62, b: A * 0.62 },
              { y: top, a: A * 0.62, b: A * 0.62 },
            ];
      parts.push({
        name: 'handle',
        role: 'handle',
        material:
          p.handle === 'fibreglass'
            ? paint(p.handleColor, 0.3, 'fibreglass')
            : paint(p.handleColor, 0.3, 'steel tube'),
        mesh: loft(keyedStations(core, N, 4)),
      });
      const gripTop = 0.6 * Lh;
      const sleeve: Keyed[] = [
        { y: 0, a: A * 0.9, b: B * 0.92, n: 2.6, rib: 0 },
        { y: 3, a: A * 1.04, b: B * 1.06, n: 2.6, rib: 0.04 },
        { y: 0.12 * Lh, a: A * 1.0, b: B * 1.0, n: 2.6, rib: 0.07 },
        { y: 0.35 * Lh, a: A * 0.92, b: B * 0.95, n: 2.6, rib: 0.07 },
        { y: gripTop - 12, a: A * 0.86, b: B * 0.9, n: 2.6, rib: 0.04 },
        { y: gripTop - 3, a: A * 0.82, b: B * 0.86, n: 2.6, rib: 0 },
        { y: gripTop, a: A * 0.7, b: B * 0.75, n: 2.6, rib: 0 },
      ];
      parts.push({
        name: 'grip',
        role: 'grip',
        material: rubber(p.gripColor, ribs > 0 ? 'ribbed' : 'soft-grip'),
        mesh: loft(keyedStations(sleeve, ribs > 0 ? 84 : N, 4, ribs)),
      });
    }

    // head
    if (p.head === 'mallet') {
      parts.push({
        name: 'head',
        role: 'head',
        material:
          p.malletMaterial === 'rubber' ? rubber(p.headColor, 'smooth') : wood(p.handleWood, 0.6),
        mesh: place(mergeMeshes(head.meshes)),
      });
      // steel eye ring where the handle leaves the top of the barrel
      parts.push({
        name: 'eye-ring',
        role: 'ferrule',
        material: METALS.steel,
        mesh: transformMesh(
          cylinder(Math.max(exE, ezE) * 1.0 + 1.2, 2.4, ctx.seg(28, 14)),
          translation(0, Lh - 1, 0),
        ),
      });
    } else {
      parts.push({
        name: 'head',
        role: 'head',
        material: FINISH_MAT[p.headFinish],
        mesh: place(mergeMeshes(head.meshes)),
      });
      parts.push({
        name: 'face',
        role: 'face',
        material: METALS.polishedSteel,
        mesh: place(mergeMeshes(head.faces)),
      });
    }

    // wedge: a steel wedge across the short axis of the eye in a wood handle
    if (p.handle === 'wood') {
      parts.push({
        name: 'wedge',
        role: 'wedge',
        material: METALS.steel,
        mesh: transformMesh(box(1.8, 3, ezE * 1.5, 0.4, 2), translation(0, top - 1.1, 0)),
      });
    }

    const handleEnd = cy - head.bTop;
    return {
      parts,
      hang: { point: [0, handleEnd, 0], kind: 'neck' },
      zones: [
        { name: 'handle', y0: 0, y1: handleEnd },
        { name: 'head', y0: handleEnd, y1: top },
      ],
      dims: {
        length: top,
        handleLength: handleEnd,
        handleDiameter: p.handleWidth,
        handleThickness: 2 * B,
        headLength: head.xMax - head.xMin,
        faceDiameter: p.faceDiameter,
        headWidth: 2 * Math.max(head.aE, R),
        headHeight: 2 * Math.max(head.bTop, R),
      },
    };
  },
});
