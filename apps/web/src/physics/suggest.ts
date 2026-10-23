/**
 * Choosing holders by physics.
 *
 * - `settleAfterDrop`: a tool dropped within reach of several suitable holders is hung on the nearest one at once (the
 *   preview and the drop stay instant); then the worker seats it in every holder within the snap radius and, when
 *   another holder is clearly more stable, one more undo step moves the tool there.
 * - `usePhysicsRatings`: how the selected tool would hang in each suggested holder (before the holder is on the wall),
 *   computed lazily, one holder after another, and cached.
 * - `useRankedCandidates`: the "Suggested holders" order: compatibility first, re-ranked with the physics rating once
 *   ratings arrive, without rows jumping under the pointer.
 */
import { createValueStore } from '#state-backend';
import {
  type AttachContext,
  type Compatibility,
  DEFAULT_SNAP_RADIUS_MM,
  evaluateHolders,
  rankWithPhysics,
} from '@hsw-editor/compat';
import type { BatchOp } from '@hsw-editor/core';
import {
  hangProblems,
  type PhysicsProblem,
  type RankedSeat,
  removalProblems,
} from '@hsw-editor/physics';
import { useEffect, useMemo, useState } from 'react';
import { bankStore } from '@/bank/client.ts';
import { libraryStore } from '@/features/tools/store.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';
import {
  planVirtualRank,
  planWallRank,
  toolModelSource,
  wallSlot,
  type WallSlot,
} from './assets.ts';
import { ensureToolLibrary, physicsContext } from './context.ts';
import { physicsEnabledStore } from './enabled.ts';
import { samePose, seatAfterHang, seatOps, type PostStepDeps, type SeatStatus } from './seat.ts';
import { physicsClient } from './service.ts';

/** How much better (0..1 on the combined rank) another holder must be before a dropped tool moves there. */
export const SWITCH_MARGIN = 0.05;

export type SettleStatus = SeatStatus | 'rehung';

/** Nearest free slot of an evaluated holder to `at`, ties to the lower slot index. */
function nearestFreeSlot(
  free: readonly { readonly slot: { readonly index: number }; readonly world: readonly number[] }[],
  at: { readonly x: number; readonly y: number },
): { readonly index: number; readonly distanceMm: number } | null {
  let best: { index: number; distanceMm: number } | null = null;
  for (const { slot, world } of free) {
    const distanceMm = Math.hypot((world[0] ?? 0) - at.x, (world[1] ?? 0) - at.y);
    if (best === null || distanceMm < best.distanceMm) best = { index: slot.index, distanceMm };
  }
  return best;
}

/**
 * Post-step of a tool dropped on the wall (drag from the panel, drag of a tool on the wall). The tool already hangs on
 * the nearest compatible holder; this seats it there, or on a clearly more stable neighbouring holder within the snap
 * radius of the drop point `at`. Never throws.
 */
export async function settleAfterDrop(
  toolId: string,
  at: { readonly x: number; readonly y: number },
  deps: PostStepDeps,
  radiusMm: number = DEFAULT_SNAP_RADIUS_MM,
): Promise<SettleStatus> {
  if (!deps.enabled()) return 'off';
  const wall = deps.wall();
  const ctx = wall === null ? null : deps.context(wall);
  const hung = wall?.items.find((item) => item.id === toolId);
  if (wall === null || ctx === null || hung?.parentId === undefined || hung.locked)
    return 'skipped';
  const tool = ctx.toolInterface(hung);
  if (tool === undefined) return 'skipped';
  const { parentId, pose: hungPose, slot: hungSlot } = hung;

  const attachCtx: AttachContext = {
    wall,
    holderSpec: (item) => (item.bankId === undefined ? undefined : ctx.bank.get(item.bankId)),
    toolInterface: ctx.toolInterface,
  };
  const holders = new Map(wall.items.filter((i) => i.kind === 'holder').map((i) => [i.id, i]));
  const slots: WallSlot[] = [];
  for (const evaluation of evaluateHolders(attachCtx, hung)) {
    const holderItem = holders.get(evaluation.holderId);
    const element = holderItem?.bankId === undefined ? undefined : ctx.bank.get(holderItem.bankId);
    if (!evaluation.compat.ok || holderItem === undefined || element === undefined) continue;
    const current = evaluation.holderId === parentId;
    const nearest = nearestFreeSlot(evaluation.freeSlots, at);
    const index = current
      ? (hungSlot ?? nearest?.index)
      : nearest !== null && nearest.distanceMm <= radiusMm
        ? nearest.index
        : undefined;
    if (index === undefined) continue;
    const target = wallSlot(wall, hung, holderItem, element, tool, index);
    if (target !== null) slots.push(target);
  }
  // Nothing to choose between: seat where it hangs.
  if (slots.length <= 1) return seatAfterHang(toolId, deps);

  const plan = planWallRank(wall, ctx, hung, slots, true);
  if (plan === null) return 'kept';
  let ranked: readonly RankedSeat[];
  try {
    ranked = await deps.ranker().rank(plan.request, plan.sources);
  } catch (error) {
    console.warn(
      `[physics] holder choice failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'failed';
  }
  const best = ranked[0];
  if (best === undefined) return 'kept';
  const here = ranked.find((seat) => seat.holderId === parentId);
  const chosen =
    here === undefined ||
    best.holderId === parentId ||
    best.combined - here.combined >= SWITCH_MARGIN
      ? best
      : here;

  const live = deps.wall()?.items.find((item) => item.id === toolId);
  // The user may have moved the tool on, or hung it elsewhere, while the worker was busy.
  if (
    live === undefined ||
    live.parentId !== parentId ||
    live.slot !== hungSlot ||
    live.locked ||
    !samePose(live.pose, hungPose)
  )
    return 'stale';
  const pose = chosen.seat.pose;
  if (chosen.holderId === parentId) {
    if (samePose(pose, hungPose)) return 'kept';
    return deps.submit([seatOps(toolId, pose)], 'seat') ? 'seated' : 'stale';
  }
  const slot = slots.find((s) => s.holderItem.id === chosen.holderId)?.slot.index;
  if (slot === undefined) return 'kept';
  const hang: BatchOp = {
    type: 'batch',
    label: 'hang',
    ops: [
      { type: 'attachItem', id: toolId, parentId: chosen.holderId, slot },
      ...seatOps(toolId, pose).ops,
    ],
  };
  return deps.submit([hang], 'hang') ? 'rehung' : 'stale';
}

// ---- ratings of suggested holders --------------------------------------------------------------------

/** How a tool hangs in one suggested holder (the shape the suggestion cards render). */
export interface HolderRating {
  readonly stability: number;
  readonly convenience: number | null;
  readonly status: 'stable' | 'marginal' | 'unstable';
  readonly reasons: readonly PhysicsProblem[];
}

export function ratingOfSeat(seat: RankedSeat): HolderRating {
  const { report } = seat.seat;
  return {
    stability: report.score,
    convenience: seat.removal?.convenience ?? null,
    status: report.status,
    reasons: [
      ...hangProblems(report),
      ...(seat.removal === null ? [] : removalProblems(seat.removal)),
    ],
  };
}

/** Per (tool model, holder element); `null` = judged, no seat exists. Replaced whole on every change (hooks read it as state). */
const ratingsStore = createValueStore<ReadonlyMap<string, HolderRating | null>>(new Map());
const CACHE_LIMIT = 600;
/** One rating at a time: the worker is shared with the wall check. */
let ratingQueue: Promise<void> = Promise.resolve();

const EMPTY: ReadonlyMap<string, HolderRating> = new Map();

function withRating(key: string, rating: HolderRating | null): void {
  const current = ratingsStore.get();
  const next = new Map(current.size >= CACHE_LIMIT ? [] : current);
  next.set(key, rating);
  ratingsStore.set(next);
}

/**
 * How `toolItemId` would hang in each bank holder of `holderIds` (bank element ids, as the suggestion list shows them),
 * the holder standing alone: stability, convenience, status and reasons. Ratings arrive one by one (the map grows);
 * an element the tool cannot be seated in has no entry. Empty while physics checks are off.
 */
export function usePhysicsRatings(
  toolItemId: string,
  holderIds: readonly string[],
): ReadonlyMap<string, HolderRating> {
  const enabled = useStore(physicsEnabledStore);
  const wall = useStore(sessionStore)?.wall ?? null;
  const bank = useStore(bankStore);
  const library = useStore(libraryStore);
  const rated = useStore(ratingsStore);
  const ctx = useMemo(
    () => (wall === null ? null : physicsContext(wall, bank, library)),
    [wall, bank, library],
  );
  const toolItem = wall?.items.find((item) => item.id === toolItemId && item.kind === 'tool');
  const model = useMemo(
    () =>
      wall === null || toolItem === undefined || ctx === null
        ? null
        : toolModelSource(toolItem, wall, ctx.library),
    [wall, toolItem, ctx],
  );
  const idsKey = holderIds.join('\n');

  // The generated models are found through the tool library, which may not have been opened yet.
  useEffect(() => {
    if (enabled && idsKey !== '') void ensureToolLibrary();
  }, [enabled, idsKey]);

  useEffect(() => {
    if (!enabled || wall === null || ctx === null || toolItem === undefined || model === null)
      return undefined;
    let cancelled = false;
    const ids = idsKey === '' ? [] : idsKey.split('\n');
    const pending = ids.filter((id) => !ratingsStore.get().has(`${model.key}|${id}`));
    if (pending.length === 0) return undefined;
    ratingQueue = ratingQueue.then(async () => {
      for (const id of pending) {
        if (cancelled) return;
        const key = `${model.key}|${id}`;
        if (ratingsStore.get().has(key)) continue;
        const element = ctx.bank.get(id);
        const plan = element === undefined ? null : planVirtualRank(wall, ctx, toolItem, element);
        try {
          const [best] =
            plan === null ? [] : await physicsClient().rank(plan.request, plan.sources);
          withRating(key, best === undefined ? null : ratingOfSeat(best));
        } catch (error) {
          console.warn(
            `[physics] rating of ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, wall, ctx, toolItem, model, idsKey]);

  return useMemo(() => {
    if (!enabled || model === null) return EMPTY;
    const out = new Map<string, HolderRating>();
    for (const id of idsKey === '' ? [] : idsKey.split('\n')) {
      const rating = rated.get(`${model.key}|${id}`);
      if (rating !== undefined && rating !== null) out.set(id, rating);
    }
    return out;
  }, [enabled, model, idsKey, rated]);
}

// ---- order of the suggestion list ----------------------------------------------------------------------

/** A tool's holder suggestion is a holder it fits by construction: its fit score is all `rankWithPhysics` needs. */
function fitOf(score: number): Compatibility {
  return { ok: true, score, reasons: [], clearances: [], entryIndex: null };
}

/**
 * Suggestions best first: fit score and physics rating folded (`rankWithPhysics`), a holder without a rating keeping
 * its fit score; ties keep the incoming (compatibility) order.
 */
export function rankCandidates<
  T extends { readonly element: { readonly id: string }; readonly score: number | null },
>(candidates: readonly T[], ratings: ReadonlyMap<string, HolderRating>): T[] {
  const keyed = candidates.map((candidate, index) => ({
    candidate,
    index,
    key: rankWithPhysics(fitOf(candidate.score ?? 0), ratings.get(candidate.element.id)),
  }));
  return keyed.sort((a, b) => b.key - a.key || a.index - b.index).map((entry) => entry.candidate);
}

/**
 * The order to show. `shown` is the order on screen now; it stays unless the ranked order moves some row by more than
 * one place (a row never hops under the pointer for a tiny score change). A different set of rows resets to `ranked`.
 */
export function steadyOrder<T extends { readonly element: { readonly id: string } }>(
  ranked: readonly T[],
  shown: readonly string[],
): T[] {
  const rankOf = new Map(ranked.map((candidate, index) => [candidate.element.id, index]));
  const sameRows = shown.length === ranked.length && shown.every((id) => rankOf.has(id));
  const steady =
    sameRows && shown.every((id, index) => Math.abs((rankOf.get(id) ?? 0) - index) <= 1);
  if (!steady) return [...ranked];
  const byId = new Map(ranked.map((candidate) => [candidate.element.id, candidate]));
  return shown.flatMap((id) => {
    const candidate = byId.get(id);
    return candidate === undefined ? [] : [candidate];
  });
}

/**
 * `candidates` (compatibility order) re-ranked by `ratings` as they arrive, steadily: see `steadyOrder`. Without any
 * rating the incoming order is returned as is.
 */
export function useRankedCandidates<
  T extends { readonly element: { readonly id: string }; readonly score: number | null },
>(candidates: readonly T[], ratings: ReadonlyMap<string, HolderRating>): readonly T[] {
  // The order on screen: what `steadyOrder` compares the new ranking against.
  const [shown, setShown] = useState<readonly string[]>([]);
  const ordered = useMemo(
    () =>
      ratings.size === 0 ? candidates : steadyOrder(rankCandidates(candidates, ratings), shown),
    [candidates, ratings, shown],
  );
  // Remember the order that is on screen now (derived during render: React re-renders at once, no effect needed).
  const ids = ordered.map((candidate) => candidate.element.id);
  if (ids.join('\n') !== shown.join('\n')) setShown(ids);
  return ordered;
}
