import { createValueStore } from '#state-backend';
import type { BankElement, Vec3, VariantResponse } from '@hsw-editor/bank';
import type { WallItem } from '@hsw-editor/core';
import { bankRoutes, requestVariant } from './client.ts';
import { paramsDraftFor } from '@/widgets/draft.ts';

/** What the scene needs to draw one item: grouping key, GLB urls and the footprint box. */
export interface ModelSource {
  readonly key: string;
  readonly lod0: string;
  readonly lod1: string;
  readonly dimsMm: Vec3;
  /** Box centre relative to the item origin (mm), for the fallback box and selection frame. */
  readonly centreMm: Vec3;
  readonly element: BankElement;
}

/** Stable key of a params object: same dimensions => same regenerated model => one instanced group. */
export function paramsKey(params: Readonly<Record<string, number>>): string {
  return Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

const variants = new Map<string, VariantResponse>();
const requested = new Set<string>();
/** Keys whose request failed; they are not retried until the page reloads (a re-render must not re-POST). */
const failed = new Set<string>();
/** Bumped whenever a regenerated model arrives, so scene hooks re-resolve. */
export const variantVersion = createValueStore<number>(0);

function variantKey(elementId: string, params: Readonly<Record<string, number>>): string {
  return `${elementId}|${paramsKey(params)}`;
}

function ensureVariant(
  elementId: string,
  params: Readonly<Record<string, number>>,
): VariantResponse | undefined {
  const key = variantKey(elementId, params);
  const cached = variants.get(key);
  if (cached || requested.has(key) || failed.has(key)) return cached;
  requested.add(key);
  requestVariant(elementId, params)
    .then((response) => {
      variants.set(key, response);
      variantVersion.set(variantVersion.get() + 1);
    })
    .catch(() => {
      // Keep drawing the base model; other params (another key) still request normally.
      failed.add(key);
    });
  return undefined;
}

/** Generated variant for exactly these params if it has arrived (requests it otherwise). */
export function variantFor(
  elementId: string,
  params: Readonly<Record<string, number>>,
): VariantResponse | undefined {
  return Object.keys(params).length === 0 ? undefined : ensureVariant(elementId, params);
}

function bboxCentre(box: BankElement['bboxMm']): Vec3 {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: (box.min.y + box.max.y) / 2,
    z: (box.min.z + box.max.z) / 2,
  };
}

export function resolveModel(
  item: WallItem,
  byId: ReadonlyMap<string, BankElement>,
): ModelSource | null {
  if (item.bankId === undefined) return null;
  const element = byId.get(item.bankId);
  if (!element) return null;
  // An uncommitted dimension edit previews through the same variant path as committed params.
  const variant = variantFor(element.id, paramsDraftFor(item.id) ?? item.params);
  if (variant) {
    return {
      key: `${element.id}|${variant.paramHash}`,
      lod0: variant.glbUrl,
      lod1: variant.glbUrl,
      dimsMm: variant.dimsMm,
      centreMm: bboxCentre(variant.bboxMm),
      element,
    };
  }
  return {
    key: element.id,
    lod0: bankRoutes.asset(element.assets.lod0.path),
    lod1: bankRoutes.asset(element.assets.lod1.path),
    dimsMm: element.dimsMm,
    centreMm: bboxCentre(element.bboxMm),
    element,
  };
}
