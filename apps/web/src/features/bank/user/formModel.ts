/**
 * Form state of the "Add element" dialog and its mapping to the wire types (`UserImportInput`, `UserPatch`).
 * Pure: the rules about what is sent (untouched fields are omitted so the server keeps its detected defaults),
 * what is valid, and when an edit can be a cheap PATCH instead of a re-conversion live here and are tested.
 */
import type {
  BankElement,
  CellOffset,
  Conversion,
  ConvertSettings,
  FitsTool,
  LocalizedText,
  PrintNotes,
  UserImportInput,
  UserPatch,
} from '@hsw-editor/bank';
import { MESH_FORMATS, type MeshFormat } from '@hsw-editor/bank';
import {
  clampMounting,
  defaultMountingKind,
  mountingIssue,
  type MountingKind,
} from './cellEdit.ts';
import { ANCHOR_CELL } from './hexGrid.ts';

export const MAX_TAGS = 40;
export const MAX_TAG_LENGTH = 60;
export const MAX_NAME_LENGTH = 120;

/** One dimension range row of a `fitsTool` entry; numbers stay strings while the user types. */
export interface DimRow {
  readonly key: string;
  readonly min: string;
  readonly max: string;
}

export interface FitsEntry {
  /** Stable React key; never sent. */
  readonly uid: number;
  readonly toolClass: string;
  readonly capacity: string;
  readonly dims: readonly DimRow[];
  /** Carried through unchanged: the dialog has no editor for it, but an edit must not drop it. */
  readonly notes?: LocalizedText;
}

export interface FormState {
  readonly nameRu: string;
  readonly nameEn: string;
  readonly category: string;
  readonly tagsRu: readonly string[];
  readonly tagsEn: readonly string[];
  /** Only the settings the user chose; everything else is left to the server's detection. */
  readonly settings: ConvertSettings;
  /** `null` = untouched, the detected footprint is used. */
  readonly footprint: readonly CellOffset[] | null;
  readonly mountingKind: MountingKind | null;
  readonly mountingCells: readonly CellOffset[] | null;
  readonly fits: readonly FitsEntry[];
  /** Fields without an editor that an edit must carry along. */
  readonly description?: LocalizedText;
  readonly printNotes?: PrintNotes;
}

export const EMPTY_FORM: FormState = {
  nameRu: '',
  nameEn: '',
  category: '',
  tagsRu: [],
  tagsEn: [],
  settings: {},
  footprint: null,
  mountingKind: null,
  mountingCells: null,
  fits: [],
};

export function formFromSuggestedName(name: string, locale: 'ru' | 'en'): FormState {
  return locale === 'ru' ? { ...EMPTY_FORM, nameRu: name } : { ...EMPTY_FORM, nameEn: name };
}

let nextUid = 1;
export function newUid(): number {
  nextUid += 1;
  return nextUid;
}

function dimRowsOf(fit: FitsTool): DimRow[] {
  return Object.entries(fit.dims ?? {}).map(([key, range]) => ({
    key,
    min: String(range.min),
    max: String(range.max),
  }));
}

/** Pre-fills the form from the `input` of `POST .../elements/:id/reopen`; stored geometry counts as user-chosen. */
export function formFromInput(input: UserImportInput): FormState {
  const fits: FitsEntry[] = (input.fitsTool ?? []).map((fit) => ({
    uid: newUid(),
    toolClass: fit.toolClass,
    capacity: fit.capacity === undefined ? '' : String(fit.capacity),
    dims: dimRowsOf(fit),
    ...(fit.notes ? { notes: fit.notes } : {}),
  }));
  // Classes the element lists without a hint become hint-less entries, so the union sent back loses none.
  const hinted = new Set(fits.map((fit) => fit.toolClass));
  for (const toolClass of input.toolClasses ?? []) {
    if (!hinted.has(toolClass)) {
      fits.push({ uid: newUid(), toolClass, capacity: '', dims: [] });
    }
  }
  return {
    nameRu: input.name.ru ?? '',
    nameEn: input.name.en ?? '',
    category: input.category,
    tagsRu: input.tags?.ru ?? [],
    tagsEn: input.tags?.en ?? [],
    settings: input.settings ?? {},
    footprint: input.footprint ?? null,
    mountingKind: input.mounting?.kind ?? null,
    mountingCells: input.mounting?.cells ?? null,
    fits,
    ...(input.description ? { description: input.description } : {}),
    ...(input.printNotes ? { printNotes: input.printNotes } : {}),
  };
}

// --- settings ----------------------------------------------------------------------------------

/** Order-independent comparison of two settings objects; `undefined` fields count as absent. */
export function settingsEqual(a: ConvertSettings, b: ConvertSettings): boolean {
  return (
    a.partId === b.partId &&
    a.anchor === b.anchor &&
    a.unit === b.unit &&
    a.repair === b.repair &&
    a.orient?.out === b.orient?.out &&
    a.orient?.up === b.orient?.up
  );
}

export type SubmitMode = 'import' | 'reimport' | 'patch';

/**
 * How an edit is saved: metadata only (name, tags, category, tool hints, footprint, pegs) is a cheap PATCH; a
 * changed setting or part needs the geometry converted again, which is the import job with `replaceId`.
 */
export function editSubmitMode(initial: ConvertSettings, current: ConvertSettings): SubmitMode {
  return settingsEqual(initial, current) ? 'patch' : 'reimport';
}

// --- effective values --------------------------------------------------------------------------

export interface EffectiveGeometry {
  readonly footprint: readonly CellOffset[];
  readonly mountingKind: MountingKind;
  readonly mountingCells: readonly CellOffset[];
}

/** What the form currently stands for: the user's choice where there is one, the detection otherwise. */
export function effectiveGeometry(
  form: FormState,
  detected: Pick<Conversion, 'footprint' | 'mountingCells'> | null,
): EffectiveGeometry {
  const footprint = form.footprint ?? detected?.footprint ?? [ANCHOR_CELL];
  const mountingCells = clampMounting(
    footprint,
    form.mountingCells ?? detected?.mountingCells ?? [],
  );
  return {
    footprint,
    mountingKind: form.mountingKind ?? defaultMountingKind(form.category),
    mountingCells,
  };
}

// --- tags --------------------------------------------------------------------------------------

/** Adds the typed text (comma separated list allowed) to the tags: trimmed, case-insensitively unique, capped. */
export function addTags(tags: readonly string[], raw: string): readonly string[] {
  const next = [...tags];
  for (const part of raw.split(',')) {
    const tag = part.trim().slice(0, MAX_TAG_LENGTH);
    if (tag === '' || next.length >= MAX_TAGS) continue;
    if (!next.some((other) => other.toLowerCase() === tag.toLowerCase())) next.push(tag);
  }
  return next.length === tags.length ? tags : next;
}

export function removeTag(tags: readonly string[], tag: string): readonly string[] {
  return tags.filter((other) => other !== tag);
}

// --- fitsTool ----------------------------------------------------------------------------------

export type DimRowIssue = 'key' | 'number' | 'order' | null;

function parseMm(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** A dimension row is valid when it has a key and `min ≤ max` numbers; a fully empty row is just ignored. */
export function dimRowIssue(row: DimRow): DimRowIssue {
  const empty = row.key.trim() === '' && row.min.trim() === '' && row.max.trim() === '';
  if (empty) return null;
  if (row.key.trim() === '') return 'key';
  const min = parseMm(row.min);
  const max = parseMm(row.max);
  if (min === null || max === null) return 'number';
  return min > max ? 'order' : null;
}

export type CapacityIssue = 'capacity' | null;

export function capacityIssue(raw: string): CapacityIssue {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? null : 'capacity';
}

export function fitsEntryValid(entry: FitsEntry): boolean {
  return (
    entry.toolClass !== '' &&
    capacityIssue(entry.capacity) === null &&
    entry.dims.every((row) => dimRowIssue(row) === null)
  );
}

function fitsToolOf(entry: FitsEntry): FitsTool {
  const dims: Record<string, { min: number; max: number }> = {};
  for (const row of entry.dims) {
    if (row.key.trim() === '' || dimRowIssue(row) !== null) continue;
    const min = parseMm(row.min);
    const max = parseMm(row.max);
    if (min !== null && max !== null) dims[row.key.trim()] = { min, max };
  }
  const capacity = entry.capacity.trim() === '' ? undefined : Number(entry.capacity);
  return {
    toolClass: entry.toolClass,
    ...(Object.keys(dims).length > 0 ? { dims } : {}),
    ...(capacity === undefined ? {} : { capacity }),
    ...(entry.notes ? { notes: entry.notes } : {}),
  };
}

/** Entries as wire `fitsTool`; one entry per class (a later duplicate class is merged away by keeping the first). */
export function fitsToolsOf(entries: readonly FitsEntry[]): FitsTool[] {
  const seen = new Set<string>();
  const out: FitsTool[] = [];
  for (const entry of entries) {
    if (entry.toolClass === '' || seen.has(entry.toolClass)) continue;
    seen.add(entry.toolClass);
    out.push(fitsToolOf(entry));
  }
  return out;
}

/** Dimension keys other bank elements use for `toolClass`, most used first: the suggestions of the key field. */
export function dimKeySuggestions(
  elements: readonly Pick<BankElement, 'fitsTool'>[],
  toolClass: string,
): string[] {
  const counts = new Map<string, number>();
  for (const element of elements) {
    for (const fit of element.fitsTool) {
      if (fit.toolClass !== toolClass) continue;
      for (const key of Object.keys(fit.dims ?? {})) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);
}

// --- validation --------------------------------------------------------------------------------

export interface FormIssues {
  readonly name: boolean;
  readonly category: boolean;
  readonly mounting: boolean;
  readonly fits: boolean;
}

export function formIssues(form: FormState, geometry: EffectiveGeometry): FormIssues {
  return {
    name: form.nameRu.trim() === '' && form.nameEn.trim() === '',
    category: form.category === '',
    mounting: mountingIssue(geometry.mountingKind, geometry.mountingCells) !== null,
    fits: !form.fits.every(fitsEntryValid),
  };
}

export function hasIssues(issues: FormIssues): boolean {
  return issues.name || issues.category || issues.mounting || issues.fits;
}

// --- wire mapping ------------------------------------------------------------------------------

function nameOf(form: FormState): { ru?: string; en?: string } {
  const ru = form.nameRu.trim();
  const en = form.nameEn.trim();
  return { ...(ru === '' ? {} : { ru }), ...(en === '' ? {} : { en }) };
}

/**
 * Footprint and mounting go on the wire only when the user touched them (or the footprint, which can invalidate
 * the detected pegs): otherwise the server uses what it detected.
 */
function geometryFields(
  form: FormState,
  geometry: EffectiveGeometry,
): { footprint?: CellOffset[]; mounting?: { kind: MountingKind; cells: CellOffset[] } } {
  const touchedFootprint = form.footprint !== null;
  const touchedMounting =
    form.mountingKind !== null || form.mountingCells !== null || touchedFootprint;
  return {
    ...(touchedFootprint ? { footprint: [...geometry.footprint] } : {}),
    ...(touchedMounting
      ? { mounting: { kind: geometry.mountingKind, cells: [...geometry.mountingCells] } }
      : {}),
  };
}

function metaFields(form: FormState): {
  name: { ru?: string; en?: string };
  category: string;
  tags: { ru: string[]; en: string[] };
  toolClasses: string[];
  fitsTool: FitsTool[];
} {
  const fitsTool = fitsToolsOf(form.fits);
  return {
    name: nameOf(form),
    category: form.category,
    tags: { ru: [...form.tagsRu], en: [...form.tagsEn] },
    toolClasses: fitsTool.map((fit) => fit.toolClass),
    fitsTool,
  };
}

export interface ImportTarget {
  readonly uploadId?: string;
  readonly replaceId?: string;
}

export function toImportInput(
  form: FormState,
  geometry: EffectiveGeometry,
  target: ImportTarget,
): UserImportInput {
  return {
    ...target,
    ...(Object.keys(form.settings).length > 0 ? { settings: form.settings } : {}),
    ...metaFields(form),
    ...(form.description ? { description: form.description } : {}),
    ...(form.printNotes ? { printNotes: form.printNotes } : {}),
    ...geometryFields(form, geometry),
  };
}

/** Body of `PATCH /elements/:id`: metadata and geometry cells, never the mesh. */
export function toPatch(form: FormState, geometry: EffectiveGeometry): UserPatch {
  return {
    ...metaFields(form),
    ...(form.description ? { description: form.description } : {}),
    ...(form.printNotes ? { printNotes: form.printNotes } : {}),
    ...geometryFields(form, geometry),
  };
}

// --- files -------------------------------------------------------------------------------------

/** Mesh format by file extension; the server still sniffs the content. */
export function meshFormatOfName(filename: string): MeshFormat | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = filename.slice(dot + 1).toLowerCase();
  return MESH_FORMATS.find((format) => format === extension) ?? null;
}
