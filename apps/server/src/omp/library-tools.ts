/**
 * Pure helpers of the host tools that bring the user's tool library (`packages/tools`, `GET /api/tools`) onto the wall:
 * filtering the library, and the model reference + tool item of a library tool (the same `toolDraftOps` the editor's
 * Tools panel uses) together with the mount choice of `@hsw-editor/compat`.
 */
import { broaderToolClasses } from '@hsw-editor/bank';
import {
  type AttachContext,
  type HolderEvaluation,
  type HolderSpec,
  type HoldingMeasure,
  measuredDimensions,
  toolDraftOps,
  type ToolInterface,
  toolInterfaceFromHolding,
} from '@hsw-editor/compat';
import type { ModelRef, Wall, WallItem } from '@hsw-editor/core';

/** The part of a library entry (`ToolSummary` of `GET /api/tools`) the agent tools read. */
export interface LibraryToolSummary {
  readonly id: string;
  readonly name: { readonly en?: string; readonly ru?: string };
  readonly classId: string | null;
  readonly bankClass: string | null;
  readonly tags: readonly string[];
  readonly dimsMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly holdingDims: Readonly<Record<string, number>>;
}

export interface LibraryToolFilter {
  readonly text?: string | undefined;
  readonly tag?: string | undefined;
  readonly classId?: string | undefined;
}

/** `ё` reads as `е`, case does not matter: the same folding the Tools panel search uses. */
function fold(value: string): string {
  return value.toLowerCase().replaceAll('ё', 'е').trim();
}

/** A filter value the model left blank means "no filter", not "equals the empty string". */
function filterValue(value: string | undefined): string | undefined {
  const folded = value === undefined ? '' : fold(value);
  return folded === '' ? undefined : folded;
}

/** Display name of a library tool: English, else Russian, else the id (a cleared name is an empty string). */
export function libraryToolLabel(tool: Pick<LibraryToolSummary, 'id' | 'name'>): string {
  return tool.name.en || tool.name.ru || tool.id;
}

/**
 * Library tools matching every given filter. `text`: every word occurs in the name (either language), id, class or a
 * tag; `tag`: the tool carries that tag; `classId`: the generator class or the bank class equals it. A blank filter
 * is ignored.
 */
export function filterLibraryTools(
  tools: readonly LibraryToolSummary[],
  filter: LibraryToolFilter,
): LibraryToolSummary[] {
  const words = (filterValue(filter.text) ?? '').split(/\s+/).filter(Boolean);
  const tag = filterValue(filter.tag);
  const classId = filterValue(filter.classId);
  return tools.filter((tool) => {
    if (tag !== undefined && !tool.tags.some((candidate) => fold(candidate) === tag)) return false;
    if (
      classId !== undefined &&
      fold(tool.classId ?? '') !== classId &&
      fold(tool.bankClass ?? '') !== classId
    )
      return false;
    if (words.length === 0) return true;
    const haystack = fold(
      [tool.name.en, tool.name.ru, tool.id, tool.classId, tool.bankClass, ...tool.tags]
        .filter((part): part is string => part !== undefined && part !== null)
        .join(' '),
    );
    return words.every((word) => haystack.includes(word));
  });
}

/** Every tag of the library with the number of tools carrying it, most used first. */
export function tagCounts(
  tools: readonly Pick<LibraryToolSummary, 'tags'>[],
): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const tool of tools)
    for (const tag of tool.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
}

/** The slice of `GET /api/tools/:id` that names the tool and its box. */
export interface LibraryToolRecord {
  readonly id: string;
  readonly name: LibraryToolSummary['name'];
  readonly dimensionsMm: {
    readonly length: number;
    readonly width: number;
    readonly thickness: number;
  };
}

/** `GET /api/tools/:id/holding`. */
export interface LibraryToolHolding {
  readonly holding: HoldingMeasure;
  readonly bankClass: string | null;
}

export interface LibraryToolDraft {
  readonly model: ModelRef;
  readonly item: WallItem;
  /** What the compatibility maths reads of the tool. */
  readonly toolInterface: ToolInterface;
}

/**
 * The model reference (`source.by = tool:<id>`, how the editor and the physics find the library tool again) and the
 * tool item the Tools panel creates for a library tool (`toolDraftOps`), not yet placed: `params` carry the measured
 * holding dimensions, like the panel's `payloadOf`. The item is the agent's.
 */
export function libraryToolDraft(
  tool: LibraryToolRecord,
  holding: HoldingMeasure,
  bankClass: string,
  label: string,
): LibraryToolDraft {
  const box = {
    x: tool.dimensionsMm.width,
    y: tool.dimensionsMm.length,
    z: tool.dimensionsMm.thickness,
  };
  const params = measuredDimensions(holding.dims);
  const { item: drafted, model } = toolDraftOps(bankClass, label, { x: 0, y: 0 }, box, {
    params,
    customToolId: tool.id,
  });
  const item: WallItem = { ...drafted, source: { type: 'agent', by: 'omp' } };
  return {
    model,
    item,
    toolInterface: toolInterfaceFromHolding(
      bankClass,
      broaderToolClasses(bankClass),
      holding,
      params,
    ),
  };
}

/**
 * Why a holder was not chosen, for the agent: the blocking reason codes of `compatibility()` and the slot count left.
 * A type, not an interface, so it is assignable to a JSON value.
 */
export type HolderVerdict = {
  holderId: string;
  bankId?: string;
  fits: boolean;
  freeSlots: number;
  reasons: string[];
};

export type MountPick =
  | { readonly ok: true; readonly holderId: string }
  | { readonly ok: false; readonly message: string; readonly verdicts: HolderVerdict[] };

/** The reason of the verdict of a holder whose bank element could not be fetched: what it takes is unknown. */
export const BANK_ELEMENT_UNAVAILABLE = 'bank element unavailable';

/**
 * The holder a tool hangs on: the one asked for, else the best fit among the wall's holders that take it and have a
 * free slot (highest score; the first on the wall on a tie). A refusal carries one verdict per holder considered,
 * including holders whose bank element could not be fetched (`evaluations` hold only the ones it could).
 */
export function pickMount(
  wall: Wall,
  evaluations: readonly HolderEvaluation[],
  want: { readonly holderId?: string | undefined; readonly slot?: number | undefined },
): MountPick {
  const { holderId, slot } = want;
  const bankOf = new Map(wall.items.map((item) => [item.id, item.bankId]));
  const considered =
    holderId === undefined ? evaluations : evaluations.filter((e) => e.holderId === holderId);
  const verdicts: HolderVerdict[] = considered.map((evaluation) => {
    const bankId = bankOf.get(evaluation.holderId);
    return {
      holderId: evaluation.holderId,
      ...(bankId !== undefined ? { bankId } : {}),
      fits: evaluation.compat.ok,
      freeSlots: evaluation.freeSlots.length,
      reasons: evaluation.compat.reasons.map((reason) => reason.code),
    };
  });
  // A holder the bank could not describe is not an evaluation, but it is a holder the agent should hear about.
  const evaluated = new Set(evaluations.map((e) => e.holderId));
  for (const item of wall.items) {
    if (item.kind !== 'holder' || evaluated.has(item.id)) continue;
    if (holderId !== undefined && item.id !== holderId) continue;
    verdicts.push({
      holderId: item.id,
      ...(item.bankId !== undefined ? { bankId: item.bankId } : {}),
      fits: false,
      freeSlots: 0,
      reasons: [BANK_ELEMENT_UNAVAILABLE],
    });
  }
  if (holderId !== undefined && considered.length === 0) {
    const item = wall.items.find((candidate) => candidate.id === holderId);
    const why =
      item === undefined
        ? 'the wall has no such item'
        : item.kind !== 'holder'
          ? `it is a ${item.kind}, not a holder`
          : 'its bank element is not available, so what it takes is unknown';
    return {
      ok: false,
      message: `${holderId} cannot take a tool: ${why} (wall_get lists the holders; add one with wall_apply first).`,
      verdicts,
    };
  }
  let best: HolderEvaluation | undefined;
  for (const evaluation of considered) {
    if (!evaluation.compat.ok) continue;
    if (!evaluation.freeSlots.some((free) => slot === undefined || free.slot.index === slot))
      continue;
    if (best === undefined || evaluation.compat.score > best.compat.score) best = evaluation;
  }
  if (best !== undefined) return { ok: true, holderId: best.holderId };
  const asked = holderId === undefined ? undefined : considered[0];
  if (asked !== undefined && asked.compat.ok && slot !== undefined) {
    // The holder takes the tool; the slot asked for is the problem: say whose it is and which slots are free.
    const occupants = wall.items
      .filter((item) => item.kind === 'tool' && item.parentId === holderId && item.slot === slot)
      .map((item) => item.label ?? item.id);
    const free = asked.freeSlots.map((candidate) => candidate.slot.index);
    const freeText = free.length === 0 ? 'none free' : `free slots: ${free.join(', ')}`;
    const why =
      occupants.length > 0
        ? `slot ${slot} of holder ${holderId} is taken by ${occupants.join(', ')}`
        : `holder ${holderId} has no slot ${slot}`;
    return {
      ok: false,
      message: `Holder ${holderId} takes this tool, but ${why} (${freeText}). Ask for one of the free slots or leave slot out.`,
      verdicts,
    };
  }
  return {
    ok: false,
    message:
      holderId === undefined
        ? 'No holder on the wall takes this tool with a free slot. Add a suitable holder (wall_bank_search with toolClass and category holders, then wall_apply addItem) and call again.'
        : `Holder ${holderId} does not take this tool${slot === undefined ? ' (or has no free slot)' : ` in slot ${slot}`}: see verdicts; pick another holder or a different bank element.`,
    verdicts,
  };
}

/** The attach context of `@hsw-editor/compat` for a wall whose holder specs were fetched and one library tool draft. */
export function attachContextFor(
  wall: Wall,
  holderSpecs: ReadonlyMap<string, HolderSpec>,
  draft: LibraryToolDraft,
): AttachContext {
  return {
    wall,
    holderSpec: (item) => (item.bankId === undefined ? undefined : holderSpecs.get(item.bankId)),
    toolInterface: (item) => (item.id === draft.item.id ? draft.toolInterface : undefined),
  };
}
