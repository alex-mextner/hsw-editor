/**
 * Cutting tools: scissors (household / tailor / electrician) and the snap-off / trapezoid utility knife.
 * Axis +Y from the butt (ring bottoms / knife tail) to the working end; scissors are flat in the XY plane,
 * knives are a lofted body with a flat blade. Sizes: household scissors 21 cm (blades ~100 mm, finger
 * openings ~ 24 x 42 mm, as the HSW scissors with a 103 mm blade), tailor shears 25 cm, electrician
 * scissors 16 cm; utility knives 9 / 18 / 25 mm snap-off blades (100 mm blade, 0.5 mm, 13 mm segments,
 * 59 degree tip) and the 61 x 19 mm trapezoid blade.
 */
import { type V2, clamp, smoothstep } from '../math.ts';
import { type Mesh, boundsOf, mergeBounds, mergeMeshes } from '../mesh.ts';
import { type Station, at, extrude, lathe, loft, place, rotX, rotZ } from '../build/primitives.ts';
import { flutedRing, superellipse } from '../build/rings.ts';
import {
  type Rect,
  circlePoints,
  ellipseLoop,
  hullLoop,
  roundedRectLoop,
  slabs,
} from '../build/flat.ts';
import { METALS, type Material, paint, plastic, rubber } from '../materials.ts';
import type { BuiltTool, Part } from '../model.ts';
import { L, choice, color, num } from '../params.ts';
import { defineToolClass, type BuildCtx } from '../registry.ts';

// ---------------------------------------------------------------------------------------------
// scissors
// ---------------------------------------------------------------------------------------------

const KINDS = ['household', 'tailor', 'electrician'] as const;
type ScissorKind = (typeof KINDS)[number];

interface Ring {
  ra: number;
  rb: number;
}

interface KindSpec {
  baseLen: number;
  bladeFrac: number;
  bladeWidth: number;
  metalThickness: number;
  a: Ring;
  b: Ring;
  grip: number;
}

const KIND_SPECS: Record<ScissorKind, KindSpec> = {
  household: {
    baseLen: 210,
    bladeFrac: 0.49,
    bladeWidth: 18,
    metalThickness: 2,
    a: { ra: 16, rb: 27 },
    b: { ra: 17, rb: 30 },
    grip: 4.4,
  },
  tailor: {
    baseLen: 250,
    bladeFrac: 0.62,
    bladeWidth: 20,
    metalThickness: 2.4,
    a: { ra: 12, rb: 19 },
    b: { ra: 17, rb: 31 },
    grip: 4.2,
  },
  electrician: {
    baseLen: 160,
    bladeFrac: 0.5,
    bladeWidth: 14,
    metalThickness: 2.2,
    a: { ra: 13, rb: 19 },
    b: { ra: 14, rb: 21 },
    grip: 4.4,
  },
};

const scissorSchema = {
  kind: choice(L('Kind', 'Вид'), KINDS, 'household'),
  length: num(L('Overall length', 'Общая длина'), 210, 100, 330, { step: 1 }),
  open: num(L('Opening angle', 'Угол раскрытия'), 20, 0, 60, { step: 1, unit: 'deg' }),
  finish: choice(
    L('Blade finish', 'Покрытие лезвий'),
    ['steel', 'chrome', 'black'] as const,
    'steel',
  ),
  handleColor: color(L('Handle colour', 'Цвет ручек'), '#1b1c1e'),
  accentColor: color(L('Grip rim colour', 'Цвет окантовки'), '#c8262b'),
};

function finishMaterial(f: 'steel' | 'chrome' | 'black'): Material {
  return f === 'chrome' ? METALS.chrome : f === 'black' ? METALS.blackOxide : METALS.steel;
}

const mirror = (loop: readonly V2[], sign: 1 | -1): V2[] =>
  loop.map(([x, y]) => [x * sign, y] as V2);

interface HalfGeom {
  blade: V2[];
  shank: V2[];
  grip: V2[];
  gripHole: V2[];
  rim: V2[];
  rimHole: V2[];
  ringCentre: V2;
  innerRadii: V2;
}

/** One half in its own frame: pivot at the origin, blade towards +Y on the +x side, ring towards -Y/-x. */
function halfGeometry(
  spec: KindSpec,
  ring: Ring,
  kind: ScissorKind,
  s: number,
  bl: number,
  handleSpan: number,
  serrated: boolean,
  ctx: BuildCtx,
): HalfGeom {
  const bw = spec.bladeWidth * s;
  const ra = ring.ra * s;
  const rb = ring.rb * s;
  const n = ctx.seg(40, 16);
  // blade: straight edge on x = 0, convex spine, pointed tip
  const edge: V2[] = [[0, -7 * s]];
  if (kind === 'electrician' && !serrated) {
    edge.push([0, 7 * s], [2.6 * s, 10 * s], [0, 13 * s]);
  }
  if (kind === 'electrician' && serrated && ctx.detail) {
    const teeth = Math.floor((bl * 0.55) / (1.4 * s));
    for (let i = 0; i < teeth; i++) {
      const y = 12 * s + i * 1.4 * s;
      edge.push([0, y], [0.55 * s, y + 0.7 * s]);
    }
  }
  edge.push([0.6 * s, bl]);
  const spine: V2[] = [];
  const steps = ctx.seg(14, 7);
  for (let i = 1; i <= steps; i++) {
    const u = 1 - i / steps;
    const y = bl * u;
    const g = (1 - u ** 1.25) ** 0.9;
    spine.push([0.6 * s + (bw - 0.6 * s) * g, y]);
  }
  const outline: V2[] = [...edge, ...spine, [bw, -2 * s], [bw * 0.8, -8 * s]];
  // The cutting edge is inclined: it starts left of the pivot line and meets it at the tip, so the two
  // blades of a closed pair lie on top of each other instead of side by side.
  const shear = 0.4 * bw;
  const blade: V2[] = outline.map(([x, y]) => [
    x - shear * Math.min(1, Math.max(0, 1 - y / bl)),
    y,
  ]);
  // ring centre and shank direction
  const cx = -(ra + 1.8 * s);
  const cy = -(handleSpan - rb - 1.5 * s);
  const dist = Math.hypot(cx, cy);
  const dx = cx / dist;
  const dy = cy / dist;
  const neck: V2 = [cx - dx * rb * 0.8, cy - dy * rb * 0.8];
  const tailAt = Math.max(16 * s, dist * 0.4);
  const tail: V2 = [dx * tailAt, dy * tailAt];
  const shank = hullLoop([
    ...circlePoints(0, 0, 7.2 * s, 16),
    ...circlePoints(neck[0], neck[1], 3.6 * s, 12),
  ]);
  const outer = ellipseLoop(ra, rb, n, cx, cy);
  const wall = Math.max(3.8 * s, 2.6);
  const grip = hullLoop([...outer, ...circlePoints(tail[0], tail[1], 4.2 * s, 12)]);
  const gripHole = ellipseLoop(ra - wall, rb - wall, n, cx, cy);
  const rim = ellipseLoop(ra + 0.5, rb + 0.5, n, cx, cy);
  const rimHole = ellipseLoop(ra - 2.4 * s, rb - 2.4 * s, n, cx, cy);
  return {
    blade,
    shank,
    grip,
    gripHole,
    rim,
    rimHole,
    ringCentre: [cx, cy],
    innerRadii: [ra - wall, rb - wall],
  };
}

defineToolClass({
  id: 'scissors',
  family: 'cutting',
  name: L('Scissors', 'Ножницы'),
  bankClass: 'scissors',
  keywords: {
    en: ['scissors', 'shears', 'tailor scissors', 'household scissors', 'electrician scissors'],
    ru: ['ножницы', 'ножницы портновские', 'ножницы электрика'],
  },
  schema: scissorSchema,
  presets: [
    {
      id: 'household-black-red',
      label: L('Household scissors, black/red', 'Бытовые ножницы, чёрные/красные'),
      values: { length: 200, open: 18 },
    },
    {
      id: 'household-closed',
      label: L('Household scissors, closed', 'Бытовые ножницы, закрыты'),
      values: { length: 210, open: 0, handleColor: '#2455a8', accentColor: '#ece9e2' },
    },
    {
      id: 'tailor-250',
      label: L('Tailor shears 250 mm', 'Портновские ножницы 250 мм'),
      values: {
        kind: 'tailor',
        length: 250,
        open: 14,
        finish: 'chrome',
        handleColor: '#1b1c1e',
        accentColor: '#e8741e',
      },
    },
    {
      id: 'electrician-160',
      label: L('Electrician scissors 160 mm', 'Ножницы электрика 160 мм'),
      values: {
        kind: 'electrician',
        length: 160,
        open: 24,
        handleColor: '#c8262b',
        accentColor: '#1b1c1e',
      },
    },
    {
      id: 'craft-130',
      label: L('Craft scissors 130 mm', 'Маленькие ножницы 130 мм'),
      values: {
        length: 130,
        open: 28,
        handleColor: '#2f8f4c',
        accentColor: '#1b1c1e',
        finish: 'black',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const spec = KIND_SPECS[p.kind];
    const s = p.length / spec.baseLen;
    const bl = p.length * spec.bladeFrac;
    const handleSpan = p.length - bl;
    const theta = p.open / 2;
    const tz = spec.metalThickness * s;
    const gz = spec.grip * s;
    const bladeMat = finishMaterial(p.finish);
    const handleMat = plastic(p.handleColor, 0.42, 'handle plastic');
    const rimMat = rubber(p.accentColor, 'soft-grip', 'grip rim');

    const parts: Part[] = [];
    const raw: Part[] = [];
    const halves = [
      { side: 1 as const, name: 'a', ring: spec.a, zc: 0.05 + tz / 2, rot: -theta },
      { side: -1 as const, name: 'b', ring: spec.b, zc: -(0.05 + tz / 2), rot: theta },
    ];
    const ringInfo: { x: number; y: number; w: number; h: number }[] = [];
    for (const h of halves) {
      const g = halfGeometry(spec, h.ring, p.kind, s, bl, handleSpan, h.side === -1, ctx);
      const mir = (l: readonly V2[]): V2[] => mirror(l, h.side);
      const z0 = h.zc - tz / 2;
      const z1 = h.zc + tz / 2;
      const bevel = Math.min(0.25, tz / 5);
      const metal = mergeMeshes([
        extrude(mir(g.blade), z0, z1, { bevel }),
        extrude(mir(g.shank), z0, z1, { bevel }),
      ]);
      const grip = extrude(mir(g.grip), h.zc - gz, h.zc + gz, {
        holes: [mir(g.gripHole)],
        bevel: Math.min(1.6 * s + 0.4, gz * 0.5),
      });
      const rim = extrude(mir(g.rim), h.zc - gz - 0.35, h.zc + gz + 0.35, {
        holes: [mir(g.rimHole)],
        bevel: 0.5,
      });
      const toWorld = (m: Mesh): Mesh => place(m, rotZ(h.rot), at(0, handleSpan, 0));
      raw.push(
        {
          name: `blade-${h.name}`,
          role: 'blade',
          material: bladeMat,
          mesh: toWorld(metal),
          crease: 35,
        },
        {
          name: `handle-${h.name}`,
          role: 'handle',
          material: handleMat,
          mesh: toWorld(grip),
          crease: 40,
        },
        { name: `rim-${h.name}`, role: 'grip', material: rimMat, mesh: toWorld(rim), crease: 40 },
      );
      if (h.side === 1) {
        const c = mir([g.ringCentre])[0] as V2;
        const a = (h.rot * Math.PI) / 180;
        ringInfo.push({
          x: c[0] * Math.cos(a) - c[1] * Math.sin(a),
          y: handleSpan + c[0] * Math.sin(a) + c[1] * Math.cos(a),
          w: g.innerRadii[0] * 2,
          h: g.innerRadii[1] * 2,
        });
      }
    }
    // pivot screw (head on +z, nut on -z), upright through both halves
    const zTop = 0.05 + tz;
    const seg = ctx.seg(24, 12);
    const head = lathe(
      [
        [0, 0],
        [5 * s + 0.6, 0],
        [5 * s + 0.6, 0.6],
        [4 * s, 1.5 * s + 0.6],
        [0, 1.9 * s + 0.6],
      ],
      seg,
    );
    const nut = lathe(
      [
        [0, 0],
        [4.4 * s + 0.6, 0],
        [4.4 * s + 0.6, 0.8],
        [3.4 * s, 1.5 * s + 0.6],
        [0, 1.6 * s + 0.6],
      ],
      seg,
    );
    const shaft = lathe(
      [
        [1.9 * s, -zTop - 0.2],
        [1.9 * s, zTop + 0.2],
      ],
      ctx.seg(14, 8),
    );
    raw.push({
      name: 'pivot-screw',
      role: 'fastener',
      material: METALS.darkSteel,
      mesh: mergeMeshes([
        place(head, rotX(90), at(0, handleSpan, zTop)),
        place(nut, rotX(-90), at(0, handleSpan, -zTop)),
        place(shaft, rotX(90), at(0, handleSpan, 0)),
      ]),
      crease: 40,
    });

    // rest the tool on its lowest point (origin at the butt)
    const minY = mergeBounds(raw.map((r) => boundsOf(r.mesh))).min[1];
    for (const r of raw) parts.push({ ...r, mesh: place(r.mesh, at(0, -minY, 0)) });
    const bb = mergeBounds(parts.map((r) => boundsOf(r.mesh)));
    const yp = handleSpan - minY;
    const top = bb.max[1];
    const h0 = ringInfo[0];
    if (!h0) throw new Error('scissors: ring geometry missing');
    return {
      parts,
      hang: { point: [h0.x, h0.y - minY, 0], kind: 'hole', diameterMm: h0.w },
      zones: [
        { name: 'handles', y0: 0, y1: yp },
        { name: 'blades', y0: yp, y1: top },
      ],
      dims: {
        length: top,
        bladeLength: bl,
        bladeWidth: spec.bladeWidth * s,
        width: bb.max[0] - bb.min[0],
        thickness: bb.max[2] - bb.min[2],
        ringOpeningWidth: h0.w,
        ringOpeningHeight: h0.h,
        openAngle: p.open,
      },
    };
  },
});

// ---------------------------------------------------------------------------------------------
// utility-knife: snap-off / trapezoid-blade knife with slider, lock wheel and soft-grip sleeve
// ---------------------------------------------------------------------------------------------

const knifeSchema = {
  style: choice(L('Body', 'Корпус'), ['plastic', 'metal'] as const, 'plastic'),
  blade: choice(L('Blade', 'Лезвие'), ['snap-off', 'trapezoid'] as const, 'snap-off'),
  bladeWidth: num(L('Blade width', 'Ширина лезвия'), 18, 9, 25, { step: 1 }),
  bodyLength: num(L('Body length', 'Длина корпуса'), 135, 110, 175, { step: 1 }),
  bladeOut: num(L('Blade extension', 'Выдвижение лезвия'), 30, 0, 60, { step: 1 }),
  bodyColor: color(L('Body colour', 'Цвет корпуса'), '#f0c326'),
  gripColor: color(L('Grip colour', 'Цвет накладки'), '#1b1c1e'),
};

defineToolClass({
  id: 'utility-knife',
  family: 'cutting',
  name: L('Utility knife', 'Канцелярский / строительный нож'),
  bankClass: 'knife',
  keywords: {
    en: ['utility knife', 'box cutter', 'snap-off knife', 'cutter knife', 'stanley knife'],
    ru: ['нож', 'канцелярский нож', 'строительный нож', 'монтажный нож'],
  },
  schema: knifeSchema,
  presets: [
    {
      id: 'snap-off-18-yellow',
      label: L('Snap-off 18 mm, yellow', 'Нож 18 мм, жёлтый'),
      values: {},
    },
    {
      id: 'snap-off-9-small',
      label: L('Snap-off 9 mm, small', 'Нож 9 мм, малый'),
      values: {
        bladeWidth: 9,
        bodyLength: 118,
        bladeOut: 22,
        bodyColor: '#e8741e',
        gripColor: '#1b1c1e',
      },
    },
    {
      id: 'snap-off-25-heavy',
      label: L('Snap-off 25 mm, heavy', 'Нож 25 мм, усиленный'),
      values: {
        bladeWidth: 25,
        bodyLength: 165,
        bladeOut: 40,
        bodyColor: '#c8262b',
        gripColor: '#1b1c1e',
      },
    },
    {
      id: 'trapezoid-metal',
      label: L('Trapezoid blade, die-cast body', 'Нож с трапециевидным лезвием, металл'),
      values: {
        style: 'metal',
        blade: 'trapezoid',
        bladeWidth: 19,
        bodyLength: 150,
        bladeOut: 22,
        bodyColor: '#5d6066',
      },
    },
    {
      id: 'snap-off-18-retracted',
      label: L('Snap-off 18 mm, blade retracted', 'Нож 18 мм, лезвие убрано'),
      values: { bladeOut: 0, bodyColor: '#2455a8', gripColor: '#e8741e' },
    },
  ],
  build(p, ctx): BuiltTool {
    const bw = p.bladeWidth;
    const Lb = p.bodyLength;
    const metalBody = p.style === 'metal';
    const Wm = bw + (metalBody ? 6.5 : 5.5);
    const Tm = (9 + bw * 0.2) * (metalBody ? 0.9 : 1);
    const nBody = metalBody ? 5.5 : 3.2;
    const count = ctx.seg(44, 16);
    const butt = Tm * 0.55;
    const noseStart = 0.55 * Lb;

    /** Rounded tail and chamfered nose, shared by the width and thickness profiles. */
    const endShape = (y: number): number => {
      const round = y < butt ? Math.sqrt(Math.max(0, 1 - (1 - y / butt) ** 2)) : 1;
      const chamfer = y > Lb - 2.4 ? 1 - 0.1 * ((y - (Lb - 2.4)) / 2.4) : 1;
      return round * chamfer;
    };
    const widthAt = (y: number): number =>
      Wm * (1 - 0.11 * smoothstep(0.5, 1, y / Lb)) * endShape(y);
    const thickAt = (y: number): number =>
      Tm * (1 - 0.34 * smoothstep(0.55, 1, y / Lb)) * endShape(y);
    const ys: number[] = [];
    for (let i = 0; i <= count; i++) ys.push((Lb * i) / count);
    for (const f of [0.04, 0.15, 0.35, 0.6, 0.85]) ys.push(butt * f);
    for (const d of [0.8, 1.6, 2.4]) ys.push(Lb - d);
    ys.sort((a, b) => a - b);
    const yList = ys.filter((y, i) => i === 0 || y - (ys[i - 1] as number) > 1e-4);
    const ringCount = ctx.seg(40, 16);
    const bodyStations: Station[] = yList.map((y) => {
      let w = widthAt(y);
      if (metalBody && ctx.detail && y > 0.12 * Lb && y < 0.52 * Lb) {
        const ripple = 0.5 + 0.5 * Math.cos(((y - 0.12 * Lb) / 2.6) * Math.PI * 2);
        w -= 0.9 * ripple;
      }
      return { y, ring: superellipse(w / 2, thickAt(y) / 2, nBody, ringCount) };
    });
    const bodyMat: Material = metalBody
      ? {
          name: 'die-cast alloy',
          kind: 'metal',
          color: p.bodyColor,
          metallic: 0.6,
          roughness: 0.4,
          alpha: 1,
        }
      : plastic(p.bodyColor, 0.38, 'body plastic');
    const parts: Part[] = [
      { name: 'body', role: 'body', material: bodyMat, mesh: loft(bodyStations), crease: 45 },
    ];

    if (!metalBody) {
      // soft-grip sleeve with finger ribs
      const gy0 = 0.13 * Lb;
      const gy1 = 0.52 * Lb;
      const pitch = 3.4;
      const per = ctx.detail ? 4 : 1;
      const n = Math.max(2, Math.round(((gy1 - gy0) / pitch) * per));
      const stations: Station[] = [];
      for (let i = 0; i <= n; i++) {
        const y = gy0 + ((gy1 - gy0) * i) / n;
        const edge = smoothstep(0, 0.07, i / n) * (1 - smoothstep(0.93, 1, i / n));
        const rib = ctx.detail ? 0.5 + 0.5 * Math.cos(((y - gy0) / pitch) * Math.PI * 2) : 0.5;
        const grow = 0.35 + 0.45 * rib * edge;
        const g = edge < 1 ? Math.max(0.05, edge) : 1;
        stations.push({
          y,
          ring: superellipse(
            widthAt(y) / 2 + grow * g,
            thickAt(y) / 2 + grow * g,
            nBody,
            ringCount,
          ),
        });
      }
      parts.push({
        name: 'grip',
        role: 'grip',
        material: rubber(p.gripColor, 'ribbed', 'soft grip'),
        mesh: loft(stations),
        crease: 40,
      });
    }

    // nose reinforcement sleeve
    const noseStations: Station[] = yList
      .filter((y) => y >= Lb - 24)
      .map((y) => ({
        y,
        ring: superellipse(widthAt(y) / 2 + 0.4, thickAt(y) / 2 + 0.4, nBody, ringCount),
      }));
    noseStations.push({
      y: Lb + 0.3,
      ring: superellipse(widthAt(Lb) / 2 + 0.4, thickAt(Lb) / 2 + 0.4, nBody, ringCount),
    });
    parts.push({
      name: 'nose',
      role: 'ferrule',
      material: METALS.chrome,
      mesh: loft(noseStations),
      crease: 40,
    });

    // slider in its slot on the +Z face
    const slotY0 = 0.58 * Lb;
    const slotY1 = 0.9 * Lb;
    const slider = 15;
    const travel = slotY1 - slotY0 - slider;
    const sy = slotY0 + slider / 2 + clamp(p.bladeOut / 60, 0, 1) * travel;
    const slotMeshes: Mesh[] = [];
    const step = ctx.seg(3, 8);
    for (let y = slotY0; y < slotY1 - 1e-6; y += step) {
      const y1 = Math.min(slotY1, y + step);
      const zt = thickAt((y + y1) / 2) / 2;
      slotMeshes.push(slabs([[-2.8, y, 2.8, y1]], zt - 0.2, zt + 0.05));
    }
    parts.push({
      name: 'slot',
      role: 'marks',
      material: paint('#101113', 0.7, 'slot'),
      mesh: mergeMeshes(slotMeshes),
      crease: 20,
    });
    const zSlider = thickAt(sy - slider / 2) / 2;
    parts.push({
      name: 'slider',
      role: 'button',
      material: rubber(p.gripColor, 'ribbed', 'slider'),
      mesh: extrude(
        roundedRectLoop(-4.8, sy - slider / 2, 4.8, sy + slider / 2, 2.2, ctx.seg(4, 2)),
        zSlider - 1.4,
        zSlider + 3.2,
        {
          bevel: 0.9,
        },
      ),
      crease: 40,
    });
    if (ctx.detail) {
      const ribs: Rect[] = [];
      for (let i = 0; i < 5; i++) {
        const y = sy - 5.2 + i * 2.6;
        ribs.push([-4.2, y - 0.4, 4.2, y + 0.4]);
      }
      parts.push({
        name: 'slider-ribs',
        role: 'grip',
        material: paint('#101113', 0.6, 'slider ribs'),
        mesh: slabs(ribs, zSlider + 3.2 - 0.1, zSlider + 3.2 + 0.35),
        crease: 20,
      });
    }
    // lock wheel at the tail
    const wheelR = Math.min(7.5, Wm * 0.34);
    const wheelRing = flutedRing(wheelR, ctx.seg(16, 8), 0.5, ctx.seg(128, 48));
    const wy = Math.max(wheelR + 2.5, 0.075 * Lb + 3);
    parts.push({
      name: 'lock-wheel',
      role: 'knob',
      material: metalBody ? METALS.zinc : plastic(p.gripColor, 0.5, 'lock wheel'),
      mesh: place(
        loft([
          { y: 0, ring: wheelRing },
          { y: 2.8, ring: wheelRing },
        ]),
        rotX(90),
        at(0, wy, thickAt(wy) / 2 - 1.2),
      ),
      crease: 30,
    });

    // blade
    const bt = p.blade === 'snap-off' ? 0.5 : 0.65;
    const yTip = Lb + p.bladeOut;
    const bladeMat = METALS.polishedSteel;
    if (p.blade === 'snap-off') {
      const yBack = Lb - 52;
      const slant = 0.6 * bw;
      const outline: V2[] = [
        [-bw / 2, yBack],
        [bw / 2, yBack],
        [bw / 2, yTip],
        [-bw / 2, yTip - slant],
      ];
      parts.push({
        name: 'blade',
        role: 'blade',
        material: bladeMat,
        mesh: extrude(outline, -bt / 2, bt / 2, { bevel: 0.14 }),
        crease: 35,
      });
      const lines: Mesh[] = [];
      for (let k = 1; k <= 4; k++) {
        const yl = yTip - slant - 13 * k;
        if (yl + slant < Lb + 0.5) break;
        lines.push(
          extrude(
            [
              [-bw / 2 + 0.2, yl],
              [bw / 2 - 0.2, yl + slant - 0.2],
              [bw / 2 - 0.2, yl + slant + 0.35],
              [-bw / 2 + 0.2, yl + 0.55],
            ],
            -bt / 2 - 0.06,
            bt / 2 + 0.06,
          ),
        );
      }
      if (lines.length > 0 && ctx.detail)
        parts.push({
          name: 'snap-lines',
          role: 'marks',
          material: paint('#5b5f66', 0.5, 'snap line'),
          mesh: mergeMeshes(lines),
          crease: 20,
        });
    } else {
      const lenB = 61;
      const outline: V2[] = [
        [bw / 2, yTip - lenB],
        [bw / 2, yTip],
        [-bw / 2, yTip - bw],
        [-bw / 2, yTip - lenB + bw],
      ];
      const slotLoop = roundedRectLoop(
        -1.6,
        yTip - lenB / 2 - 8,
        1.6,
        yTip - lenB / 2 + 8,
        1.5,
        ctx.seg(3, 1),
      );
      parts.push({
        name: 'blade',
        role: 'blade',
        material: bladeMat,
        mesh: extrude(outline, -bt / 2, bt / 2, { holes: [slotLoop], bevel: 0.14 }),
        crease: 35,
      });
    }
    const bb = mergeBounds(parts.map((part) => boundsOf(part.mesh)));
    return {
      parts,
      hang: { point: [0, 2, 0], kind: 'butt' },
      zones: [
        { name: 'tail', y0: 0, y1: 0.13 * Lb },
        { name: 'grip', y0: 0.13 * Lb, y1: noseStart },
        { name: 'nose', y0: noseStart, y1: Lb },
        { name: 'blade', y0: Lb, y1: Lb + Math.max(p.bladeOut, 1) },
      ],
      dims: {
        length: Lb + p.bladeOut,
        bodyLength: Lb,
        width: bb.max[0] - bb.min[0],
        thickness: bb.max[2] - bb.min[2],
        bladeWidth: bw,
        bladeOut: p.bladeOut,
      },
    };
  },
});
