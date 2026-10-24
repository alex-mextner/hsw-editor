/**
 * Seated poses of the showcase (demo) wall. The showcase builder hangs every tool at the compatibility pose (one point of the
 * tool on its slot anchor), which floats above or sinks into the real holder mesh, so the demo page's physics check would flag
 * most of its tools. The demo build has no daemon to seat them, so the build does it here, once, with the daemon's own seat
 * planner (`apps/server/src/physics/seat.ts`, the editor's `seatTool` search on the real holder meshes) and ships the resulting
 * ops next to the app (`/api/demo/seats`); the demo wall applies them after building itself (`apps/web/src/demo/demoApi.ts`).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HolderSpec } from '../../packages/compat/src/index.ts';
import type { LeafOp, Wall } from '../../packages/core/src/index.ts';
import type { ToolAssetIndex } from '../../packages/tools/src/contract.ts';
import { buildShowcaseWall } from '../../apps/web/src/demo/showcase.ts';
import type { ShowcaseHolder } from '../../apps/web/src/demo/showcaseLayout.ts';
import { PhysicsAssets } from '../../apps/server/src/physics/assets.ts';
import { createSeatPlanner, type NoSeatReason } from '../../apps/server/src/physics/seat.ts';

/** What `/api/demo/seats` serves: the ops that seat the showcase tools, and what the planner said about the rest. */
export interface ShowcaseSeats {
  readonly ops: readonly LeafOp[];
  readonly seated: number;
  readonly unchanged: number;
  readonly kept: readonly { readonly toolId: string; readonly reason: NoSeatReason }[];
}

export interface SeatedShowcase {
  readonly wall: Wall;
  readonly unhung: readonly string[];
  readonly seats: ShowcaseSeats;
}

/** Builds the showcase wall and seats its tools. `home` holds nothing the planner reads (the bank is the committed seed). */
export async function seatShowcase(
  layout: readonly ShowcaseHolder[],
  specs: ReadonlyMap<string, HolderSpec>,
  tools: ToolAssetIndex,
): Promise<SeatedShowcase> {
  const { wall, unhung } = buildShowcaseWall('demo', 'Demo wall (read-only)', layout, specs, tools);
  const home = await mkdtemp(join(tmpdir(), 'hsw-demo-seats-'));
  try {
    const plan = await createSeatPlanner(new PhysicsAssets(home)).seatAll(wall);
    return {
      wall,
      unhung,
      seats: {
        ops: plan.ops,
        seated: plan.seats.length,
        unchanged: plan.unchanged.length,
        kept: plan.kept,
      },
    };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
