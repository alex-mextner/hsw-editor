/**
 * Builds the physics proof wall on a running daemon: three holders with tools in the three situations of the ticket.
 *   stable    hammer in its fork, seated by `seatTool`
 *   unstable  caliper put where the old compat anchor put it (levitating over its cradle)
 *   awkward   two wrenches in a pocket holder 30 mm apart under a shelf-like lid are hard to take off: here a
 *             screwdriver pair 9 mm apart (cramped, two hands)
 * `bun apps/web/scripts/physics-proof-wall.ts [--api http://127.0.0.1:PORT] [--id physics-proof]`
 * Prints the wall id; open `<app>/?wall=<id>` in the browser.
 */
import { readFileSync } from 'node:fs';
import {
  eulerToMatrix,
  mountSlots,
  placeTool,
  prefersTipDown,
  type HolderSpec,
  type ToolInterface,
} from '@hsw-editor/compat';
import type { LeafOp, Pose } from '@hsw-editor/core';
import { placementOfPose, seatTool, SolidBody } from '@hsw-editor/physics';
import { readGlbSolid, readToolBody } from '@hsw-editor/physics/glb';
import { exportGlb, generate, getToolClass } from '@hsw-editor/tools';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const api = flag('--api', 'http://127.0.0.1:8794');
const wallId = flag('--id', 'physics-proof');

const seed = new URL('../../../packages/bank/seed/', import.meta.url).pathname;
const index = JSON.parse(readFileSync(`${seed}index.json`, 'utf8')) as {
  elements: (HolderSpec & { assets: { lod0: { path: string } } })[];
};
const buffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

interface Scene {
  name: string;
  holder: string;
  toolClass: string;
  params?: Record<string, number>;
  at: { x: number; y: number };
  /** `seated`: seatTool pose; `old`: the compat anchor pose. */
  how: 'seated' | 'old';
  /** Extra copies of the tool on the same holder, `dx` mm to the right (a cramped neighbour). */
  neighbour?: { dx: number };
}

const SCENES: readonly Scene[] = [
  {
    name: 'stable',
    holder: 'hammer-fork-handlewidth30',
    toolClass: 'hammer',
    at: { x: 200, y: 300 },
    how: 'seated',
  },
  {
    name: 'unstable',
    holder: 'caliper-cradle-slots1-beamwidth16',
    toolClass: 'caliper',
    params: { beamWidth: 15.5 },
    at: { x: 520, y: 300 },
    how: 'old',
  },
  {
    name: 'awkward',
    holder: 'wrench-rack-slots4-maxwrenchwidth30',
    toolClass: 'wrench-combination',
    at: { x: 800, y: 300 },
    how: 'seated',
    neighbour: { dx: 14 },
  },
];

const ops: LeafOp[] = [];
let n = 0;
for (const scene of SCENES) {
  const el = index.elements.find((e) => e.id === scene.holder);
  if (el === undefined) throw new Error(`no seed holder ${scene.holder}`);
  const spec: HolderSpec = {
    id: el.id,
    category: el.category,
    fitsTool: el.fitsTool,
    bboxMm: el.bboxMm,
  };
  const holderPose: Pose = { x: scene.at.x, y: scene.at.y, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
  const holderMesh = await readGlbSolid(buffer(readFileSync(`${seed}${el.assets.lod0.path}`)));
  const holder = new SolidBody(el.id, holderMesh, eulerToMatrix(holderPose), [
    holderPose.x,
    holderPose.y,
    0,
  ]);
  const model = generate(scene.toolClass, scene.params ?? {}, 1);
  const tool = await readToolBody(scene.toolClass, buffer(exportGlb(model)));
  if (tool === null) throw new Error(`${scene.toolClass}: no mass`);
  const h = model.holding;
  const ti: ToolInterface = {
    toolClass: getToolClass(scene.toolClass).bankClass,
    lengthMm: h.lengthMm,
    hang: h.hang
      ? {
          point: h.hang.point,
          kind: h.hang.kind === 'neck' ? 'body' : h.hang.kind,
          diameterMm: h.hang.diameterMm,
        }
      : null,
    maxSection: h.maxSection,
    dims: h.dims,
    massG: tool.massG,
  };
  const slot = mountSlots(spec, spec.fitsTool[0] ?? null)[0];
  if (slot === undefined) throw new Error('no slot');
  const slots = mountSlots(spec, spec.fitsTool[0] ?? null).length;
  const poses: Pose[] = [];
  if (scene.how === 'old') {
    poses.push(placeTool(ti, spec, slot, holderPose).pose);
  } else {
    const seat = seatTool({
      tool,
      holder,
      neighbours: [],
      anchor: [holderPose.x + slot.anchor[0], holderPose.y + slot.anchor[1], slot.anchor[2]],
      halfWidthMm: Math.min((spec.bboxMm.max.x - spec.bboxMm.min.x) / slots / 2, 14),
      tipDown: prefersTipDown(ti),
    });
    if (seat === null) throw new Error(`${scene.toolClass}: no seat`);
    poses.push(seat.pose);
    if (scene.neighbour) poses.push({ ...seat.pose, x: seat.pose.x + scene.neighbour.dx });
  }
  n += 1;
  const holderId = `holder-${scene.name}`;
  ops.push({
    type: 'addItem',
    item: {
      id: holderId,
      kind: 'holder',
      bankId: el.id,
      pose: holderPose,
      params: {},
      source: { type: 'manual' },
      locked: false,
    },
  });
  ops.push({
    type: 'addModelRef',
    model: {
      id: `model-${scene.name}`,
      label: scene.toolClass,
      status: 'chosen',
      source: { type: 'library', by: `gen:${scene.toolClass}` },
      toolClass: ti.toolClass,
    },
  });
  poses.forEach((pose, k) => {
    ops.push({
      type: 'addItem',
      item: {
        id: `tool-${scene.name}-${k}`,
        kind: 'tool',
        modelRefId: `model-${scene.name}`,
        toolClass: ti.toolClass,
        parentId: holderId,
        slot: 0,
        pose,
        params: { ...(scene.params ?? {}) },
        source: { type: 'manual' },
        locked: false,
      },
    });
  });
}

const created = await fetch(`${api}/api/walls`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: wallId, name: 'Physics proof', board: { cols: 48, rows: 32 } }),
});
if (!created.ok && created.status !== 409)
  throw new Error(`create wall: ${created.status} ${await created.text()}`);
const applied = await fetch(`${api}/api/walls/${wallId}/ops`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    ops,
    actor: { kind: 'agent', name: 'physics-proof' },
    label: 'physics proof',
  }),
});
if (!applied.ok) throw new Error(`apply ops: ${applied.status} ${await applied.text()}`);
console.log(`${wallId}: ${n} scenes, ${ops.length} ops`);
