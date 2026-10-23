/**
 * Which generated model draws a wall tool item, and where it is: the single answer the scene, the selection frame,
 * the invalid-zone solids and the hang placement all share, so they never disagree about what a tool looks like.
 *
 * Lookup is synchronous (it runs per item per render and per pointer move); whatever is not loaded yet is asked for and
 * answered `null` / the class default until it arrives (`toolAssetsStore`, `toolModelVersion` change then).
 */
import { broaderToolClasses, type Vec3 } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import {
  differsFromDims,
  toolAssetUrl,
  type HoldingSummary,
  type ToolAssetEntry,
  type ToolDims,
} from '@hsw-editor/tools/contract';
import { paramsKey } from '@/bank/models.ts';
import { BOX_PARAM_KEY_NAMES } from './holdingInterface.ts';
import { paramsDraftFor } from '@/widgets/draft.ts';
import {
  ensureToolAssets,
  entryForBankClass,
  noteMissingToolModel,
  entryForSource,
  toolAssetsStore,
  type ToolAssetsState,
} from './assets.ts';
import { ModelRegen, type ModelBuild } from './regen.ts';
import { spawnRegenWorker } from './spawnRegenWorker.ts';

/** A tool's model as the scene draws it. */
export interface ToolModelSource {
  /** Instancing key: items with the same key share one set of meshes. */
  readonly key: string;
  readonly lod0: string;
  readonly lod1: string;
  /** Bounding box of the model (x width, y length, z thickness) and its centre in the tool frame. */
  readonly dimsMm: Vec3;
  readonly centreMm: Vec3;
  readonly holding: HoldingSummary;
  /** Generator class id or user tool id the model comes from. */
  readonly entryId: string;
  /** The model has the box the item asks for; false while a regenerated size is building (the class default stands in) or when the class cannot be that size. */
  readonly exact: boolean;
  /** A rebuild for the item's size is queued or running: the model drawn is the class default until it arrives. */
  readonly pending: boolean;
  /** The rebuild for the item's size failed (the worker crashed or did not load): the class default stays, which is not a size limit. */
  readonly failed: boolean;
}

const BOX_KEYS = { x: 'width', y: 'length', z: 'thickness' } as const;

/**
 * Class parameters the item overrides: its named dimensions that are parameters of the generator (`shaftDiameter`, `handleLength`)
 * and differ from the unedited build. The measured dimensions of a dragged class default equal the build and so are not overrides.
 */
export function classOverrides(
  item: WallItem,
  entry: ToolAssetEntry,
): Readonly<Record<string, number>> {
  const params = paramsDraftFor(item.id) ?? item.params;
  const out: Record<string, number> = {};
  if (entry.values === null) return out;
  for (const [key, value] of Object.entries(params)) {
    const base = entry.values[key];
    if (BOX_PARAM_KEY_NAMES.has(key) || typeof base !== 'number' || !Number.isFinite(value))
      continue;
    if (Math.abs(base - value) > 1e-3) out[key] = value;
  }
  return out;
}

/** `by` of a model reference that names the generator class (`gen:screwdriver`) or user tool (`tool:abc`) a tool was added from. */
export function generatorRef(
  by: string | undefined,
): { kind: 'class' | 'tool'; id: string } | null {
  if (by?.startsWith('tool:')) return { kind: 'tool', id: by.slice('tool:'.length) };
  if (by?.startsWith('gen:')) return { kind: 'class', id: by.slice('gen:'.length) };
  return null;
}

/**
 * The box the item asks for, per axis: what the user typed (the dimension widget, or its draft), and for a tool detected on a
 * photo the size measured there. A preset's rough box is not a wish: the class default is the realistic size.
 */
export function wantedDims(item: WallItem, wall: Wall): Partial<ToolDims> {
  const params = paramsDraftFor(item.id) ?? item.params;
  const ref =
    item.modelRefId === undefined ? undefined : wall.models.find((m) => m.id === item.modelRefId);
  const measured = item.source.type === 'vision' ? ref?.dimensionsMm : undefined;
  const out: Partial<ToolDims> = {};
  for (const axis of ['x', 'y', 'z'] as const) {
    const wanted = params[BOX_KEYS[axis]] ?? measured?.[axis];
    if (wanted !== undefined && wanted > 0) out[axis] = wanted;
  }
  return out;
}

/** Entry of the asset index that draws `item`, or undefined (no generator for its class, not loaded yet). */
export function entryOfTool(
  item: WallItem,
  wall: Wall,
  state: ToolAssetsState,
  vocabulary?: readonly { readonly id: string; readonly broader?: string | undefined }[],
): ToolAssetEntry | undefined {
  const ref =
    item.modelRefId === undefined ? undefined : wall.models.find((m) => m.id === item.modelRefId);
  const named = generatorRef(ref?.source.by);
  if (named) {
    const entry = entryForSource(state, named);
    if (entry) return entry;
    if (named.kind === 'tool' && state.status === 'ready') noteMissingToolModel();
  }
  const toolClass = item.toolClass ?? ref?.toolClass;
  if (toolClass === undefined) return undefined;
  return entryForBankClass(state, toolClass, broaderToolClasses(toolClass, vocabulary));
}

/** Box of the unedited generated model of a tool (its class default, or the library tool's own size); null without one. */
export function defaultDimsOfTool(
  item: WallItem,
  wall: Wall,
  state: ToolAssetsState = toolAssetsStore.get(),
): ToolDims | null {
  if (item.kind !== 'tool') return null;
  ensureToolAssets();
  return entryOfTool(item, wall, state)?.dimsMm ?? null;
}

function sourceOf(
  entry: ToolAssetEntry,
  exact: boolean,
  pending = false,
  failed = false,
): ToolModelSource {
  return {
    key: `tool|${entry.id}|${entry.paramHash}`,
    lod0: toolAssetUrl(entry.lod0),
    lod1: toolAssetUrl(entry.lod1),
    dimsMm: entry.dimsMm,
    centreMm: entry.centreMm,
    holding: entry.holding,
    entryId: entry.id,
    exact,
    pending,
    failed,
  };
}

function sourceOfBuild(
  entry: ToolAssetEntry,
  build: Extract<ModelBuild, { status: 'ready' }>,
): ToolModelSource {
  return {
    key: `tool|${entry.id}|${build.hash}`,
    lod0: build.lod0,
    lod1: build.lod1,
    dimsMm: build.dimsMm,
    centreMm: build.centreMm,
    holding: build.holding,
    entryId: entry.id,
    exact: build.reached,
    pending: false,
    failed: false,
  };
}

const round = (value: number | undefined): string =>
  value === undefined ? '-' : String(Math.round(value));

export interface ResolveDeps {
  readonly state: () => ToolAssetsState;
  readonly ensure: () => void;
  readonly regen: ModelRegen;
}

let liveRegen: ModelRegen | null = null;
const liveDeps: ResolveDeps = {
  state: () => toolAssetsStore.get(),
  ensure: ensureToolAssets,
  get regen() {
    liveRegen ??= new ModelRegen(spawnRegenWorker);
    return liveRegen;
  },
};

export function resolveToolModel(
  item: WallItem,
  wall: Wall,
  deps: ResolveDeps = liveDeps,
  vocabulary?: readonly { readonly id: string; readonly broader?: string | undefined }[],
): ToolModelSource | null {
  if (item.kind !== 'tool') return null;
  deps.ensure();
  const state = deps.state();
  const entry = entryOfTool(item, wall, state, vocabulary);
  if (!entry) return null;
  // A user tool is drawn from its stored model; only a class is rebuilt for another size.
  if (entry.kind !== 'class' || entry.classId === null || entry.values === null) {
    // Its own stored model cannot be rebuilt: a size typed for it that differs is shown as the closest there is.
    return sourceOf(entry, !differsFromDims(entry.dimsMm, wantedDims(item, wall)));
  }
  const wanted = wantedDims(item, wall);
  const overrides = classOverrides(item, entry);
  const overridden = Object.keys(overrides).length > 0;
  if (!overridden && !differsFromDims(entry.dimsMm, wanted)) return sourceOf(entry, true);
  const build = deps.regen.request({
    key: `${entry.id}@${round(wanted.x)}x${round(wanted.y)}x${round(wanted.z)}|${paramsKey(overrides)}`,
    classId: entry.classId,
    base: { ...entry.values, ...overrides },
    target: wanted,
  });
  if (build.status !== 'ready') {
    return sourceOf(entry, false, build.status === 'pending', build.status === 'failed');
  }
  // The solver gives the class default back (same hash) when it could not build the size: that is not the wanted size.
  return build.hash === entry.paramHash
    ? sourceOf(entry, build.reached)
    : sourceOfBuild(entry, build);
}
