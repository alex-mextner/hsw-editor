/**
 * Wall actions of the Tool Library: click-to-add and drag-to-wall. Both hand a `ToolDragPayload` (the contract of
 * `scene/toolDrop.ts`) to the same code the wall uses for tools it already holds, so a library tool hangs, is
 * refused and is filtered in the bank exactly like any other tool.
 */
import { beginToolDrag, endToolDrag, type ToolDragPayload } from '@/scene/toolDrop.ts';
import { addToolFromPayload, type AddToolFailure, type AddToolResult } from '@/wall/actions.ts';
import type { Locale } from '@/i18n/index.ts';
import { measuredDimensions } from '@hsw-editor/compat';
import { buildEntries, entryName, type LibraryEntry } from './model.ts';
import { libraryStore } from './store.ts';

/** Class id of a tool that no built-in class describes (a generic loft of a photo): it has no matching holders. */
export const GENERIC_TOOL_CLASS = 'generic';

export function payloadOf(entry: LibraryEntry, locale: Locale): ToolDragPayload {
  return {
    toolClass: entry.bankClass ?? GENERIC_TOOL_CLASS,
    label: entryName(entry, locale),
    dimsMm: entry.dimsMm,
    params: measuredDimensions(entry.holdingDims),
    ...(entry.kind === 'tool' ? { customToolId: entry.id } : { generatorClass: entry.id }),
  };
}

/** Message key (Tools panel notice) per reason a tool was not added. */
export const ADD_FAILURE_KEY = {
  noWall: 'toolLib.notice.noWall',
  bankNotReady: 'toolLib.notice.bankNotReady',
  noRoom: 'toolLib.notice.noRoom',
  failed: 'toolLib.notice.failed',
} as const satisfies Record<AddToolFailure, string>;

/** Hangs the tool on the nearest free compatible holder, else puts it on a clear spot of the board, and selects it. */
export function addLibraryTool(entry: LibraryEntry, locale: Locale): AddToolResult {
  return addToolFromPayload(payloadOf(entry, locale));
}

export function beginLibraryDrag(
  event: { readonly dataTransfer: DataTransfer | null },
  entry: LibraryEntry,
  locale: Locale,
): void {
  beginToolDrag(event, payloadOf(entry, locale));
}

export const endLibraryDrag = endToolDrag;

/** What `tools.add` reports: the wall's result, or that the library has not loaded or has no such tool. */
export type AddLibraryToolResult =
  | AddToolResult
  | { readonly ok: false; readonly reason: 'libraryNotReady' | 'unknownTool' };

/** Adds a library tool by entry key (`class:<id>`, `tool:<id>`) or by bare id (class first); the result says why not. */
export function addLibraryToolById(id: string, locale: Locale): AddLibraryToolResult {
  const library = libraryStore.get();
  if (library.status !== 'ready') return { ok: false, reason: 'libraryNotReady' };
  const entries = buildEntries(library.classes, library.tools);
  const entry =
    entries.find((candidate) => candidate.key === id) ??
    entries.find((candidate) => candidate.kind === 'class' && candidate.id === id) ??
    entries.find((candidate) => candidate.id === id);
  if (entry === undefined) return { ok: false, reason: 'unknownTool' };
  return addLibraryTool(entry, locale);
}
