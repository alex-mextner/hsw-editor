/**
 * F bar clamp (screw type) and quick-release trigger bar clamp. Axis +Y along the flat steel rail; y = 0 is the
 * outer end of the fixed head (the screw T-handle or the fixed jaw), the sliding head rides on the rail.
 * Sizes: opening 150 .. 700 mm, throat (rail to pressing axis) 50 .. 140 mm; common catalogue pairs
 * 300 x 80, 600 x 100 (Bessey / Irwin Quick-Grip 300 x 63).
 */
import { type V2 } from '../../math.ts';
import { at, extrude, lathe, loft, place, rotZ, tube } from '../../build/primitives.ts';
import { circleRing } from '../../build/rings.ts';
import { METALS, paint, plastic, rubber } from '../../materials.ts';
import type { Part } from '../../model.ts';
import { L, choice, color, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { type Mesh, boundsOf, mergeMeshes } from '../../mesh.ts';
import { poseDims } from './crossing.ts';
import { threadedRod } from './clamp-kit.ts';
import { arcPoints, roundedOutline } from './kit.ts';

const schema = {
  style: choice(L('Type', 'Тип'), ['screw', 'quick'] as const, 'screw'),
  opening: num(L('Maximum opening', 'Раскрытие'), 300, 150, 700, { step: 10, dimension: true }),
  jawGap: num(L('Current jaw gap', 'Текущий зазор'), 140, 0, 700, { step: 1 }),
  throat: num(L('Throat depth', 'Вылет'), 80, 50, 140, { step: 1 }),
  headColor: color(L('Head colour', 'Цвет головок'), '#c8262b'),
  handleColor: color(L('Handle / grip colour', 'Цвет рукояти'), '#1b1c1e'),
};

const RAIL_W = 22;
const RAIL_T = 8;

export const barClamp = defineToolClass({
  id: 'bar-clamp',
  family: 'pliers',
  name: L('Bar clamp (F / quick-release)', 'Струбцина F-образная / быстрозажимная'),
  bankClass: 'clamp',
  keywords: {
    en: [
      'bar clamp',
      'f-clamp',
      'f clamp',
      'quick release clamp',
      'trigger clamp',
      'one hand clamp',
    ],
    ru: ['струбцина', 'f-образная струбцина', 'быстрозажимная струбцина', 'пистолетная струбцина'],
  },
  schema,
  presets: [
    { id: 'bc-f-300', label: L('F-clamp 300 x 80, red', 'F-струбцина 300 x 80'), values: {} },
    {
      id: 'bc-f-600',
      label: L('F-clamp 600 x 100, blue', 'F-струбцина 600 x 100'),
      values: { opening: 600, jawGap: 260, throat: 100, headColor: '#2455a8' },
    },
    {
      id: 'bc-quick-300',
      label: L('Quick-release 300 x 63, yellow', 'Быстрозажимная 300, жёлтая'),
      values: { style: 'quick', throat: 63, headColor: '#f0c326', handleColor: '#1b1c1e' },
    },
    {
      id: 'bc-quick-450',
      label: L('Quick-release 450 x 80, orange', 'Быстрозажимная 450, оранжевая'),
      values: { style: 'quick', opening: 450, jawGap: 200, throat: 80, headColor: '#e8741e' },
    },
  ],
  build(p, ctx) {
    const O = p.opening;
    const reach = RAIL_W / 2 + p.throat;
    const quick = p.style === 'quick';
    // keep the sliding head (and the trigger housing behind it) clear of the end stop
    const gap = Math.min(p.jawGap, O - (quick ? 32 : 0));
    const seg = ctx.seg(24, 12);
    const steps = ctx.seg(5, 3);
    const headMat = paint(p.headColor, 0.45, 'cast head');
    const headH = 26; // head block length along the rail
    const zH = 10;
    const block = (y0: number, y1: number, boss: boolean): Mesh[] => {
      const body = extrude(
        roundedOutline(
          [
            [-RAIL_W / 2 - 5, y0, 3],
            [reach + 12, y0, 6],
            [reach + 12, y1, 6],
            [-RAIL_W / 2 - 5, y1, 3],
          ],
          steps,
        ),
        -zH,
        zH,
        { bevel: 1 },
      );
      const out: Mesh[] = [body];
      if (boss)
        out.push(
          place(
            lathe(
              [
                [13, y0 + 0.5],
                [13, y1 - 0.5],
              ],
              seg,
            ),
            at(reach, 0, 0),
          ),
        );
      return out;
    };
    const parts: Part[] = [];
    // geometry along y
    const yHead0 = quick ? 6 : 36;
    const yHead1 = yHead0 + headH;
    const yPad = quick ? yHead1 + 4 : yHead1 + 14; // screw pad face / fixed pad face
    const yJ0 = yPad + gap; // sliding jaw face (pad outside)
    const yS0 = yJ0 + 4;
    const yS1 = yS0 + headH;
    const yEnd = yPad + O + headH + 40;
    // rail with hang hole near the end stop
    const holeY = yEnd - 9;
    const hole: V2[] = arcPoints(0, holeY, 4.2, 0, 360, ctx.seg(20, 10)).slice(0, ctx.seg(20, 10));
    const rail = extrude(
      roundedOutline(
        [
          [-RAIL_W / 2, quick ? 0 : yHead0 + 4, 0],
          [RAIL_W / 2, quick ? 0 : yHead0 + 4, 0],
          [RAIL_W / 2, yEnd, 4],
          [-RAIL_W / 2, yEnd, 4],
        ],
        4,
      ),
      -RAIL_T / 2,
      RAIL_T / 2,
      { bevel: 0.9, holes: [hole] },
    );
    parts.push({ name: 'rail', role: 'body', material: METALS.zinc, mesh: rail, crease: 35 });
    // end stop
    parts.push({
      name: 'end-stop',
      role: 'body',
      material: headMat,
      mesh: extrude(
        roundedOutline(
          [
            [-RAIL_W / 2 - 3, yEnd - 36, 2],
            [RAIL_W / 2 + 3, yEnd - 36, 2],
            [RAIL_W / 2 + 3, yEnd - 22, 3],
            [-RAIL_W / 2 - 3, yEnd - 22, 3],
          ],
          3,
        ),
        -zH + 2,
        zH - 2,
        { bevel: 0.8 },
      ),
      crease: 45,
    });
    const padMat = rubber('#26272a', 'smooth', 'jaw pad');
    const discAt = (r: number, y0: number, y1: number): Mesh =>
      place(
        lathe(
          [
            [r, y0],
            [r, y1],
          ],
          seg,
        ),
        at(reach, 0, 0),
      );
    if (!quick) {
      parts.push({
        name: 'fixed-head',
        role: 'body',
        material: headMat,
        mesh: mergeMeshes(block(yHead0, yHead1, true)),
        crease: 45,
      });
      parts.push({
        name: 'screw',
        role: 'screw',
        material: METALS.blackOxide,
        mesh: place(
          threadedRod(5.5, 4, yPad - 2, 3.4, ctx.seg(18, 10), ctx.detail),
          at(reach, 0, 0),
        ),
        crease: 40,
      });
      parts.push({
        name: 'swivel-pad',
        role: 'pad',
        material: METALS.zinc,
        mesh: place(
          lathe(
            [
              [4, yPad - 6],
              [11.5, yPad - 4.5],
              [12.2, yPad - 3],
              [12.2, yPad - 0.5],
              [10.5, yPad],
            ],
            seg,
          ),
          at(reach, 0, 0),
        ),
        crease: 40,
      });
      const hr = 3.6;
      const bar = place(
        loft([
          { y: -32, ring: circleRing(hr * 1.45, ctx.seg(14, 8)) },
          { y: -32 + hr * 1.3, ring: circleRing(hr * 1.45, ctx.seg(14, 8)) },
          { y: -32 + hr * 2, ring: circleRing(hr, ctx.seg(14, 8)) },
          { y: 32 - hr * 2, ring: circleRing(hr, ctx.seg(14, 8)) },
          { y: 32 - hr * 1.3, ring: circleRing(hr * 1.45, ctx.seg(14, 8)) },
          { y: 32, ring: circleRing(hr * 1.45, ctx.seg(14, 8)) },
        ]),
        rotZ(90),
        at(reach, 8, 0),
      );
      parts.push({
        name: 'handle-bar',
        role: 'handle',
        material: METALS.blackOxide,
        mesh: bar,
        crease: 40,
      });
    } else {
      parts.push({
        name: 'fixed-head',
        role: 'body',
        material: headMat,
        mesh: mergeMeshes(block(yHead0, yHead1, false)),
        crease: 45,
      });
      parts.push({
        name: 'fixed-pad',
        role: 'pad',
        material: padMat,
        mesh: discAt(15, yHead1, yPad),
        crease: 40,
      });
    }
    // sliding head + pad
    parts.push({
      name: 'slide-head',
      role: 'body',
      material: headMat,
      mesh: mergeMeshes(block(yS0, yS1, false)),
      crease: 45,
    });
    parts.push({
      name: 'slide-pad',
      role: 'pad',
      material: padMat,
      mesh: discAt(15, yJ0, yS0 + 0.5),
      crease: 40,
    });
    if (quick) {
      // pistol grip and trigger on the back of the sliding head
      const gripMat = plastic(p.handleColor, 0.5, 'grip body');
      const housing = extrude(
        roundedOutline(
          [
            [-RAIL_W / 2 - 9, yS1, 4],
            [RAIL_W / 2 + 7, yS1, 4],
            [RAIL_W / 2 + 7, yS1 + 30, 8],
            [-RAIL_W / 2 - 14, yS1 + 34, 10],
          ],
          steps,
        ),
        -zH - 3,
        zH + 3,
        { bevel: 1.4 },
      );
      parts.push({
        name: 'trigger-housing',
        role: 'body',
        material: gripMat,
        mesh: housing,
        crease: 50,
      });
      const gripPath = (
        x0: number,
        y0: number,
        dx: number,
        dy: number,
        n: number,
        z = 0,
      ): [number, number, number][] => {
        const out: [number, number, number][] = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          out.push([x0 + dx * t + 5 * Math.sin(t * Math.PI), y0 + dy * t, z]);
        }
        return out;
      };
      const grip = tube(gripPath(-14, yS1 + 18, -30, 84, 12), (t) => [13 - t * 1.5, 10.5 - t * 1], {
        sides: ctx.seg(18, 10),
        up: [0, 0, 1],
      });
      parts.push({
        name: 'grip',
        role: 'handle',
        material: rubber(p.handleColor, 'ribbed', 'overmould grip'),
        mesh: grip,
        crease: 55,
      });
      const trigger = tube(gripPath(6, yS1 + 12, -26, 50, 10, 17), (t) => [5, 7.4 - t * 1.4], {
        sides: ctx.seg(12, 8),
        up: [0, 0, 1],
      });
      parts.push({
        name: 'trigger',
        role: 'lever',
        material: plastic(p.headColor, 0.4, 'trigger'),
        mesh: trigger,
        crease: 55,
      });
    }
    const measured = poseDims(parts);
    const length = Math.max(yEnd, ...parts.map((q) => boundsOf(q.mesh).max[1]));
    return {
      parts,
      hang: { point: [0, holeY, 0], kind: 'hole', diameterMm: 8.4 },
      zones: [
        { name: 'fixed-head', y0: 0, y1: yPad },
        { name: 'rail', y0: yPad, y1: yEnd },
        ...(length > yEnd ? [{ name: 'grip', y0: yEnd, y1: length }] : []),
      ],
      dims: {
        length,
        ...measured,
        opening: O,
        throat: p.throat,
        railWidth: RAIL_W,
        railThickness: RAIL_T,
      },
    };
  },
});
