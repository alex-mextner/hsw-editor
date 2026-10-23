/**
 * Hex (Allen) L-key. Axis +Y: the long arm runs from the outer face of the short arm (y = 0) to the
 * working tip; the short arm leaves along +X. Sizes 1.5..10 mm across flats; arm lengths follow DIN 911
 * (e.g. 4 mm: 70 / 25, 6 mm: 90 / 32, 10 mm: 112 / 40). The key is one swept hex bar with chamfered
 * ends, a rounded bend and an optional ball end on the long arm (and the short arm).
 */
import { type V2, smoothstep } from '../../math.ts';
import { METALS, type Material, paint } from '../../materials.ts';
import type { BuiltTool } from '../../model.ts';
import { L, choice, color, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { blendRings, circleRing, scaleRing } from '../../build/rings.ts';
import { type SweepStation, hexCircumRadius, hexRing, sweepPlanar } from './shared.ts';

const BALLS = ['none', 'long-arm', 'both'] as const;
const FINISHES = ['chrome', 'black-oxide', 'zinc', 'colour'] as const;

const schema = {
  size: num(L('Hex size (across flats)', 'Размер шестигранника'), 4, 1.5, 10, { step: 0.5 }),
  longArm: num(L('Long arm length', 'Длина длинного плеча'), 70, 40, 250, { step: 1 }),
  shortArm: num(L('Short arm length', 'Длина короткого плеча'), 25, 14, 80, { step: 1 }),
  ballEnd: choice(L('Ball end', 'Шаровой конец'), BALLS, 'none'),
  finish: choice(L('Finish', 'Покрытие'), FINISHES, 'chrome'),
  keyColor: color(L('Coating colour', 'Цвет покрытия'), '#c8262b'),
};

function finishMaterial(finish: (typeof FINISHES)[number], tint: string): Material {
  if (finish === 'chrome') return METALS.chromeVanadium;
  if (finish === 'black-oxide') return METALS.blackOxide;
  if (finish === 'zinc') return METALS.zinc;
  return paint(tint, 0.36, 'coated steel');
}

interface EndStation {
  /** Distance from the tip along the bar. */
  d: number;
  ring: readonly V2[];
}

/** Stations of one bar end, tip first. `ball` blends the hex into a sphere with a slim neck. */
function endStations(af: number, N: number, ball: boolean, ballSteps: number): EndStation[] {
  const hex = hexRing(af, N);
  if (!ball) {
    const cham = Math.min(1.1, Math.max(0.3, af * 0.14));
    return [
      { d: 0, ring: scaleRing(hex, 0.8) },
      { d: cham, ring: hex },
    ];
  }
  const rb = af * 0.52;
  const dc = rb * 0.95;
  const out: EndStation[] = [];
  const phi0 = Math.acos(dc / rb);
  const phi1 = (125 * Math.PI) / 180;
  for (let k = 0; k <= ballSteps; k++) {
    const phi = phi0 + ((phi1 - phi0) * k) / ballSteps;
    out.push({ d: dc - rb * Math.cos(phi), ring: circleRing(rb * Math.sin(phi), N) });
  }
  const dNeck = (out[out.length - 1] as EndStation).d;
  const rNeck = rb * Math.sin(phi1);
  const blendLen = af * 0.7;
  for (let k = 1; k <= 3; k++) {
    const u = k / 3;
    out.push({
      d: dNeck + blendLen * u,
      ring: blendRings(circleRing(rNeck, N), hex, smoothstep(0, 1, u)),
    });
  }
  return out;
}

export const hexKey = defineToolClass({
  id: 'hex-key',
  family: 'drivers',
  name: L('Hex key', 'Шестигранный ключ'),
  bankClass: 'hex-key',
  keywords: {
    en: ['hex key', 'allen key', 'allen wrench', 'l-key', 'hex wrench', 'ball end hex key'],
    ru: ['шестигранник', 'имбусовый ключ', 'г-образный ключ', 'ключ шестигранный'],
  },
  schema,
  presets: [
    { id: 'hex-2', label: L('2 mm', '2 мм'), values: { size: 2, longArm: 50, shortArm: 18 } },
    { id: 'hex-4', label: L('4 mm, chrome', '4 мм, хром'), values: {} },
    {
      id: 'hex-5-ball',
      label: L('5 mm ball end', '5 мм шаровой'),
      values: { size: 5, longArm: 80, shortArm: 28, ballEnd: 'long-arm', finish: 'black-oxide' },
    },
    {
      id: 'hex-6-long',
      label: L('6 mm long arm, coloured', '6 мм удлинённый, цветной'),
      values: {
        size: 6,
        longArm: 140,
        shortArm: 38,
        ballEnd: 'long-arm',
        finish: 'colour',
        keyColor: '#2455a8',
      },
    },
    {
      id: 'hex-10',
      label: L('10 mm heavy', '10 мм, усиленный'),
      values: { size: 10, longArm: 112, shortArm: 40, finish: 'zinc' },
    },
    {
      id: 'hex-1p5',
      label: L('1.5 mm', '1,5 мм'),
      values: { size: 1.5, longArm: 46.5, shortArm: 14, finish: 'black-oxide' },
    },
  ],
  build(p, ctx): BuiltTool {
    const af = p.size;
    const circ = hexCircumRadius(af);
    const N = ctx.seg(36, 18);
    const bend = af + 0.4;
    // centre line of the short arm sits one circumradius above y = 0
    const c0 = circ;
    const ballSteps = ctx.seg(8, 4);
    const startEnd = endStations(af, N, p.ballEnd === 'both', ballSteps);
    const finalEnd = endStations(af, N, p.ballEnd !== 'none', ballSteps);
    const endLength = (e: readonly EndStation[]): number => (e[e.length - 1] as EndStation).d;
    // the ball end has to fit on the straight part of its arm, otherwise the sweep folds back at the bend
    const xTip = Math.max(p.shortArm - af * 0.55, bend + endLength(startEnd) + 2);
    const yTip = Math.max(p.longArm, c0 + bend + endLength(finalEnd) + 4);

    const stations: SweepStation[] = [];
    // short arm: path runs from the tip towards -x
    for (const e of startEnd) stations.push({ c: [xTip - e.d, c0], t: [-1, 0], ring: e.ring });
    const hex = hexRing(af, N);
    const arcSteps = ctx.seg(12, 6);
    stations.push({ c: [bend, c0], t: [-1, 0], ring: hex });
    for (let k = 1; k < arcSteps; k++) {
      const a = (k / arcSteps) * (Math.PI / 2);
      stations.push({
        c: [bend - bend * Math.sin(a), c0 + bend - bend * Math.cos(a)],
        t: [-Math.cos(a), Math.sin(a)],
        ring: hex,
      });
    }
    stations.push({ c: [0, c0 + bend], t: [0, 1], ring: hex });
    for (const e of [...finalEnd].reverse()) {
      stations.push({ c: [0, yTip - e.d], t: [0, 1], ring: e.ring });
    }

    const mat = finishMaterial(p.finish, p.keyColor);
    return {
      parts: [
        { name: 'key', role: 'body', material: mat, mesh: sweepPlanar(stations), crease: 35 },
      ],
      hang: { point: [0, c0 + bend + 12, 0], kind: 'neck' },
      zones: [
        { name: 'bend', y0: 0, y1: c0 + bend },
        { name: 'long-arm', y0: c0 + bend, y1: yTip },
      ],
      dims: {
        length: yTip,
        size: af,
        longArm: yTip,
        shortArm: xTip + af * 0.55,
        shaftDiameter: 2 * circ,
        width: xTip + circ,
        thickness: af,
        tipWidth: af,
      },
    };
  },
});
