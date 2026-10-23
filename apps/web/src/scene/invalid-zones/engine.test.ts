import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_BOARD,
  boardSizeMm,
  PoseSchema,
  type Aabb,
  type ItemKind,
  type Pose,
} from '@hsw-editor/core';
import { InvalidZoneEngine, type EngineItem, type SolidMesh, type SolveResult } from './engine.ts';
import { readGlbSolid } from './glb.ts';
import { loadManifold, type ManifoldToplevel } from './manifold.ts';
import { deepestVertexInside } from './oracle.testkit.ts';

const FIXTURES = new URL('./__fixtures__/', import.meta.url);
const HOLDERS = [
  'scissors-slot-slots1-bladethickness4',
  'bit-block-bitsperrow14-rows1',
  'cup-round-innerdiameter30-cupheight40',
] as const;

let wasm: ManifoldToplevel;
const meshes = new Map<string, SolidMesh>();

beforeAll(async () => {
  wasm = await loadManifold();
  for (const name of HOLDERS) {
    const bytes = readFileSync(new URL(`${name}.glb`, FIXTURES));
    meshes.set(
      name,
      await readGlbSolid(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    );
  }
});

const pose = (partial: Partial<Pose> = {}): Pose => PoseSchema.parse(partial);
const box = (min: [number, number, number], max: [number, number, number]): Aabb => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
});
const item = (
  id: string,
  solidKey: string,
  at: Partial<Pose>,
  extra: { kind?: ItemKind; parentId?: string } = {},
): EngineItem => ({ id, kind: extra.kind ?? 'holder', solidKey, pose: pose(at), ...extra });

/** Fresh engine with a 20 mm cube (z 0..20, centred on x/y) and the three real bank holders. */
function newEngine(): InvalidZoneEngine {
  const engine = new InvalidZoneEngine(wasm);
  engine.defineSolid('cube20', { kind: 'box', box: box([-10, -10, 0], [10, 10, 20]) });
  for (const [name, mesh] of meshes) engine.defineSolid(name, { kind: 'mesh', mesh });
  return engine;
}

const overlaps = (result: SolveResult) => result.reasons.filter((r) => r.kind === 'overlap');
const bounds = (result: SolveResult) => result.reasons.filter((r) => r.kind === 'out-of-board');

describe('synthetic boxes: exactness', () => {
  test('partial overlap: region volume equals the analytic 5 x 20 x 20 within 1%', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('b', 'cube20', { x: 115, y: 100 }),
    ]);
    const [forA, forB] = overlaps(result);
    expect(overlaps(result)).toHaveLength(2);
    expect(forA?.kind === 'overlap' && forA.volumeMm3).toBeCloseTo(2000, 0);
    expect(Math.abs((forA?.kind === 'overlap' ? forA.volumeMm3 : 0) - 2000) / 2000).toBeLessThan(
      0.01,
    );
    expect(forA?.kind === 'overlap' && forA.depthMm).toBeCloseTo(5, 6);
    expect(forA?.itemId).toBe('a');
    expect(forB?.itemId).toBe('b');
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0]?.itemIds).toEqual(['a', 'b']);
    expect(result.regions[0]?.positions.length).toBeGreaterThan(0);
    // the overlap of two cubes is a box: 12 outline segments of 2 xyz endpoints
    expect(result.regions[0]?.edges.length).toBe(12 * 2 * 3);
    engine.dispose();
  });

  test('45 degree rotated cube: octagon prism volume matches 800 * tan(22.5 deg) * 20 within 1%', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('b', 'cube20', { x: 100, y: 100, rotZ: 45 }),
    ]);
    const expected = 8 * 10 * 10 * Math.tan(Math.PI / 8) * 20;
    const reason = overlaps(result)[0];
    expect(reason?.kind === 'overlap' && reason.volumeMm3).toBeDefined();
    const volume = reason?.kind === 'overlap' ? reason.volumeMm3 : 0;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(0.01);
    engine.dispose();
  });

  test('touching faces (x, y and z) produce no region', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('right', 'cube20', { x: 120, y: 100 }),
      item('above', 'cube20', { x: 100, y: 120 }),
      item('onTop', 'cube20', { x: 100, y: 100, z: 20 }),
    ]);
    expect(result.reasons).toEqual([]);
    expect(result.regions).toEqual([]);
    engine.dispose();
  });

  test('contact tolerance: 0.04 mm is contact, 0.06 mm is an overlap', () => {
    const engine = newEngine();
    const shallow = engine.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('b', 'cube20', { x: 119.96, y: 100 }),
    ]);
    expect(shallow.reasons).toEqual([]);
    const deeper = engine.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('b', 'cube20', { x: 119.94, y: 100 }),
    ]);
    const reason = overlaps(deeper)[0];
    expect(reason?.kind === 'overlap' && reason.depthMm).toBeCloseTo(0.06, 4);
    engine.dispose();
  });

  test('tolerances are configurable', () => {
    const strict = new InvalidZoneEngine(wasm, { depthMm: 0.001, volumeMm3: 0.001 });
    strict.defineSolid('cube20', { kind: 'box', box: box([-10, -10, 0], [10, 10, 20]) });
    const result = strict.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('b', 'cube20', { x: 119.99, y: 100 }),
    ]);
    expect(overlaps(result)).toHaveLength(2);
    strict.dispose();
  });

  test('a tool overlapping its parent holder is a mating contact; an unrelated tool is not', () => {
    const engine = newEngine();
    const items = [
      item('h', 'cube20', { x: 100, y: 100 }),
      item('t', 'cube20', { x: 105, y: 100, z: 5 }, { kind: 'tool', parentId: 'h' }),
    ];
    expect(engine.solve(DEFAULT_BOARD, items).reasons).toEqual([]);
    const unrelated = engine.solve(DEFAULT_BOARD, [
      item('h', 'cube20', { x: 100, y: 100 }),
      item('t', 'cube20', { x: 105, y: 100, z: 5 }, { kind: 'tool' }),
    ]);
    expect(overlaps(unrelated)).toHaveLength(2);
    engine.dispose();
  });

  test('photo references are neither collision partners nor bounds-checked', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('p', 'cube20', { x: 100, y: 100 }, { kind: 'photo-ref' }),
      item('edge', 'cube20', { x: 3, y: 500, z: -4 }, { kind: 'photo-ref' }),
    ]);
    expect(result.reasons).toEqual([]);
    engine.dispose();
  });
});

describe('board bounds', () => {
  const { width, height } = boardSizeMm(DEFAULT_BOARD);

  test('an item inside the prism, flush on the wall and the edges, is valid', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('inside', 'cube20', { x: 100, y: 100 }),
      item('leftFlush', 'cube20', { x: 10, y: 100 }),
      item('topFlush', 'cube20', { x: 300, y: height - 10 }),
    ]);
    expect(result.reasons).toEqual([]);
    engine.dispose();
  });

  test('protrusion past the left edge is measured and only that part is the region', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [item('a', 'cube20', { x: 4, y: 100 })]);
    const reason = bounds(result)[0];
    expect(bounds(result)).toHaveLength(1);
    expect(reason?.kind === 'out-of-board' && reason.side).toBe('left');
    expect(reason?.kind === 'out-of-board' && reason.extentMm).toBeCloseTo(6, 6);
    expect(reason?.kind === 'out-of-board' && reason.volumeMm3).toBeCloseTo(6 * 20 * 20, 3);
    // every region vertex lies on or beyond the plane
    const region = result.regions[0];
    expect(region?.kind).toBe('out-of-board');
    const xs = Array.from(
      { length: (region?.positions.length ?? 0) / 3 },
      (_, i) => region?.positions[i * 3] ?? 0,
    );
    expect(Math.max(...xs)).toBeLessThanOrEqual(1e-6);
    expect(Math.min(...xs)).toBeCloseTo(-6, 6);
    engine.dispose();
  });

  test('right, top, behind-the-wall protrusions are each reported with their extent', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('r', 'cube20', { x: width - 4, y: 200 }),
      item('t', 'cube20', { x: 300, y: height - 3 }),
      item('w', 'cube20', { x: 300, y: 300, z: -2 }),
    ]);
    const bySide = new Map(
      bounds(result).map((r) => [
        r.kind === 'out-of-board' ? r.side : '',
        r.kind === 'out-of-board' ? r.extentMm : 0,
      ]),
    );
    expect(bySide.get('right')).toBeCloseTo(6, 6);
    expect(bySide.get('top')).toBeCloseTo(7, 6);
    expect(bySide.get('behind-wall')).toBeCloseTo(2, 6);
    engine.dispose();
  });

  test('a corner item is split between disjoint slabs without double counting', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [item('c', 'cube20', { x: 4, y: 4 })]);
    const total = bounds(result).reduce((sum, r) => sum + r.volumeMm3, 0);
    // protruding volume = cube minus the part inside the 0..inf quadrant: 20*20*20 - 14*14*20
    expect(total).toBeCloseTo(8000 - 14 * 14 * 20, 3);
    expect(bounds(result).map((r) => (r.kind === 'out-of-board' ? r.side : ''))).toEqual([
      'bottom',
      'left',
    ]);
    engine.dispose();
  });

  test('0.04 mm past the edge is within tolerance, 0.06 mm is not', () => {
    const engine = newEngine();
    expect(engine.solve(DEFAULT_BOARD, [item('a', 'cube20', { x: 9.96, y: 100 })]).reasons).toEqual(
      [],
    );
    expect(
      bounds(engine.solve(DEFAULT_BOARD, [item('a', 'cube20', { x: 9.94, y: 100 })])),
    ).toHaveLength(1);
    engine.dispose();
  });

  test('a tool sticking 40 mm out of the board is not a protrusion (tg#24300); a holder in the same pose is', () => {
    const engine = newEngine();
    // The 20 mm cube centred at x = -30 spans x -40..-20: it reaches 40 mm past the left edge.
    const asTool = engine.solve(DEFAULT_BOARD, [
      item('t', 'cube20', { x: -30, y: 100 }, { kind: 'tool' }),
    ]);
    expect(bounds(asTool)).toEqual([]);
    expect(asTool.regions).toEqual([]);
    const asHolder = engine.solve(DEFAULT_BOARD, [item('h', 'cube20', { x: -30, y: 100 })]);
    expect(bounds(asHolder)).toHaveLength(1);
    engine.dispose();
  });

  test('tools still overlap-check against everything while they overhang the edge', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('h', 'cube20', { x: 5, y: 100 }),
      item('t', 'cube20', { x: 0, y: 100, z: 5 }, { kind: 'tool' }),
    ]);
    expect(overlaps(result)).toHaveLength(2);
    expect(bounds(result).map((r) => r.itemId)).toEqual(['h']);
    engine.dispose();
  });
});

describe('real bank holder geometry', () => {
  /** World x extent of a holder mesh and whether its side faces are flat (symmetric extremes). */
  function halfWidth(name: string): number {
    const positions = meshes.get(name)?.positions ?? new Float32Array();
    let max = -Infinity;
    for (let i = 0; i < positions.length; i += 3) max = Math.max(max, positions[i] ?? 0);
    return max;
  }

  const rotations = [0, 60, 33, 120];

  for (const name of ['scissors-slot-slots1-bladethickness4', 'bit-block-bitsperrow14-rows1']) {
    for (const rotZ of rotations) {
      test(`${name} rotated ${rotZ} deg: side-by-side contact is valid, 0.1 / 0.5 / 1 mm overlaps are flagged with that depth`, () => {
        const engine = newEngine();
        const half = halfWidth(name);
        const angle = (rotZ * Math.PI) / 180;
        const along = (distance: number) => ({
          x: 400 + Math.cos(angle) * distance,
          y: 300 + Math.sin(angle) * distance,
        });
        const place = (overlap: number) => [
          item('a', name, { x: 400, y: 300, rotZ }),
          item('b', name, { ...along(2 * half - overlap), rotZ }),
        ];
        expect(engine.solve(DEFAULT_BOARD, place(0)).reasons).toEqual([]);
        expect(engine.solve(DEFAULT_BOARD, place(0.04)).reasons).toEqual([]);
        for (const overlap of [0.1, 0.5, 1]) {
          const result = engine.solve(DEFAULT_BOARD, place(overlap));
          const reason = overlaps(result)[0];
          expect(reason?.kind).toBe('overlap');
          expect(reason?.kind === 'overlap' && reason.depthMm).toBeCloseTo(overlap, 2);
          expect(reason?.kind === 'overlap' && reason.volumeMm3).toBeGreaterThan(0.5);
        }
        engine.dispose();
      });
    }
  }

  test('different holders placed corner to corner: the region only exists when the bodies truly interpenetrate', () => {
    const engine = newEngine();
    const a = 'scissors-slot-slots1-bladethickness4';
    const b = 'cup-round-innerdiameter30-cupheight40';
    // far apart, then a deep overlap, along a diagonal
    const far = engine.solve(DEFAULT_BOARD, [
      item('a', a, { x: 300, y: 300 }),
      item('b', b, { x: 420, y: 420, rotZ: 33 }),
    ]);
    expect(far.reasons).toEqual([]);
    const deep = engine.solve(DEFAULT_BOARD, [
      item('a', a, { x: 300, y: 300 }),
      item('b', b, { x: 312, y: 306, rotZ: 33 }),
    ]);
    expect(overlaps(deep).length).toBe(2);
    expect(deep.regions).toHaveLength(1);
    engine.dispose();
  });

  test('a real holder hanging 3 mm over the board edge: only the overhang is a region', () => {
    const engine = newEngine();
    const name = 'bit-block-bitsperrow14-rows1';
    const half = halfWidth(name);
    const result = engine.solve(DEFAULT_BOARD, [item('h', name, { x: half - 3, y: 300 })]);
    const reason = bounds(result)[0];
    expect(reason?.kind === 'out-of-board' && reason.side).toBe('left');
    expect(reason?.kind === 'out-of-board' && reason.extentMm).toBeCloseTo(3, 3);
    engine.dispose();
  });

  test('a holder with its wall face on the board and nothing else around it is valid', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('a', 'scissors-slot-slots1-bladethickness4', { x: 200, y: 200 }),
      item('b', 'bit-block-bitsperrow14-rows1', { x: 500, y: 400, rotZ: 60 }),
    ]);
    expect(result.reasons).toEqual([]);
    engine.dispose();
  });
});

describe('curved bodies touching off-axis', () => {
  const RADIUS = 20;
  function sphereMesh(): SolidMesh {
    const sphere = wasm.Manifold.sphere(RADIUS, 128);
    const mesh = sphere.getMesh();
    const out = {
      positions: Float32Array.from(mesh.vertProperties),
      indices: Uint32Array.from(mesh.triVerts),
    };
    sphere.delete();
    return out;
  }

  test.each([45, 30, 70])(
    'two balls along %i deg: 0.03 mm is contact, 0.5 mm reads about 0.5 mm, not the width of the lens',
    (deg) => {
      const engine = newEngine();
      engine.defineSolid('ball', { kind: 'mesh', mesh: sphereMesh() });
      const angle = (deg * Math.PI) / 180;
      const place = (overlap: number) => {
        const distance = 2 * RADIUS - overlap;
        return [
          item('a', 'ball', { x: 400, y: 300, z: 30 }),
          item('b', 'ball', {
            x: 400 + Math.cos(angle) * distance,
            y: 300 + Math.sin(angle) * distance,
            z: 30,
          }),
        ];
      };
      expect(engine.solve(DEFAULT_BOARD, place(0.03)).reasons).toEqual([]);
      const reason = overlaps(engine.solve(DEFAULT_BOARD, place(0.5)))[0];
      expect(reason?.kind === 'overlap' && reason.depthMm).toBeGreaterThan(0.45);
      expect(reason?.kind === 'overlap' && reason.depthMm).toBeLessThan(0.6);
      engine.dispose();
    },
  );
});

describe('concave overlaps are judged per piece', () => {
  /** A U-shaped holder: 40 x 20 x 20 block with a 20 mm wide slot (x -10..10) cut through its full depth in y. */
  function uHolder(): SolidMesh {
    const outer = wasm.Manifold.cube([40, 20, 20]).translate([-20, -10, 0]);
    const slot = wasm.Manifold.cube([20, 20, 20]).translate([-10, -10, 0]);
    const u = wasm.Manifold.difference(outer, slot);
    const mesh = u.getMesh();
    const out = {
      positions: Float32Array.from(mesh.vertProperties),
      indices: Uint32Array.from(mesh.triVerts),
    };
    u.delete();
    outer.delete();
    slot.delete();
    return out;
  }

  test('a part 0.04 mm too wide for the slot touches both prongs by 0.04 mm: contact, not a 20 mm overlap', () => {
    const engine = newEngine();
    engine.defineSolid('u', { kind: 'mesh', mesh: uHolder() });
    engine.defineSolid('plug', { kind: 'box', box: box([-10.04, -5, 0], [10.04, 5, 20]) });
    const result = engine.solve(DEFAULT_BOARD, [
      item('u', 'u', { x: 200, y: 200 }),
      item('p', 'plug', { x: 200, y: 200 }),
    ]);
    expect(result.reasons).toEqual([]);
    engine.dispose();
  });

  test('0.5 mm into both prongs is reported as 0.5 mm deep, not as the 20 mm between the prongs', () => {
    const engine = newEngine();
    engine.defineSolid('u', { kind: 'mesh', mesh: uHolder() });
    engine.defineSolid('plug', { kind: 'box', box: box([-10.5, -5, 0], [10.5, 5, 20]) });
    const result = engine.solve(DEFAULT_BOARD, [
      item('u', 'u', { x: 200, y: 200 }),
      item('p', 'plug', { x: 200, y: 200 }),
    ]);
    const reason = overlaps(result)[0];
    expect(reason?.kind === 'overlap' && reason.depthMm).toBeCloseTo(0.5, 3);
    expect(reason?.kind === 'overlap' && reason.volumeMm3).toBeCloseTo(2 * 0.5 * 10 * 20, 1);
    engine.dispose();
  });

  test('pieces within tolerance are dropped from the region, deeper ones stay', () => {
    const engine = newEngine();
    engine.defineSolid('u', { kind: 'mesh', mesh: uHolder() });
    // 0.04 mm into the left prong, 0.5 mm into the right one
    engine.defineSolid('plug', { kind: 'box', box: box([-10.04, -5, 0], [10.5, 5, 20]) });
    const result = engine.solve(DEFAULT_BOARD, [
      item('u', 'u', { x: 200, y: 200 }),
      item('p', 'plug', { x: 200, y: 200 }),
    ]);
    const reason = overlaps(result)[0];
    expect(reason?.kind === 'overlap' && reason.depthMm).toBeCloseTo(0.5, 3);
    expect(reason?.kind === 'overlap' && reason.volumeMm3).toBeCloseTo(0.5 * 10 * 20, 1);
    const xs = Array.from(
      { length: (result.regions[0]?.positions.length ?? 0) / 3 },
      (_, i) => result.regions[0]?.positions[i * 3] ?? 0,
    );
    expect(Math.min(...xs)).toBeGreaterThan(200);
    engine.dispose();
  });
});

describe('independent oracle', () => {
  test('any vertex buried >= 0.1 mm inside the other holder is always flagged (60 random poses, rotated, diagonal)', () => {
    const engine = newEngine();
    let seed = 11;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    let buried = 0;
    for (let n = 0; n < 60; n++) {
      const nameA = HOLDERS[Math.floor(rnd() * HOLDERS.length)] ?? HOLDERS[0];
      const nameB = HOLDERS[Math.floor(rnd() * HOLDERS.length)] ?? HOLDERS[0];
      const poseA = pose({ x: 300, y: 300, rotZ: Math.floor(rnd() * 6) * 60 });
      const poseB = pose({
        x: 300 + (rnd() - 0.5) * 120,
        y: 300 + (rnd() - 0.5) * 120,
        rotZ: rnd() * 360,
      });
      const meshA = meshes.get(nameA);
      const meshB = meshes.get(nameB);
      if (!meshA || !meshB) throw new Error('fixture missing');
      const depth = Math.max(
        deepestVertexInside(meshA, poseA, meshB, poseB),
        deepestVertexInside(meshB, poseB, meshA, poseA),
      );
      const result = engine.solve(DEFAULT_BOARD, [
        item('a', nameA, poseA),
        item('b', nameB, poseB),
      ]);
      if (depth >= 0.1) {
        buried += 1;
        expect(overlaps(result).length).toBe(2);
      }
      if (overlaps(result).length === 0) expect(depth).toBeLessThan(0.1);
    }
    expect(buried).toBeGreaterThan(10);
    engine.dispose();
  }, 60_000);
});

describe('determinism, caching, degradation', () => {
  const scene = (): EngineItem[] => [
    item('a', 'scissors-slot-slots1-bladethickness4', { x: 200, y: 200 }),
    item('b', 'scissors-slot-slots1-bladethickness4', { x: 250, y: 205, rotZ: 60 }),
    item('c', 'cube20', { x: 4, y: 300 }),
    item('d', 'bit-block-bitsperrow14-rows1', { x: 230, y: 215, rotZ: 33 }),
  ];

  test('same input => identical reasons and region geometry, in any item order, on any engine', () => {
    const first = newEngine().solve(DEFAULT_BOARD, scene());
    const second = newEngine().solve(DEFAULT_BOARD, [...scene()].reverse());
    expect(second.reasons).toEqual(first.reasons);
    expect(second.regions.map((r) => r.key)).toEqual(first.regions.map((r) => r.key));
    second.regions.forEach((region, index) => {
      expect(Array.from(region.positions)).toEqual(
        Array.from(first.regions[index]?.positions ?? []),
      );
      expect(Array.from(region.indices)).toEqual(Array.from(first.regions[index]?.indices ?? []));
    });
    expect(first.reasons.length).toBeGreaterThan(0);
  });

  test('moving one item recomputes only the pairs that involve it', () => {
    const engine = newEngine();
    const items: EngineItem[] = [];
    for (let i = 0; i < 40; i++) {
      items.push(
        item(`i${i}`, 'scissors-slot-slots1-bladethickness4', {
          x: 100 + (i % 8) * 55,
          y: 100 + Math.floor(i / 8) * 70,
        }),
      );
    }
    const cold = engine.solve(DEFAULT_BOARD, items);
    expect(cold.stats.booleans).toBeGreaterThan(0);
    const warm = engine.solve(DEFAULT_BOARD, items);
    expect(warm.stats.booleans).toBe(0);
    expect(warm.reasons).toEqual(cold.reasons);
    const moved = items.map((it) =>
      it.id === 'i10' ? { ...it, pose: pose({ x: 100 + 2 * 55 - 2, y: 100 + 70 }) } : it,
    );
    const after = engine.solve(DEFAULT_BOARD, moved);
    expect(after.stats.booleans).toBeLessThanOrEqual(6);
    expect(overlaps(after).length).toBeGreaterThan(0);
    engine.dispose();
  });

  test('items whose solid is not defined yet are skipped and reported as pending', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('b', 'unknown-model', { x: 100, y: 100 }),
    ]);
    expect(result.pending).toEqual(['unknown-model']);
    expect(result.reasons).toEqual([]);
    engine.dispose();
  });

  test('redefining a solid drops cached regions and the approximate flag', () => {
    const engine = newEngine();
    const items = [
      item('a', 'cube20', { x: 100, y: 100 }),
      item('b', 'cube20', { x: 115, y: 100 }),
    ];
    expect(overlaps(engine.solve(DEFAULT_BOARD, items))).toHaveLength(2);
    engine.defineSolid('cube20', { kind: 'box', box: box([-1, -1, 0], [1, 1, 2]) });
    expect(engine.solve(DEFAULT_BOARD, items).reasons).toEqual([]);
    engine.defineSolid('open', {
      kind: 'mesh',
      mesh: {
        positions: Float32Array.from([-10, -10, 0, 10, -10, 0, 10, 10, 20, -10, 10, 20]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      },
    });
    expect(engine.approximateSolids.has('open')).toBe(true);
    engine.defineSolid('open', { kind: 'box', box: box([-1, -1, 0], [1, 1, 2]) });
    expect(engine.approximateSolids.has('open')).toBe(false);
    engine.dispose();
  });

  test('an item 40 m outside the board is still reported with its true extent', () => {
    const engine = newEngine();
    const result = engine.solve(DEFAULT_BOARD, [item('far', 'cube20', { x: -40000, y: 100 })]);
    const reason = bounds(result)[0];
    expect(reason?.kind === 'out-of-board' && reason.side).toBe('left');
    expect(reason?.kind === 'out-of-board' && reason.extentMm).toBeCloseTo(40010, 0);
    engine.dispose();
  });

  test('a mesh that is not a closed solid falls back to its bounding box', () => {
    const engine = new InvalidZoneEngine(wasm);
    // a single open triangle fan: not watertight
    engine.defineSolid('open', {
      kind: 'mesh',
      mesh: {
        positions: Float32Array.from([-10, -10, 0, 10, -10, 0, 10, 10, 20, -10, 10, 20]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
      },
    });
    expect(engine.approximateSolids.has('open')).toBe(true);
    const result = engine.solve(DEFAULT_BOARD, [
      item('a', 'open', { x: 100, y: 100 }),
      item('b', 'open', { x: 110, y: 100 }),
    ]);
    expect(overlaps(result)).toHaveLength(2);
    engine.dispose();
  });
});
