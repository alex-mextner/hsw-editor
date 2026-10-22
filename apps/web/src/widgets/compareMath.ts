/** Pure logic of comparing candidate reference models: dimension deltas, selection, accept/reject ops. */
import type { LeafOp, ModelRef, WallItem } from '@hsw-editor/core';

export interface Dims {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const AXES = ['x', 'y', 'z'] as const;
export type Axis = (typeof AXES)[number];

/** Side-by-side tiles stop being readable beyond this. */
export const MAX_COMPARED = 4;

export function dimensionDelta(dims: Dims, reference: Dims): Dims {
  return { x: dims.x - reference.x, y: dims.y - reference.y, z: dims.z - reference.z };
}

export function meanDims(list: readonly Dims[]): Dims | null {
  if (list.length === 0) return null;
  const sum = list.reduce((acc, d) => ({ x: acc.x + d.x, y: acc.y + d.y, z: acc.z + d.z }), {
    x: 0,
    y: 0,
    z: 0,
  });
  return { x: sum.x / list.length, y: sum.y / list.length, z: sum.z / list.length };
}

export type DeltaTone = 'same' | 'minor' | 'major';

/** A delta under 2 % of the reference (or half a millimetre) is measurement noise, over 8 % is a different object. */
export function deltaTone(delta: number, reference: number): DeltaTone {
  const size = Math.abs(delta);
  if (size < 0.5 || size <= 0.02 * Math.abs(reference)) return 'same';
  return size <= 0.08 * Math.abs(reference) ? 'minor' : 'major';
}

export interface Reference {
  readonly dims: Dims;
  /** What the deltas are measured against. */
  readonly source: 'item' | 'others';
}

/** The item's own dimensions when known, else the mean of the other candidates that have any. */
export function referenceFor(
  candidate: ModelRef,
  itemDims: Dims | null,
  candidates: readonly ModelRef[],
): Reference | null {
  if (itemDims) return { dims: itemDims, source: 'item' };
  const others = candidates.flatMap((other) =>
    other.id !== candidate.id && other.dimensionsMm ? [other.dimensionsMm] : [],
  );
  const dims = meanDims(others);
  return dims ? { dims, source: 'others' } : null;
}

const STATUS_RANK: Readonly<Record<ModelRef['status'], number>> = {
  candidate: 0,
  chosen: 1,
  rejected: 2,
};

/** Models to show when more exist than fit: open candidates first, best score first, stable otherwise. */
export function pickCompareIds(models: readonly ModelRef[], max = MAX_COMPARED): string[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort(
      (a, b) =>
        STATUS_RANK[a.model.status] - STATUS_RANK[b.model.status] ||
        (b.model.score ?? -1) - (a.model.score ?? -1) ||
        a.index - b.index,
    )
    .slice(0, max)
    .map(({ model }) => model.id);
}

/**
 * Accepting `chosenId`: it becomes `chosen`, every other compared model `rejected`. A candidate that
 * is a bank element also switches the item to it (a locked item refuses edits, so it is left alone).
 */
export function buildAcceptOps(
  candidates: readonly ModelRef[],
  chosenId: string,
  item: WallItem | undefined,
): LeafOp[] {
  const ops: LeafOp[] = [];
  for (const model of candidates) {
    const status = model.id === chosenId ? 'chosen' : 'rejected';
    if (model.status !== status)
      ops.push({ type: 'updateModelRef', id: model.id, patch: { status } });
  }
  const chosen = candidates.find((model) => model.id === chosenId);
  if (item && !item.locked && chosen?.bankId !== undefined) {
    ops.push({ type: 'setVariant', id: item.id, variantId: chosen.bankId, bankId: chosen.bankId });
  }
  return ops;
}

export function buildRejectOps(candidate: ModelRef): LeafOp[] {
  return candidate.status === 'rejected'
    ? []
    : [{ type: 'updateModelRef', id: candidate.id, patch: { status: 'rejected' } }];
}

/** Only http(s) links are rendered as links: provenance URLs come from agents and web pages. */
export function safeExternalUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** One colour per compared candidate; shared by the overlay, the ghost and the tile accents. */
const CANDIDATE_COLORS = ['#38bdf8', '#f5b942', '#4ade80', '#f472b6'] as const;

export function candidateColor(index: number): string {
  return CANDIDATE_COLORS[index % CANDIDATE_COLORS.length] ?? '#38bdf8';
}

/**
 * Current size of the item the candidates compete for: its reference model, else its bank element.
 * A reference model that is itself being compared says nothing about the item, so it is skipped.
 */
export function itemDimensions(
  item: WallItem | undefined,
  models: readonly ModelRef[],
  comparedIds: ReadonlySet<string>,
  bankDims: Dims | undefined,
): Dims | null {
  if (!item) return null;
  if (item.modelRefId !== undefined) {
    if (comparedIds.has(item.modelRefId)) return null;
    return models.find((model) => model.id === item.modelRefId)?.dimensionsMm ?? null;
  }
  return bankDims ?? null;
}
