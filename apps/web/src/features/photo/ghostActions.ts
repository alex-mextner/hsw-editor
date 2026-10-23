/** Accepting a tool ghost: the tool joins the wall at the detected spot, on a holder when one takes it. */
import type { PhotoMap } from '@hsw-editor/overlay';
import { bankStore } from '@/bank/client.ts';
import { notify } from '@/features/notices/notices.ts';
import { localeStore, t } from '@/i18n/index.ts';
import { toolClassName } from '@/wall/attachReasons.ts';
import { placeToolAt, type PlaceToolResult } from '@/wall/placeTool.ts';
import { discardGhost, type ToolGhost } from './visionGhosts.ts';

/** What accepting a ghost came to: the placement outcomes, or that its spot is not on the wall plane. */
export type AcceptResult = PlaceToolResult | 'off-plane';

const RESULT_KEY = {
  hung: 'photo.ghost.hung',
  'holder-added': 'photo.ghost.holderAdded',
  free: 'photo.ghost.free',
  'no-wall': 'photo.ghost.failed',
  'bank-not-ready': 'photo.ghost.bankNotReady',
  refused: 'photo.ghost.failed',
  'off-plane': 'photo.ghost.failed',
} as const satisfies Record<AcceptResult, string>;

/** Name of the ghost's class in the UI language. */
export function ghostName(ghost: ToolGhost): string {
  const name = toolClassName(bankStore.get(), localeStore.get(), ghost.toolClass);
  return name === ghost.toolClass ? ghost.label : name;
}

function added(result: AcceptResult): boolean {
  return result === 'hung' || result === 'holder-added' || result === 'free';
}

/** Adds the ghost's tool and drops the ghost; the photo point is mapped through the calibration onto the wall. */
function addGhostTool(ghost: ToolGhost, name: string, map: PhotoMap): AcceptResult {
  const at = map.pxToWall([ghost.centrePx[0], ghost.centrePx[1]]);
  if (at === null) return 'off-plane';
  const result = placeToolAt({
    toolClass: ghost.toolClass,
    label: name,
    dimsMm: ghost.dimsMm,
    at: { x: at[0], y: at[1] },
  });
  if (added(result)) discardGhost(ghost.id);
  return result;
}

/** Accepts one ghost and says what happened. */
export function acceptGhost(ghost: ToolGhost, map: PhotoMap): AcceptResult {
  const name = ghostName(ghost);
  const result = addGhostTool(ghost, name, map);
  notify(added(result) ? 'info' : 'error', t(RESULT_KEY[result], { name }));
  return result;
}

/** Accepts every ghost and reports one summary. */
export function acceptAllGhosts(
  ghosts: readonly ToolGhost[],
  map: PhotoMap,
): { readonly added: number; readonly failed: number } {
  let count = 0;
  for (const ghost of ghosts) {
    if (added(addGhostTool(ghost, ghostName(ghost), map))) count += 1;
  }
  const failed = ghosts.length - count;
  notify(
    failed === 0 ? 'info' : 'error',
    t(failed === 0 ? 'photo.ghost.addedAll' : 'photo.ghost.addedSome', { count, failed }),
  );
  return { added: count, failed };
}
