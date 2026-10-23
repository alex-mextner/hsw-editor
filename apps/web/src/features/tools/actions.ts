/**
 * Wall actions of the Tool Library: click-to-add and drag-to-wall. Both hand a `ToolDragPayload` (the contract of
 * `scene/toolDrop.ts`) to the same code the wall uses for tools it already holds, so a library tool hangs, is
 * refused and is filtered in the bank exactly like any other tool.
 */
import { beginToolDrag, endToolDrag, type ToolDragPayload } from '@/scene/toolDrop.ts';
import { currentWall, addToolFromPayload } from '@/wall/actions.ts';
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

export type AddResult =
  | { readonly ok: true; readonly itemId: string }
  | { readonly ok: false; readonly reason: 'noWall' | 'failed' };

/** Puts the tool on the wall in front of the middle of the viewport and selects it. */
export function addLibraryTool(entry: LibraryEntry, locale: Locale): AddResult {
  if (!currentWall()) return { ok: false, reason: 'noWall' };
  const itemId = addToolFromPayload(payloadOf(entry, locale));
  return itemId === null ? { ok: false, reason: 'failed' } : { ok: true, itemId };
}

export function beginLibraryDrag(
  event: { readonly dataTransfer: DataTransfer | null },
  entry: LibraryEntry,
  locale: Locale,
): void {
  beginToolDrag(event, payloadOf(entry, locale));
}

export const endLibraryDrag = endToolDrag;

/** Adds a library tool by entry key (`class:<id>`, `tool:<id>`) or by bare id (class first); the new item id or null. */
export function addLibraryToolById(id: string, locale: Locale): string | null {
  const library = libraryStore.get();
  if (library.status !== 'ready') return null;
  const entries = buildEntries(library.classes, library.tools);
  const entry =
    entries.find((candidate) => candidate.key === id) ??
    entries.find((candidate) => candidate.kind === 'class' && candidate.id === id) ??
    entries.find((candidate) => candidate.id === id);
  if (entry === undefined) return null;
  const result = addLibraryTool(entry, locale);
  return result.ok ? result.itemId : null;
}
