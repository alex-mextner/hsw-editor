/**
 * Letting go of a tool with no mount. A tool released free (not on a holder's slot, hook or peg) is judged by the same hang
 * analysis as the physics badge: if nothing holds it, it falls to the floor plane under the wall and lies there (one undo step
 * that returns it to where it came from); if something does (a shelf, a rail) it stays where the user put it. The decision
 * runs in the physics worker (0.05-0.5 s), so the tool is shown where it was released meanwhile; whatever goes wrong (no model,
 * physics off, the worker failing or too slow, the wall edited meanwhile) leaves it exactly where it was put, as before.
 */
import {
  applyOp,
  OpError,
  type LeafOp,
  type Op,
  type Pose,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { planFallRequest } from './assets.ts';
import type { PhysicsFaller } from './client.ts';
import type { FellPlan } from './protocol.ts';
import type { PostStepDeps } from './seat.ts';

/** What the fall decision needs of the editor: the post-step dependencies, with the worker's fall job instead of its seat job. */
export interface FallDeps extends Omit<PostStepDeps, 'ranker'> {
  readonly faller: () => PhysicsFaller;
}

/** The longest the tool hovers at its release pose waiting for the decision. */
export const FALL_DECISION_MS = 4000;

export interface FreeRelease {
  readonly toolId: string;
  /** The ops that put the tool at the pose it was released at (detach from a holder, move). */
  readonly ops: readonly LeafOp[];
  /** Undo-step label of those ops. */
  readonly label: string;
  /** A tool not on the wall yet (the ops add it): shown at its release pose while the decision is awaited. */
  readonly draft?: WallItem;
}

/**
 * `placed`: the ops were submitted as released. `fell`: submitted together with the fall, the tool rests at `to` (drop
 * `dropMm` from the release pose's centre of gravity). `refused`: the wall did not take the ops.
 */
export type ReleaseOutcome =
  | { readonly kind: 'placed' }
  | {
      readonly kind: 'fell';
      readonly to: Pose;
      readonly dropMm: number;
      readonly landedOn: string | null;
    }
  | { readonly kind: 'refused' };

/** The fall as ops: the tool turns into the pose it lies in and moves to where it rests (the wall's `moveItem` keeps `z` when asked to). */
export function fallOps(toolId: string, rest: Pose): LeafOp[] {
  return [
    { type: 'rotateItem', id: toolId, rotX: rest.rotX, rotY: rest.rotY, rotZ: rest.rotZ },
    { type: 'moveItem', id: toolId, to: { x: rest.x, y: rest.y, z: rest.z } },
  ];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  const { promise: timeout, resolve } = Promise.withResolvers<null>();
  const timer = setTimeout(() => resolve(null), ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The wall as it will be once `ops` are applied, or null when they do not apply (the submit will say why). */
function after(wall: Wall, ops: readonly LeafOp[]): Wall | null {
  try {
    return applyOp(wall, { type: 'batch', ops: [...ops] }).wall;
  } catch (error) {
    if (error instanceof OpError) return null;
    throw error;
  }
}

/** The worker's fall decision for the placed tool; null when it cannot be had (never throws). */
async function planOf(
  deps: FallDeps,
  placed: Wall,
  item: WallItem,
  toolId: string,
): Promise<FellPlan | null> {
  try {
    // The model of a tool resized a moment ago is still being rebuilt: judged on the size it has now, not skipped.
    if (deps.settled !== undefined && !(await deps.settled(toolId))) return null;
    const ctx = deps.context(placed);
    const request = ctx === null ? null : planFallRequest(placed, ctx, item, item.pose);
    if (request === null) return null;
    return await deps.faller().fall(request.request, request.sources);
  } catch (error) {
    console.warn(
      `[physics] fall decision for ${toolId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** The newest free release of each tool: an older one still waiting for its decision is dropped when a newer one starts. */
const latestRelease = new Map<string, symbol>();

/** The tool as the wall holds it, for telling whether somebody else changed it meanwhile. */
function toolState(wall: Wall, toolId: string): string | undefined {
  return JSON.stringify(wall.items.find((candidate) => candidate.id === toolId));
}

/**
 * Submits a free release: as it is, or with the fall when the physics says nothing holds the tool. Never throws. The returned
 * outcome tells the caller whether to play the fall. A release that went stale while it waited (another wall opened, the tool
 * changed by a newer edit or release) is dropped as `refused`: it must not overwrite what happened since.
 */
export async function releaseFree(
  release: FreeRelease,
  deps: FallDeps,
  timeoutMs: number = FALL_DECISION_MS,
): Promise<ReleaseOutcome> {
  const { toolId } = release;
  const token = Symbol(toolId);
  latestRelease.set(toolId, token);
  try {
    return await decideRelease(release, deps, timeoutMs, () => latestRelease.get(toolId) === token);
  } finally {
    if (latestRelease.get(toolId) === token) latestRelease.delete(toolId);
  }
}

async function decideRelease(
  release: FreeRelease,
  deps: FallDeps,
  timeoutMs: number,
  newest: () => boolean,
): Promise<ReleaseOutcome> {
  const { toolId, ops, label } = release;
  const start = deps.wall();
  const place = (): ReleaseOutcome => {
    const live = deps.wall();
    const stale =
      !newest() ||
      live?.id !== start?.id ||
      (start !== null && live !== null && toolState(start, toolId) !== toolState(live, toolId));
    if (stale) return { kind: 'refused' };
    return deps.submit(ops, label) ? { kind: 'placed' } : { kind: 'refused' };
  };
  if (start === null || !deps.enabled()) return place();
  const placed = after(start, ops);
  const item = placed?.items.find((candidate) => candidate.id === toolId);
  if (placed === null || item === undefined || item.kind !== 'tool' || item.locked) return place();
  const plan = await withTimeout(planOf(deps, placed, item, toolId), timeoutMs);
  // The user may have moved on (another edit, physics switched off, another wall) while the worker was busy: nothing of
  // the decision applies any more, the tool goes where it was put.
  const live = deps.wall();
  const same = live?.id === start.id && live.rev === start.rev;
  if (plan === null || !plan.falls || !deps.enabled() || !same || !newest()) {
    return place();
  }
  const batch: Op = { type: 'batch', label: 'fall', ops: [...ops, ...fallOps(toolId, plan.rest)] };
  return deps.submit([batch], 'fall')
    ? { kind: 'fell', to: plan.rest, dropMm: plan.dropMm, landedOn: plan.landedOn }
    : { kind: 'refused' };
}
