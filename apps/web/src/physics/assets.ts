/**
 * Wall -> physics scene: which model each item is, where it stands, what its holder carries. Pure: the editor-specific
 * lookups (bank, tool library, tool interface) arrive in an `AssetContext`, so this is testable under bun.
 *
 * A tool is judged only when its generated model is known and carries mass data; there is no invented stand-in
 * (a box would have an invented centre of gravity). Holders and shelves use the bank GLB at full detail, the same
 * file the invalid zones use.
 */
import type { BankElement } from '@hsw-editor/bank';
import {
  compatibility,
  type Compatibility,
  type HolderSpec,
  eulerToMatrix,
  matchedEntry,
  type MountSlot,
  mountSlots,
  prefersTipDown,
  slotWorldPosition,
  type ToolInterface,
} from '@hsw-editor/compat';
import type { Pose, Wall, WallItem } from '@hsw-editor/core';
import { defaultLoadCapacityG } from '@hsw-editor/physics';
import { bankRoutes } from '@/bank/client.ts';
import { resolveModel } from '@/bank/models.ts';
import { toolRoutes, type ToolClassInfo, type ToolSummary } from '@/features/tools/api.ts';
import { itemBounds } from '@/scene/itemBounds.ts';
import type {
  BodySource,
  PhysicsScene,
  PlacedBody,
  PlacedTool,
  RankRequest,
  SeatCandidate,
} from './protocol.ts';

/** The tool library as far as model lookup needs it (a subset of `libraryStore`). */
export interface ToolLibrary {
  readonly classes: readonly Pick<ToolClassInfo, 'id' | 'bankClass' | 'schema'>[];
  readonly tools: readonly Pick<ToolSummary, 'id' | 'updatedAt'>[];
}

export const EMPTY_LIBRARY: ToolLibrary = { classes: [], tools: [] };

export interface AssetContext {
  readonly bank: ReadonlyMap<string, BankElement>;
  readonly library: ToolLibrary;
  /** Resolves the relative asset urls; the worker needs absolute ones. */
  readonly baseUrl: string;
  /** Holding interface of a tool item (for the holder's mount entry and the tip-down preference). */
  readonly toolInterface: (item: WallItem) => ToolInterface | undefined;
}

/** Route of a tool's generated model. `key` identifies the geometry: equal keys are the same model. */
export interface ToolModelSource {
  readonly key: string;
  /** Relative url of the GLB (level of detail 1: enough for balance and slots, light to fetch). */
  readonly path: string;
}

/** Parameters of a class that are box sizes of the wall item, not the generator's. */
const BOX_KEYS: ReadonlySet<string> = new Set(['width', 'length', 'thickness']);

/** Parameters the item changes against the class defaults: the same build the library draws for it. */
function classOverrides(
  params: Readonly<Record<string, number>>,
  cls: Pick<ToolClassInfo, 'schema'>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(params).sort()) {
    const spec = cls.schema[key];
    const value = params[key];
    if (spec?.kind !== 'num' || BOX_KEYS.has(key) || value === undefined) continue;
    if (Math.abs(spec.def - value) > 1e-3) out[key] = value;
  }
  return out;
}

/** Generator class that draws a tool of bank class `toolClass`: the class of the same id first, else the first one. */
function classOfBankClass(
  library: ToolLibrary,
  toolClass: string,
): ToolLibrary['classes'][number] | undefined {
  const named = library.classes.filter((cls) => cls.bankClass === toolClass);
  return named.find((cls) => cls.id === toolClass) ?? named[0];
}

/**
 * Generated model of a wall tool item, or null when it has none (no library entry, class unknown, library not
 * loaded). A tool added from the user library (`source.by = tool:<id>`) uses that tool's stored model; one added from a
 * generator class (`gen:<class>`) that class; any other tool the class of its bank class. Swap this function for
 * `resolveToolModel` once the scene draws generated tools: both answer the same question.
 */
export function toolModelSource(
  item: WallItem,
  wall: Wall,
  library: ToolLibrary,
): ToolModelSource | null {
  if (item.kind !== 'tool') return null;
  const ref =
    item.modelRefId === undefined ? undefined : wall.models.find((m) => m.id === item.modelRefId);
  const by = ref?.source.by;
  if (by?.startsWith('tool:') === true) {
    const id = by.slice('tool:'.length);
    const tool = library.tools.find((t) => t.id === id);
    // A user tool that left the library has no model to analyse; the bank class default would be another tool.
    return tool === undefined
      ? null
      : { key: `tool|${id}|${tool.updatedAt}`, path: toolRoutes.toolGlb(id, tool.updatedAt, 1) };
  }
  const named = by?.startsWith('gen:') === true ? by.slice('gen:'.length) : undefined;
  const toolClass = item.toolClass ?? ref?.toolClass;
  const cls =
    named !== undefined
      ? library.classes.find((c) => c.id === named)
      : toolClass === undefined
        ? undefined
        : classOfBankClass(library, toolClass);
  if (cls === undefined) return null;
  const values = classOverrides(item.params, cls);
  return {
    key: `class|${cls.id}|${JSON.stringify(values)}`,
    path: toolRoutes.classGlb(cls.id, values, 1),
  };
}

export interface SceneBuild {
  readonly scene: PhysicsScene;
  readonly sources: ReadonlyMap<string, BodySource>;
}

function absolute(path: string, baseUrl: string): string {
  return new URL(path, baseUrl).href;
}

/** The bank model of a holder / board part as a posed body, with its source registered; null without a model. */
function solidOf(
  item: WallItem,
  ctx: AssetContext,
  sources: Map<string, BodySource>,
): PlacedBody | null {
  const model = resolveModel(item, ctx.bank);
  if (model === null) return null;
  sources.set(model.key, { kind: 'solid', url: absolute(model.lod0, ctx.baseUrl) });
  return { id: item.id, bodyKey: model.key, pose: item.pose };
}

/** What a holder's slot carries for a tool: the bank's number for the matched entry, else the category default. */
export function loadLimitG(
  tool: ToolInterface | undefined,
  holder: HolderSpec,
): number {
  const compat = tool === undefined ? null : compatibility(tool, holder);
  const entry = compat === null ? null : matchedEntry(holder, compat);
  return entry?.maxLoadG ?? defaultLoadCapacityG(holder.category);
}

/** The whole wall as the physics sees it. Items without a usable model are left out (tools are reported by the worker). */
export function buildPhysicsScene(wall: Wall, ctx: AssetContext): SceneBuild {
  const sources = new Map<string, BodySource>();
  const holders: PlacedBody[] = [];
  const others: PlacedBody[] = [];
  const tools: PlacedTool[] = [];
  const holderItems = new Map(wall.items.filter((i) => i.kind === 'holder').map((i) => [i.id, i]));
  for (const item of wall.items) {
    if (item.kind === 'holder' || item.kind === 'board-part') {
      const body = solidOf(item, ctx, sources);
      if (body !== null) (item.kind === 'holder' ? holders : others).push(body);
    } else if (item.kind === 'tool') {
      const model = toolModelSource(item, wall, ctx.library);
      if (model === null) continue;
      sources.set(model.key, { kind: 'tool', url: absolute(model.path, ctx.baseUrl) });
      const holder = item.parentId === undefined ? undefined : holderItems.get(item.parentId);
      const element = holder?.bankId === undefined ? undefined : ctx.bank.get(holder.bankId);
      tools.push({
        id: item.id,
        bodyKey: model.key,
        pose: item.pose,
        holderId: holder?.id ?? null,
        maxLoadG: element === undefined ? undefined : loadLimitG(ctx.toolInterface(item), element),
      });
    }
  }
  return { scene: { holders, tools, others }, sources };
}

// ---- seating --------------------------------------------------------------------------------------

/** Half the slot pitch, capped: a tool is lowered at most this far either side of the slot centre (mm). */
const MAX_SLOT_HALF_WIDTH_MM = 14;

/** Seating lowers a tool straight down in the holder's own frame: only an upright holder is seated. */
export function isUpright(pose: Pose): boolean {
  const turn = ((pose.rotZ % 360) + 360) % 360;
  return Math.abs(pose.rotX) < 0.5 && Math.abs(pose.rotY) < 0.5 && (turn < 0.5 || turn > 359.5);
}

/** A slot of a holder a tool could be seated in. */
export interface SlotTarget {
  readonly holder: PlacedBody;
  readonly element: Pick<BankElement, 'bboxMm' | 'category' | 'fitsTool' | 'id'>;
  readonly slot: MountSlot;
  /** Slots of the matched mount entry (the slot pitch follows from it). */
  readonly slots: number;
  readonly compat: Pick<Compatibility, 'score'>;
}

/** Candidate of `RankRequest` for one slot; null when the holder is not upright (it keeps the compat pose). */
export function seatCandidate(target: SlotTarget, tool: ToolInterface): SeatCandidate | null {
  const pose = target.holder.pose;
  if (!isUpright(pose)) return null;
  const width = target.element.bboxMm.max.x - target.element.bboxMm.min.x;
  const anchor = slotWorldPosition(target.slot, pose, eulerToMatrix(pose));
  return {
    holder: target.holder,
    anchor,
    halfWidthMm: Math.min(width / Math.max(1, target.slots) / 2, MAX_SLOT_HALF_WIDTH_MM),
    tipDown: prefersTipDown(tool),
    compatScore: target.compat.score,
    maxLoadG: loadLimitG(tool, target.element),
  };
}

/** Slots a holder element offers for a compatibility result. */
export function slotsOf(
  element: BankElement,
  compat: Compatibility,
): { slots: MountSlot[]; count: number } {
  const slots = mountSlots(element, matchedEntry(element, compat));
  return { slots, count: slots.length };
}

export interface RankPlan {
  readonly request: RankRequest;
  readonly sources: ReadonlyMap<string, BodySource>;
}

/**
 * Bodies near enough to a seated tool to be touched by it: a sphere around each item's origin that holds its box,
 * tested against the holder's sphere grown by the tool's reach.
 */
function nearbyBodies(
  wall: Wall,
  ctx: AssetContext,
  scene: SceneBuild,
  centre: WallItem,
  toolItem: WallItem,
): PlacedBody[] {
  const radiusOf = (item: WallItem): number => {
    const bounds = itemBounds(item, wall, ctx.bank);
    if (bounds === null) return 0;
    return (
      Math.hypot(bounds.centre.x, bounds.centre.y, bounds.centre.z) +
      Math.hypot(bounds.dims.x, bounds.dims.y, bounds.dims.z) / 2
    );
  };
  const byId = new Map(wall.items.map((i) => [i.id, i]));
  const reach = radiusOf(centre) + radiusOf(toolItem);
  const out: PlacedBody[] = [];
  const all = [...scene.scene.holders, ...scene.scene.others, ...scene.scene.tools];
  for (const body of all) {
    if (body.id === toolItem.id) continue;
    const item = byId.get(body.id);
    if (item === undefined) continue;
    const distance = Math.hypot(
      item.pose.x - centre.pose.x,
      item.pose.y - centre.pose.y,
      item.pose.z - centre.pose.z,
    );
    if (distance <= reach + radiusOf(item)) out.push(body);
  }
  return out;
}

/** A slot of a holder that is on the wall. */
export interface WallSlot {
  readonly holderItem: WallItem;
  readonly element: BankElement;
  readonly compat: Compatibility;
  readonly slot: MountSlot;
}

/**
 * The slot `toolItem` takes (or would take) in `holderItem`: `wanted` when given, else the first slot nobody else uses.
 * Null when the holder does not take the tool or has no such slot.
 */
export function wallSlot(
  wall: Wall,
  toolItem: WallItem,
  holderItem: WallItem,
  element: BankElement,
  tool: ToolInterface,
  wanted?: number,
): WallSlot | null {
  const others = wall.items.filter(
    (item) => item.kind === 'tool' && item.parentId === holderItem.id && item.id !== toolItem.id,
  );
  const compat = compatibility(tool, element, { occupied: others.length });
  if (!compat.ok) return null;
  const taken = new Set(others.flatMap((other) => (other.slot === undefined ? [] : [other.slot])));
  const { slots } = slotsOf(element, compat);
  const slot =
    wanted === undefined
      ? slots.find((s) => !taken.has(s.index))
      : slots.find((s) => s.index === wanted);
  return slot === undefined ? null : { holderItem, element, compat, slot };
}

/**
 * Request that seats `toolItem` in each of `slots` (slots of holders that are on the wall), with everything near as
 * obstacles. Null when the tool has no model or no slot is seatable.
 */
export function planWallRank(
  wall: Wall,
  ctx: AssetContext,
  toolItem: WallItem,
  slots: readonly WallSlot[],
  removal: boolean,
): RankPlan | null {
  const model = toolModelSource(toolItem, wall, ctx.library);
  const tool = ctx.toolInterface(toolItem);
  if (model === null || tool === undefined) return null;
  const built = buildPhysicsScene(wall, ctx);
  const candidates: SeatCandidate[] = [];
  const neighbours = new Map<string, PlacedBody>();
  for (const target of slots) {
    const holder = built.scene.holders.find((h) => h.id === target.holderItem.id);
    if (holder === undefined) continue;
    const candidate = seatCandidate(
      {
        holder,
        element: target.element,
        slot: target.slot,
        slots: slotsOf(target.element, target.compat).count,
        compat: target.compat,
      },
      tool,
    );
    if (candidate === null) continue;
    candidates.push(candidate);
    for (const body of nearbyBodies(wall, ctx, built, target.holderItem, toolItem))
      neighbours.set(body.id, body);
  }
  if (candidates.length === 0) return null;
  const sources = new Map(built.sources);
  sources.set(model.key, { kind: 'tool', url: absolute(model.path, ctx.baseUrl) });
  return {
    request: {
      tool: { id: toolItem.id, bodyKey: model.key },
      candidates,
      neighbours: [...neighbours.values()],
      removal,
    },
    sources,
  };
}

/** Synthetic id of a holder that is not on the wall (a suggestion). */
export const virtualHolderId = (elementId: string): string => `virtual:${elementId}`;

/**
 * Request that seats the tool in a bank holder standing alone at the wall origin: how the tool would hang in it,
 * without the wall around. This is what a suggestion is judged by before the holder is placed.
 */
export function planVirtualRank(
  wall: Wall,
  ctx: AssetContext,
  toolItem: WallItem,
  element: BankElement,
): RankPlan | null {
  const model = toolModelSource(toolItem, wall, ctx.library);
  const tool = ctx.toolInterface(toolItem);
  if (model === null || tool === undefined) return null;
  const compat = compatibility(tool, element);
  if (!compat.ok) return null;
  // The base model of the element (the same key and file the scene draws it from), not a variant.
  const solid = {
    key: element.id,
    lod0: bankRoutes.asset(element.assets.lod0.path),
  };

  const pose: Pose = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
  const holder: PlacedBody = { id: virtualHolderId(element.id), bodyKey: solid.key, pose };
  const { slots, count } = slotsOf(element, compat);
  const slot = slots[0];
  if (slot === undefined) return null;
  const candidate = seatCandidate({ holder, element, slot, slots: count, compat }, tool);
  if (candidate === null) return null;
  return {
    request: {
      tool: { id: toolItem.id, bodyKey: model.key },
      candidates: [candidate],
      neighbours: [],
      removal: true,
    },
    sources: new Map<string, BodySource>([
      [solid.key, { kind: 'solid', url: absolute(solid.lod0, ctx.baseUrl) }],
      [model.key, { kind: 'tool', url: absolute(model.path, ctx.baseUrl) }],
    ]),
  };
}
