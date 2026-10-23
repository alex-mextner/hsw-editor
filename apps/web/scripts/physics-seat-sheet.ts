/**
 * Seat sheet: for each regression case (the tools of the user's levitating-tools screenshot, tg#24292) renders the
 * tool where the OLD compat anchor put it and where `seatTool` seats it, front and side, with the verdicts.
 * `bun apps/web/scripts/physics-seat-sheet.ts [class] [--out DIR]` (default ~/.cache/hsw-editor/proofs/physics).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  eulerToMatrix,
  mountSlots,
  placeTool,
  prefersTipDown,
  type HolderSpec,
  type ToolInterface,
} from '@hsw-editor/compat';
import { analyseHangPose, placementOfPose, seatTool, SolidBody } from '@hsw-editor/physics';
import { readGlbSolid, readToolBody } from '@hsw-editor/physics/glb';
import { exportGlb, generate, getToolClass } from '@hsw-editor/tools';
import { vizScene } from './physics-viz.ts';

interface Case {
  holder: string;
  toolClass: string;
  params?: Record<string, number>;
}

const CASES: readonly Case[] = [
  { holder: 'hammer-fork-handlewidth30', toolClass: 'hammer' },
  {
    holder: 'caliper-cradle-slots1-beamwidth16',
    toolClass: 'caliper',
    params: { beamWidth: 15.5 },
  },
  { holder: 'pliers-rack-slots3-jawthickness18', toolClass: 'pliers-combination' },
  { holder: 'refit-tape-measure-cradle', toolClass: 'tape-measure' },
  { holder: 'drill-cradle-bodywidth45', toolClass: 'cordless-drill' },
  { holder: 'spray-can-holder-candiameter50', toolClass: 'spray-can', params: { diameter: 50 } },
  { holder: 'wrench-rack-slots4-maxwrenchwidth30', toolClass: 'wrench-combination' },
  { holder: 'refit-tape-large', toolClass: 'tape-roll' },
  {
    holder: 'screwdriver-rail-slots6-holediameter5',
    toolClass: 'screwdriver',
    params: { shaftDiameter: 4, tipWidth: 4 },
  },
];

const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const out =
  outFlag >= 0 ? (args[outFlag + 1] ?? '') : join(homedir(), '.cache/hsw-editor/proofs/physics');
const only = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
mkdirSync(out, { recursive: true });

const seed = new URL('../../../packages/bank/seed/', import.meta.url).pathname;
const index = JSON.parse(readFileSync(`${seed}index.json`, 'utf8')) as {
  elements: (HolderSpec & { assets: { lod0: { path: string } } })[];
};
const IDENTITY = eulerToMatrix({ rotX: 0, rotY: 0, rotZ: 0 });
const ORIGIN = { x: 100, y: 100, z: 0, rotX: 0, rotY: 0, rotZ: 0 };

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

for (const c of CASES) {
  if (only !== undefined && c.toolClass !== only) continue;
  const el = index.elements.find((e) => e.id === c.holder);
  if (el === undefined) throw new Error(`no seed holder ${c.holder}`);
  const mesh = await readGlbSolid(arrayBufferOf(readFileSync(`${seed}${el.assets.lod0.path}`)));
  const holder = new SolidBody(c.holder, mesh, IDENTITY, [100, 100, 0]);
  const model = generate(c.toolClass, c.params ?? {}, 1);
  const tool = await readToolBody(c.toolClass, arrayBufferOf(exportGlb(model)));
  if (tool === null) throw new Error(`${c.toolClass}: no mass in its GLB`);
  const bankClass = getToolClass(c.toolClass).bankClass;
  const h = model.holding;
  const ti: ToolInterface = {
    toolClass: bankClass,
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
  const spec: HolderSpec = {
    id: el.id,
    category: el.category,
    fitsTool: el.fitsTool,
    bboxMm: el.bboxMm,
  };
  const slots = mountSlots(spec, spec.fitsTool[0] ?? null);
  const slot = slots[0];
  if (slot === undefined) continue;
  const old = placeTool(ti, spec, slot, ORIGIN);
  const oldReport = analyseHangPose({
    tool,
    placement: placementOfPose(old.pose),
    obstacles: [holder],
  });
  const seat = seatTool({
    tool,
    holder,
    neighbours: [],
    anchor: [100 + slot.anchor[0], 100 + slot.anchor[1], slot.anchor[2]],
    halfWidthMm: Math.min((spec.bboxMm.max.x - spec.bboxMm.min.x) / slots.length / 2, 14),
    tipDown: prefersTipDown(ti),
  });
  console.log(
    c.toolClass.padEnd(20),
    'old:',
    oldReport.status.padEnd(9),
    oldReport.reasons
      .map((r) => r.code)
      .join(',')
      .padEnd(24),
    'seat:',
    seat === null
      ? 'none'
      : `${seat.report.status} ${seat.report.score} ${seat.report.reasons.map((r) => r.code).join(',')}`,
  );
  const look = { center: [100, 100, 15] as const, sizeMm: 420 };
  const grey = {
    mesh: holder.mesh,
    rotation: IDENTITY,
    position: [100, 100, 0] as const,
    color: '#8a8f98',
  };
  vizScene(
    [
      grey,
      {
        mesh: tool.mesh,
        rotation: placementOfPose(old.pose).rotation,
        position: placementOfPose(old.pose).position,
        color: '#d03030',
      },
    ],
    join(out, `old-${c.toolClass}.png`),
    { center: [...look.center], sizeMm: look.sizeMm },
  );
  if (seat !== null) {
    vizScene(
      [
        grey,
        {
          mesh: tool.mesh,
          rotation: seat.placement.rotation,
          position: seat.placement.position,
          color: '#2f8f4c',
        },
      ],
      join(out, `seat-${c.toolClass}.png`),
      { center: [...look.center], sizeMm: look.sizeMm },
    );
  }
}
