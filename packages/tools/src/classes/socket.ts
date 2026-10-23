/**
 * Socket (wrench head) for ratchets: 6- or 12-point hex cavity at the working end, square drive recess
 * (1/4, 3/8, 1/2 in) at the other end, shallow or deep, polished chrome or black impact finish.
 * Frame: the drive end is at y = 0, the working end at y = length. Typical lengths: 1/4 in 25 / 50 mm,
 * 3/8 in 30 / 63 mm, 1/2 in 38 / 78 mm (shallow / deep). The body is one closed shell: an outer surface of
 * revolution, an inner cavity (square recess -> round bore -> hex) and flat annular end faces, built
 * by `hollowShell` from two stacks of equally sampled rings so it stays watertight at every setting.
 */
import { DEG, type V2, lerp, smoothstep } from '../math.ts';
import { type Mesh, ensureOutward } from '../mesh.ts';
import { METALS, paint, rubber } from '../materials.ts';
import { L, choice, num } from '../params.ts';
import { defineToolClass } from '../registry.ts';
import type { BuiltTool, Part } from '../model.ts';
import { type Station, at, place, torus } from '../build/primitives.ts';
import { polarRing, polygonPolar } from '../build/profile.ts';
import { DRIVES, DRIVE_MM, wrapText } from './wrench-shared.ts';

/**
 * Closed solid of revolution-like body with a cavity: `outer` and `inner` run bottom to top (ascending y,
 * equal y allowed for flat steps). Rings are star-shaped about the Y axis, indexed by increasing angle.
 * The bottom and top annuli join the outer and inner rings of the first / last stations.
 */
function hollowShell(outer: readonly Station[], inner: readonly Station[]): Mesh {
  const n = (outer[0] as Station).ring.length;
  const positions: number[] = [];
  const indices: number[] = [];
  const stack = (stations: readonly Station[]): number[] => {
    const rows: number[] = [];
    for (const st of stations) {
      rows.push(positions.length / 3);
      for (const [x, z] of st.ring) positions.push(x, st.y, z);
    }
    return rows;
  };
  const o = stack(outer);
  const i = stack(inner);
  for (let s = 0; s < o.length - 1; s++) {
    const a = o[s] as number;
    const b = o[s + 1] as number;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      indices.push(a + k, b + j, a + j, a + k, b + k, b + j);
    }
  }
  for (let s = 0; s < i.length - 1; s++) {
    const a = i[s] as number;
    const b = i[s + 1] as number;
    for (let k = 0; k < n; k++) {
      const j = (k + 1) % n;
      indices.push(a + k, a + j, b + j, a + k, b + j, b + k);
    }
  }
  const oBottom = o[0] as number;
  const iBottom = i[0] as number;
  const oTop = o[o.length - 1] as number;
  const iTop = i[i.length - 1] as number;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    indices.push(oBottom + k, oBottom + j, iBottom + j, oBottom + k, iBottom + j, iBottom + k);
    indices.push(oTop + k, iTop + j, oTop + j, oTop + k, iTop + k, iTop + j);
  }
  return ensureOutward({ positions, indices });
}

const schema = {
  size: num(L('Hex size (across flats)', 'Размер под ключ'), 13, 6, 32, { step: 1 }),
  drive: choice(L('Drive square', 'Квадрат'), DRIVES, '3/8'),
  length: num(L('Overall length', 'Общая длина'), 30, 18, 120, { step: 1 }),
  points: choice(L('Points', 'Граней'), ['6', '12'] as const, '12'),
  finish: choice(L('Finish', 'Покрытие'), ['chrome', 'impact'] as const, 'chrome'),
};

export const socket = defineToolClass({
  id: 'socket',
  family: 'wrenches',
  name: L('Socket', 'Торцевая головка'),
  bankClass: 'wrench',
  keywords: {
    en: ['socket', 'wrench socket', 'ratchet socket', 'deep socket', 'impact socket'],
    ru: ['торцевая головка', 'головка', 'торцовая головка'],
  },
  schema,
  presets: [
    {
      id: '3-8-13-shallow',
      label: L('3/8 in, 13 mm shallow', '3/8", 13 мм, короткая'),
      values: { size: 13, drive: '3/8', length: 30, points: '12', finish: 'chrome' },
    },
    {
      id: '3-8-10-deep',
      label: L('3/8 in, 10 mm deep', '3/8", 10 мм, длинная'),
      values: { size: 10, drive: '3/8', length: 63, points: '6', finish: 'chrome' },
    },
    {
      id: '1-4-8-shallow',
      label: L('1/4 in, 8 mm shallow', '1/4", 8 мм, короткая'),
      values: { size: 8, drive: '1/4', length: 25, points: '6', finish: 'chrome' },
    },
    {
      id: '1-2-19-impact',
      label: L('1/2 in, 19 mm impact', '1/2", 19 мм, ударная'),
      values: { size: 19, drive: '1/2', length: 40, points: '6', finish: 'impact' },
    },
    {
      id: '1-2-24-deep-impact',
      label: L('1/2 in, 24 mm deep impact', '1/2", 24 мм, ударная длинная'),
      values: { size: 24, drive: '1/2', length: 78, points: '6', finish: 'impact' },
    },
    {
      id: '1-2-32-chrome',
      label: L('1/2 in, 32 mm chrome', '1/2", 32 мм, хром'),
      values: { size: 32, drive: '1/2', length: 46, points: '12', finish: 'chrome' },
    },
  ],
  build(p, ctx): BuiltTool {
    const sq = DRIVE_MM[p.drive];
    const impact = p.finish === 'impact';
    const N = ctx.seg(144, 48);
    const S = p.size;
    const recess = Math.min(sq * 1.1, 14.5);
    const web = 3;
    const Lt = Math.max(p.length, recess + web + 6);

    // Cavity: square recess, round bore, hex (or 12-point) pocket, each with an entry chamfer.
    const hexA = polygonPolar(6, S / 2 + 0.1, 0);
    const hexB = polygonPolar(6, S / 2 + 0.1, 30 * DEG);
    const cavity = (t: number): number =>
      p.points === '12' ? Math.max(hexA(t), hexB(t)) : hexA(t);
    const square = polygonPolar(4, sq / 2 + 0.12, 0);
    const hexCorner = (S / 2 + 0.1) / Math.cos(30 * DEG);
    const squareCorner = (sq / 2 + 0.12) / Math.cos(45 * DEG);
    const bore = 0.36 * Math.min(S, sq * 1.2);
    const scaled = (f: (t: number) => number, k: number): V2[] => polarRing((t) => f(t) * k, N);
    const inner: (Station & { rmax: number })[] = [
      { y: 0, ring: scaled(square, 1.14), rmax: squareCorner * 1.14 },
      { y: 0.9, ring: scaled(square, 1), rmax: squareCorner },
      { y: recess, ring: scaled(square, 1), rmax: squareCorner },
      { y: recess, ring: polarRing(() => bore, N), rmax: bore },
      { y: recess + web, ring: polarRing(() => bore, N), rmax: bore },
      { y: recess + web, ring: scaled(cavity, 1), rmax: hexCorner },
      { y: Lt - 1.1, ring: scaled(cavity, 1), rmax: hexCorner },
      { y: Lt, ring: scaled(cavity, 1.1), rmax: hexCorner * 1.1 },
    ];
    const innerMaxNear = (y: number): number =>
      Math.max(...inner.filter((s) => Math.abs(s.y - y) <= 1.6).map((s) => s.rmax), 0);

    // Outer profile: drive collar -> short shoulder -> working end wall.
    const wallW = (impact ? 2.8 : 1.9) + 0.05 * S;
    const Rw = hexCorner * 1.06 + wallW;
    const Rb = Math.max(Rw + (impact ? 0.4 : 1.0), squareCorner + (impact ? 3 : 2.5));
    const y1 = Math.min(Math.max(recess + 3, 0.3 * Lt), Lt - 9);
    const y2 = y1 + 4;
    const grooveY = Math.max(2.6, recess * 0.45);
    const grooveDepth = impact ? 0.9 : 0.4;
    const knurl = !impact && ctx.detail && y1 - 0.8 - (grooveY + 1.6) >= 3.5;
    const knurlY0 = grooveY + 1.6;
    const knurlY1 = y1 - 0.8;
    const flutes = 24;
    const profile = (y: number): number => {
      let r = lerp(Rb, Rw, smoothstep(y1, y2, y));
      if (y < 0.9) r *= 0.9 + 0.1 * (y / 0.9);
      if (y > Lt - 0.9) r *= 1 - 0.08 * ((y - (Lt - 0.9)) / 0.9);
      if (ctx.detail && Math.abs(y - grooveY) < 1.0) r -= grooveDepth * (1 - Math.abs(y - grooveY));
      return r;
    };
    const ys = new Set<number>([0, 0.9, y1, y2, Lt - 0.9, Lt, recess, recess + web]);
    ys.add(lerp(y1, y2, 0.33)).add(lerp(y1, y2, 0.66));
    if (ctx.detail) {
      for (const d of [-1, -0.5, 0, 0.5, 1]) ys.add(grooveY + d);
    }
    if (knurl) {
      ys.add(knurlY0)
        .add(knurlY0 + 0.4)
        .add(knurlY1 - 0.4)
        .add(knurlY1);
    }
    const knurlAt = (y: number): number =>
      knurl ? Math.max(0, Math.min(1, Math.min((y - knurlY0) / 0.4, (knurlY1 - y) / 0.4))) : 0;
    const outer: Station[] = [...ys]
      .filter((y) => y >= 0 && y <= Lt)
      .sort((a, b) => a - b)
      .map((y) => {
        const r = Math.max(profile(y), innerMaxNear(y) + 1);
        const f = knurlAt(y);
        return {
          y,
          ring: polarRing((t) => r * (1 - 0.025 * f * (0.5 - 0.5 * Math.cos(flutes * t))), N),
        };
      });

    const finishMat =
      p.finish === 'chrome'
        ? METALS.chrome
        : { ...METALS.blackOxide, name: 'phosphated steel', roughness: 0.55 };
    const parts: Part[] = [
      {
        name: 'body',
        role: 'body',
        material: finishMat,
        mesh: hollowShell(outer, inner),
        crease: 35,
      },
    ];
    if (impact && ctx.detail) {
      parts.push({
        name: 'retaining-ring',
        role: 'ring',
        material: rubber('#1b1c1e', 'smooth', 'o-ring'),
        mesh: place(torus(profile(grooveY) + 0.1, 0.8, 48, 8), at(0, grooveY, 0)),
      });
    }
    const label = Number.isInteger(S) ? `${S}` : S.toFixed(1);
    const textSpan = Lt - 2 - (y2 + 1);
    if (ctx.detail && textSpan >= 6) {
      const pixel = Math.min(0.55, (textSpan - 1) / 9, (0.8 * Rw) / (6 * label.length));
      const stamp = wrapText(label, Rw, (y2 + 1 + Lt - 2) / 2, pixel, 0.3, 0.2);
      if (stamp) {
        parts.push({
          name: 'marking',
          role: 'label',
          material: impact ? paint('#ece9e2') : METALS.polishedSteel,
          mesh: stamp,
        });
      }
    }
    return {
      parts,
      hang: { point: [0, 0, 0], kind: 'hole', diameterMm: sq },
      zones: [
        { name: 'drive-end', y0: 0, y1: y1 },
        { name: 'body', y0: y1, y1: y2 },
        { name: 'working-end', y0: y2, y1: Lt },
      ],
      dims: {
        length: Lt,
        outerDiameter: 2 * Math.max(Rb, Rw),
        workingDiameter: 2 * Rw,
        driveSquare: sq,
        size: S,
        hexDepth: Lt - recess - web,
      },
    };
  },
});
