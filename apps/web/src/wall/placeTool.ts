/**
 * Adds a tool at a wall point the way dropping it there would: on a compatible mount of a holder under the point
 * when there is one, else free; a free tool then gets the best compatible holder from the bank next to it.
 */
import { planAddHung } from '@hsw-editor/compat';
import type { BankElement } from '@hsw-editor/bank';
import { applyOp, OpError, type LeafOp, type Wall } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { suggestHolders } from '@/bank/holderSuggestions.ts';
import { setSelection } from '@/state/editor.ts';
import { addHolderForTool, currentWall } from './actions.ts';
import { planToolDrag } from './attach.ts';
import { sessionStore, submitOps } from './session.ts';
import { toolInterfaceOf } from './toolInterface.ts';
import { toolDraftOps, type Dims3 } from './toolPresets.ts';

export interface PlaceToolRequest {
  readonly toolClass: string;
  readonly label: string;
  readonly dimsMm: Dims3;
  /** Where the tool's butt goes (the origin of its frame: +Y runs along it, towards the tip). */
  readonly at: { readonly x: number; readonly y: number };
  /** Turn about the butt, degrees; 0 = tip up. */
  readonly rotZ?: number;
}

/**
 * - `hung`: on a mount of a holder already on the wall.
 * - `holder-added`: a new bank holder was put next to the tool and the tool hangs on it.
 * - `free`: the tool is on the wall but no holder takes it (none suits, or there is no room).
 * - `no-wall`: no wall is open; nothing was added.
 * - `bank-not-ready`: the bank is still loading; nothing was added.
 * - `refused`: the wall refused the ops (a spot off the board, a locked item); nothing was added.
 */
export type PlaceToolResult =
  | 'hung'
  | 'holder-added'
  | 'free'
  | 'no-wall'
  | 'bank-not-ready'
  | 'refused';

/** Puts a new bank holder next to the tool and hangs the tool on it; the first suggestion that fits wins. */
function hangOnSuggestedHolder(toolId: string, elements: readonly BankElement[]): boolean {
  const wall = currentWall();
  const tool = wall?.items.find((candidate) => candidate.id === toolId);
  if (!wall || !tool) return false;
  const toolInterface = toolInterfaceOf(tool, wall);
  if (!toolInterface) return false;
  for (const suggestion of suggestHolders(toolInterface, elements)) {
    if (addHolderForTool(tool, suggestion.element) === 'ok') return true;
  }
  return false;
}

export function placeToolAt(request: PlaceToolRequest): PlaceToolResult {
  const wall = sessionStore.get()?.wall;
  const bank = bankStore.get();
  if (!wall) return 'no-wall';
  if (bank.status !== 'ready') return 'bank-not-ready';
  const { item, ops } = toolDraftOps(request.toolClass, request.label, request.at, request.dimsMm, {
    ...(request.rotZ === undefined ? {} : { rotZ: request.rotZ }),
  });
  const setup: readonly LeafOp[] = ops.filter((op) => op.type === 'addModelRef');
  const add: LeafOp = { type: 'addItem', item };
  let virtual: Wall;
  try {
    virtual = applyOp(wall, { type: 'batch', ops: [...setup, add] }).wall;
  } catch (error) {
    if (error instanceof OpError) return 'refused';
    throw error;
  }
  const { resolution } = planToolDrag(virtual, bank.byId, item, request.at, { x: 0, y: 0 }, false);
  // Dropped there by hand, a spot inside a holder that cannot take the tool is refused: so is accepting a ghost.
  if (resolution.kind === 'refuse') return 'refused';
  const attach = resolution.kind === 'attach';
  const placed = attach ? planAddHung(item, resolution.target) : add;
  if (!submitOps([...setup, placed], attach ? 'add-and-hang' : 'add-tool').ok) return 'refused';
  setSelection([item.id]);
  if (attach) return 'hung';
  return hangOnSuggestedHolder(item.id, bank.index.elements) ? 'holder-added' : 'free';
}
