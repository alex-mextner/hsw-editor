/**
 * Real-data regression of the user's screenshot (tg#24292): tools floating above their holders. Real bank holders
 * (packages/bank/seed) and real generated tools (class generator -> GLB -> `readToolBody`, exactly what the worker
 * reads). (a) the old compatibility placement of each is flagged by the physics; (b) the seat the physics computes is
 * a pose the tool really rests in; (c) the whole pipeline (wall -> scene -> worker core -> report) publishes a report.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BankElement } from '@hsw-editor/bank';
import {
  mountSlots,
  placeTool,
  prefersTipDown,
  slotHalfWidthMm,
  type HolderSpec,
  type ToolInterface,
} from '@hsw-editor/compat';
import {
  createEmptyWall,
  DEFAULT_BOARD,
  type Pose,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import {
  analyseHangPose,
  type Bounds,
  placementOfPose,
  protrudeLimitMm,
  type SeatResult,
  seatTool,
  SolidBody,
  type ToolBody,
  worldBounds,
} from '@hsw-editor/physics';
import { readGlbSolid, readToolBody } from '@hsw-editor/physics/glb';
import { exportGlb, generate, getToolClass } from '@hsw-editor/tools';
import { DRIVER_FOR_5MM_HOLES } from '@/demo/showcaseLayout.ts';
import { loadManifold } from '@/scene/invalid-zones/manifold.ts';
import type { AssetContext } from './assets.ts';
import type { PhysicsChecker } from './client.ts';
import { runPhysicsWith } from './run.ts';
import { physicsStore } from './store.ts';
import { WorkerCore } from './workerCore.ts';
import type { BodySource, FromWorker, PhysicsScene } from './protocol.ts';

const SEED = resolve(import.meta.dir, '../../../../packages/bank/seed');
const index = JSON.parse(readFileSync(`${SEED}/index.json`, 'utf8')) as { elements: BankElement[] };
const element = (id: string): BankElement => {
  const found = index.elements.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no seed holder ${id}`);
  return found;
};

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function holderBody(id: string, pose: Pose): Promise<SolidBody> {
  const buffer = readFileSync(`${SEED}/${element(id).assets.lod0.path}`);
  const mesh = await readGlbSolid(arrayBufferOf(buffer));
  const placement = placementOfPose(pose);
  return new SolidBody(id, mesh, placement.rotation, placement.position);
}

async function toolBody(
  generatorClass: string,
  params: Readonly<Record<string, number>>,
): Promise<ToolBody> {
  const glb = exportGlb(generate(generatorClass, params, 1));
  const body = await readToolBody(generatorClass, arrayBufferOf(glb));
  if (body === null) throw new Error(`${generatorClass}: generated GLB carries no mass data`);
  return body;
}

/** The measured holding interface of a generated tool, as the compatibility maths receives it. */
function toolInterfaceOf(
  generatorClass: string,
  params: Readonly<Record<string, number>>,
): ToolInterface {
  const model = generate(generatorClass, params, 1);
  const { holding } = model;
  const hang = holding.hang;
  return {
    toolClass: getToolClass(generatorClass).bankClass,
    lengthMm: holding.lengthMm,
    hang:
      hang === null
        ? null
        : {
            point: hang.point,
            kind: hang.kind === 'neck' ? 'body' : hang.kind,
            diameterMm: hang.diameterMm,
          },
    maxSection: holding.maxSection,
    dims: holding.dims,
  };
}

interface Case {
  readonly holder: string;
  readonly generator: string;
  readonly params?: Readonly<Record<string, number>>;
  /** The old placement was floating / sunk in on the user's wall. */
  readonly oldIsWrong: boolean;
}

const CASES: readonly Case[] = [
  { holder: 'hammer-fork-handlewidth30', generator: 'hammer', oldIsWrong: true },
  {
    holder: 'caliper-cradle-slots1-beamwidth16',
    generator: 'caliper',
    params: { beamWidth: 15.5 },
    oldIsWrong: true,
  },
  {
    holder: 'pliers-rack-slots3-jawthickness18',
    generator: 'pliers-combination',
    oldIsWrong: true,
  },
  { holder: 'refit-tape-measure-cradle', generator: 'tape-measure', oldIsWrong: true },
  { holder: 'drill-cradle-bodywidth45', generator: 'cordless-drill', oldIsWrong: true },
  {
    holder: 'spray-can-holder-candiameter50',
    generator: 'spray-can',
    params: { diameter: 50 },
    oldIsWrong: false,
  },
  {
    holder: 'wrench-rack-slots4-maxwrenchwidth30',
    generator: 'wrench-combination',
    oldIsWrong: true,
  },
  { holder: 'refit-tape-large', generator: 'tape-roll', oldIsWrong: false },
  {
    holder: 'screwdriver-rail-slots6-holediameter5',
    generator: 'screwdriver',
    params: { shaftDiameter: 4, tipWidth: 4 },
    oldIsWrong: false,
  },
];

const HOLDER_POSE: Pose = { x: 100, y: 100, z: 0, rotX: 0, rotY: 0, rotZ: 0 };

describe('the levitating tools of the user screenshot', () => {
  for (const c of CASES) {
    const name = `${c.generator} in ${c.holder}`;
    const spec = (): HolderSpec => element(c.holder);

    test(`${name}: the old placement is judged, the seat rests`, async () => {
      const params = c.params ?? {};
      const holder = await holderBody(c.holder, HOLDER_POSE);
      const tool = await toolBody(c.generator, params);
      const tool_ = toolInterfaceOf(c.generator, params);
      const slot = mountSlots(spec(), spec().fitsTool[0] ?? null)[0];
      if (slot === undefined) throw new Error('holder has no slot');

      // (a) what the editor used to do: one point of the tool on the slot anchor.
      const old = placeTool(tool_, spec(), slot, HOLDER_POSE);
      const before = analyseHangPose({
        tool,
        placement: placementOfPose(old.pose),
        obstacles: [holder],
      });
      if (c.oldIsWrong) {
        expect(before.status).toBe('unstable');
        expect(
          before.reasons.some((r) =>
            ['penetrates', 'levitating', 'falls', 'tips'].includes(r.code),
          ),
        ).toBe(true);
      }

      // (b) where the physics puts it.
      const entry = spec().fitsTool[0];
      const slots = mountSlots(spec(), entry ?? null);
      const pitch = (spec().bboxMm.max.x - spec().bboxMm.min.x) / slots.length;
      const seat = seatTool({
        tool,
        holder,
        neighbours: [],
        anchor: [HOLDER_POSE.x + slot.anchor[0], HOLDER_POSE.y + slot.anchor[1], slot.anchor[2]],
        halfWidthMm: Math.min(pitch / 2, 14),
        tipDown: prefersTipDown(tool_),
      });
      if (seat === null) throw new Error(`${name}: no seat found`);
      expect(seat.report.status).not.toBe('unstable');
      expect(seat.report.penetrationMm).toBe(0);
      // Where the old placement was wrong, the seat is a clear improvement.
      if (c.oldIsWrong) expect(seat.report.score).toBeGreaterThan(before.score);
      if (c.generator === 'hammer') {
        // The head rests on the fork prongs and the handle hangs through the gap: far below the holder's top.
        const top = HOLDER_POSE.y + spec().bboxMm.max.y;
        expect(top - seat.pose.y).toBeGreaterThan(100);
      }
    }, 30_000);
  }
});

// ---- seat cleanliness (#258): tools enter holes and slots cleanly and sit stably -------------------------

interface SeatedIn {
  readonly seat: SeatResult;
  readonly tool: ToolBody;
  readonly holder: SolidBody;
  readonly holderBounds: Bounds;
  readonly toolBounds: Bounds;
}

/** Seats a generated tool in slot `slotIndex` of a seed holder the way the daemon does, with the holder's own protrusion limit. */
async function seatedIn(
  holderId: string,
  generator: string,
  params: Readonly<Record<string, number>>,
  slotIndex = 0,
): Promise<SeatedIn> {
  const spec = element(holderId);
  const holder = await holderBody(holderId, HOLDER_POSE);
  const tool = await toolBody(generator, params);
  const slots = mountSlots(spec, spec.fitsTool[0] ?? null);
  const slot = slots[slotIndex];
  if (slot === undefined) throw new Error(`${holderId} has no slot ${slotIndex}`);
  const limit = protrudeLimitMm(holderId);
  const seat = seatTool({
    tool,
    holder,
    neighbours: [],
    anchor: [HOLDER_POSE.x + slot.anchor[0], HOLDER_POSE.y + slot.anchor[1], slot.anchor[2]],
    halfWidthMm: slotHalfWidthMm(spec, slots.length),
    tipDown: prefersTipDown(toolInterfaceOf(generator, params)),
    ...(limit === undefined ? {} : { options: { protrudeLimitMm: limit } }),
  });
  if (seat === null) throw new Error(`${generator} in ${holderId}: no seat found`);
  return {
    seat,
    tool,
    holder,
    holderBounds: holder.bounds(),
    toolBounds: worldBounds(tool, seat.placement),
  };
}

const codesOf = (seat: SeatResult): string[] => seat.report.reasons.map((r) => r.code);

describe('seat cleanliness (#258, the circled tools of the user screenshot)', () => {
  test('screwdriver in the 5 mm rail: shaft through the hole, handle on the rim, nothing flagged', async () => {
    for (const slotIndex of [0, 1, 2]) {
      const { seat, toolBounds, holderBounds } = await seatedIn(
        'screwdriver-rail-slots3-holediameter5',
        'screwdriver',
        DRIVER_FOR_5MM_HOLES,
        slotIndex,
      );
      expect(codesOf(seat)).toEqual([]);
      expect(seat.report.status).toBe('stable');
      // The shaft (100 mm, less the ferrule above the rim) is through the hole and out under the rail: the handle sits on the rim.
      expect(holderBounds.max[1] - toolBounds.min[1]).toBeGreaterThan(85);
      expect(toolBounds.min[1]).toBeLessThan(holderBounds.min[1]);
    }
  });

  test('cordless drill on its battery on the U-shelf leans back against the wall and is held against a pull', async () => {
    const { seat, tool, holder } = await seatedIn('drill-cradle-bodywidth45', 'cordless-drill', {});
    expect(codesOf(seat)).not.toContain('needs_retention');
    // The pose the wall stores is the leaned one: the wall analysis (which leans nothing back) judges it stable as it is.
    const stored = analyseHangPose({
      tool,
      placement: seat.placement,
      obstacles: [holder],
      holder,
    });
    expect(stored.status).toBe('stable');
    expect(stored.reasons).toEqual([]);
    expect(seat.report.status).toBe('stable');
    // Leaned back (about the horizontal axis along the wall), not standing plumb.
    expect(seat.report.rest?.tiltDeg ?? 0).toBeGreaterThan(0);
    expect(seat.report.marginsG.outward).toBeGreaterThanOrEqual(0.15 * 0.9);
  }, 30_000);

  test('open-end wrench in the 4-slot rack is held, not tipping on its prongs', async () => {
    const { seat } = await seatedIn(
      'wrench-rack-slots4-maxwrenchwidth30',
      'wrench-open-end',
      {},
      1,
    );
    expect(codesOf(seat)).not.toContain('tips');
    expect(codesOf(seat)).not.toContain('needs_retention');
    expect(seat.report.status).toBe('stable');
  }, 30_000);
});

// ---- the whole pipeline ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost/';

/** What the server answers for the two url families the worker fetches. */
function serve(url: string): ArrayBuffer {
  const { pathname, searchParams } = new URL(url);
  const asset = pathname.match(/^\/bank\/assets\/(.+)$/);
  if (asset?.[1] !== undefined) {
    const file = readFileSync(`${SEED}/${asset[1]}`);
    return arrayBufferOf(new Uint8Array(file));
  }
  const model = pathname.match(/^\/api\/tools\/classes\/([^/]+)\/model\.glb$/);
  if (model?.[1] !== undefined) {
    const values = JSON.parse(searchParams.get('p') ?? '{}') as Record<string, number>;
    return arrayBufferOf(exportGlb(generate(decodeURIComponent(model[1]), values, 1)));
  }
  throw new Error(`404 ${url}`);
}

function wallOf(cases: readonly (Case & { readonly tool: Pose })[]): Wall {
  const empty = createEmptyWall('w', 'physics', { ...DEFAULT_BOARD, cols: 40, rows: 40 });
  const items: WallItem[] = [];
  const models: Wall['models'] = [];
  cases.forEach((c, n) => {
    const holderId = `holder-${n}`;
    const x = 150 + 260 * n;
    items.push({
      id: holderId,
      kind: 'holder',
      bankId: c.holder,
      pose: { ...HOLDER_POSE, x },
      params: {},
      source: { type: 'manual' },
      locked: false,
    });
    models.push({
      id: `model-${n}`,
      label: c.generator,
      status: 'chosen',
      source: { type: 'library', by: `gen:${c.generator}` },
      toolClass: getToolClass(c.generator).bankClass,
    });
    items.push({
      id: `tool-${n}`,
      kind: 'tool',
      modelRefId: `model-${n}`,
      toolClass: getToolClass(c.generator).bankClass,
      parentId: holderId,
      slot: 0,
      pose: c.tool,
      params: { ...c.params },
      source: { type: 'manual' },
      locked: false,
    });
  });
  return { ...empty, items, models };
}

/** The worker, in process: the same `WorkerCore`, fed by the same messages. */
function inProcessChecker(): PhysicsChecker {
  const wasm = loadManifold();
  return {
    async check(scene: PhysicsScene, sources: ReadonlyMap<string, BodySource>) {
      const posted: FromWorker[] = [];
      const core = new WorkerCore({
        wasm,
        post: (m) => posted.push(m),
        fetchSolid: (url) => readGlbSolid(serve(url)),
        fetchTool: (url, id) => readToolBody(id, serve(url)),
      });
      for (const [key, source] of sources) core.handle({ type: 'define', key, source });
      core.handle({ type: 'solve', seq: 1, scene });
      await core.idle();
      const answer = posted.find((m) => m.type === 'result');
      if (answer?.type !== 'result') {
        throw new Error(posted.map((m) => (m.type === 'error' ? m.message : m.type)).join('; '));
      }
      return { report: answer.report, skipped: answer.skipped };
    },
  };
}

describe('runPhysicsCheck on a wall of seed holders and generated tools', () => {
  let bankById: Map<string, BankElement>;
  beforeAll(() => {
    bankById = new Map(index.elements.map((e) => [e.id, e]));
  });

  test('publishes a real report: the floating hammer is flagged, the seated screwdriver is not', async () => {
    const hammer = CASES[0];
    const driver = CASES[8];
    if (hammer === undefined || driver === undefined) throw new Error('cases missing');
    const hammerSpec = element(hammer.holder);
    const hammerTool = toolInterfaceOf(hammer.generator, {});
    const slot = mountSlots(hammerSpec, hammerSpec.fitsTool[0] ?? null)[0];
    if (slot === undefined) throw new Error('no slot');
    const hammerAt: Pose = { ...HOLDER_POSE, x: 150 };
    const old = placeTool(hammerTool, hammerSpec, slot, hammerAt).pose;

    // The screwdriver goes where the physics seats it.
    const driverHolder = await holderBody(driver.holder, { ...HOLDER_POSE, x: 410 });
    const driverSpec = element(driver.holder);
    const driverSlot = mountSlots(driverSpec, driverSpec.fitsTool[0] ?? null)[0];
    if (driverSlot === undefined) throw new Error('no slot');
    const driverIface = toolInterfaceOf(driver.generator, driver.params ?? {});
    const seated = seatTool({
      tool: await toolBody(driver.generator, driver.params ?? {}),
      holder: driverHolder,
      neighbours: [],
      anchor: [
        410 + driverSlot.anchor[0],
        HOLDER_POSE.y + driverSlot.anchor[1],
        driverSlot.anchor[2],
      ],
      halfWidthMm: 12,
      tipDown: prefersTipDown(driverIface),
    });
    if (seated === null) throw new Error('no seat');

    const wall = wallOf([
      { ...hammer, tool: old },
      { ...driver, tool: seated.pose },
    ]);
    const ctx: AssetContext = {
      bank: bankById,
      toolModel: (item) => {
        const by = wall.models.find((m) => m.id === item.modelRefId)?.source.by;
        if (by === undefined || !by.startsWith('gen:')) return null;
        const id = by.slice('gen:'.length);
        const p = JSON.stringify(item.params);
        return {
          key: `gen|${id}|${p}`,
          path: `/api/tools/classes/${id}/model.glb?lod=1&p=${encodeURIComponent(p)}`,
        };
      },
      baseUrl: BASE_URL,
      toolInterface: () => undefined,
    };
    physicsStore.set({ status: 'idle' });
    await runPhysicsWith(
      {
        wall: () => wall,
        context: () => ctx,
        checker: inProcessChecker,
        ensureModels: async () => undefined,
        now: () => 0,
      },
      { force: true },
    );
    const view = physicsStore.get();
    if (view.status !== 'ready') throw new Error(`not ready: ${JSON.stringify(view)}`);
    const byTool = new Map(view.report.tools.map((t) => [t.toolId, t]));
    expect(byTool.size).toBe(2);
    expect(byTool.get('tool-0')?.hang.status).toBe('unstable');
    expect(byTool.get('tool-0')?.problems.some((p) => p.severity === 'error')).toBe(true);
    expect(byTool.get('tool-1')?.hang.status).not.toBe('unstable');
    expect(byTool.get('tool-1')?.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(view.report.flagged).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
