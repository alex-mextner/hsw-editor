/**
 * Close-ups of the seated showcase (demo) wall: for each holder, the holder and its tools posed as the demo build seats them,
 * from the front, from a three-quarter view above-left and from the side, plus the physics verdict per tool (status, score,
 * problem codes: `wedged` and `protrudes` among them) and the pose it was seated at.
 *
 *   bun apps/web/scripts/showcase-closeups.ts [holderId...] [--out DIR] [--unseated]
 *
 * Default out dir `~/.cache/hsw-editor/proofs/seat`. Holder ids are the showcase layout ids (`sc-drivers`, `sc-pliers`, ...).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HolderSpec } from '@hsw-editor/compat';
import { applyOp } from '@hsw-editor/core';
import {
  analyseWallPhysics,
  placementOfPose,
  protrudeLimitMm,
  type ToolBody,
} from '@hsw-editor/physics';
import '../../../packages/tools/src/classes/index.ts';
import { ToolAssetStore } from '../../../packages/tools/src/node/assets.ts';
import { PhysicsAssets } from '../../server/src/physics/assets.ts';
import { seatShowcase } from '../../../scripts/tools/showcase-seats.ts';
import { SHOWCASE_LAYOUT } from '../src/demo/showcaseLayout.ts';
import { vizScene, type VizPart } from './physics-viz.ts';

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outArg = outFlag >= 0 ? args[outFlag + 1] : undefined;
if (outFlag >= 0 && (outArg === undefined || outArg.startsWith('--')))
  throw new Error('--out needs a directory');
const out = outArg ?? join(homedir(), '.cache/hsw-editor/proofs/seat');
const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
mkdirSync(out, { recursive: true });
delete process.env['HSW_BANK_DIR'];

const seed = JSON.parse(
  readFileSync(new URL('../../../packages/bank/seed/index.json', import.meta.url), 'utf8'),
) as {
  elements: readonly {
    id: string;
    category: string;
    bboxMm: HolderSpec['bboxMm'];
    fitsTool?: HolderSpec['fitsTool'];
  }[];
};
const specs = new Map<string, HolderSpec>(
  seed.elements.map((e) => [
    e.id,
    { id: e.id, category: e.category, fitsTool: e.fitsTool ?? [], bboxMm: e.bboxMm },
  ]),
);
// Scratch lives under the cache, never /tmp (AGENTS.md); removed at the end.
const scratch = join(homedir(), '.cache/hsw-editor/scratch');
mkdirSync(scratch, { recursive: true });
const home = mkdtempSync(join(scratch, 'closeups-'));
const classIds = [...new Set(SHOWCASE_LAYOUT.flatMap((h) => h.tools.map((t) => t.classId)))];
const index = await new ToolAssetStore(join(home, 'assets'), undefined, classIds).index();
const seated = await seatShowcase(SHOWCASE_LAYOUT, specs, index);
const wall = args.includes('--unseated')
  ? seated.wall
  : applyOp(seated.wall, { type: 'batch', label: 'seat all', ops: [...seated.seats.ops] }).wall;
const assets = new PhysicsAssets(home);
const solids = await assets.wallSolids(wall);

const COLORS = ['#e0524d', '#e0a14d', '#4dae6d', '#4d86e0', '#9b59b6', '#d05cbf'];
const VIEWS = [
  [0, 0, 1],
  [-0.8, 0.5, 1],
  [1, 0, 0],
] as const;

for (const holderLayout of SHOWCASE_LAYOUT) {
  if (only.length > 0 && !only.includes(holderLayout.id)) continue;
  const holder = solids.holders.find((h) => h.item.id === holderLayout.id);
  if (holder === undefined) continue;
  const tools = wall.items.filter((i) => i.kind === 'tool' && i.parentId === holderLayout.id);
  const parts: VizPart[] = [
    {
      mesh: holder.body.mesh,
      rotation: holder.body.rotation,
      position: holder.body.translation,
      color: '#8a8f98',
    },
  ];
  const bodies = new Map<string, ToolBody>();
  for (const [at, tool] of tools.entries()) {
    const body = await assets.toolBody(tool, wall);
    if (!('body' in body)) continue;
    bodies.set(tool.id, body.body);
    const placement = placementOfPose(tool.pose);
    parts.push({
      mesh: body.body.mesh,
      rotation: placement.rotation,
      position: placement.position,
      color: COLORS[at % COLORS.length] ?? '#e0524d',
    });
  }
  const bounds = holder.body.bounds();
  const centre = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2 + 40,
    (bounds.min[2] + bounds.max[2]) / 2,
  ] as const;
  vizScene(parts, join(out, `closeup-${holderLayout.id}.png`), {
    center: centre,
    sizeMm: 330,
    views: VIEWS,
  });
  const holderPhysics = analyseWallPhysics({
    tools: tools.flatMap((tool) => {
      const body = bodies.get(tool.id);
      return body === undefined
        ? []
        : [
            {
              id: tool.id,
              body,
              placement: placementOfPose(tool.pose),
              holderId: holderLayout.id,
              protrudeLimitMm: protrudeLimitMm(holder.element.id),
            },
          ];
    }),
    holders: solids.holders.map((h) => ({ id: h.item.id, body: h.body })),
    others: solids.boardParts,
  });
  for (const tool of holderPhysics.tools) {
    const pose = wall.items.find((i) => i.id === tool.toolId)?.pose;
    console.log(
      holderLayout.id.padEnd(11),
      tool.toolId.padEnd(15),
      `${tool.hang.status} ${tool.hang.score}`.padEnd(14),
      tool.problems.map((p) => p.code).join(',') || '-',
      pose === undefined
        ? ''
        : `pose x${pose.x.toFixed(0)} y${pose.y.toFixed(0)} z${pose.z.toFixed(0)} rot ${pose.rotX.toFixed(0)},${pose.rotY.toFixed(0)},${pose.rotZ.toFixed(0)}`,
    );
  }
}

rmSync(home, { recursive: true, force: true });
