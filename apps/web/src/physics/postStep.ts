/**
 * The calls the hang code paths make once a tool is hung (synchronously, from the compatibility pose): the physics
 * seats it afterwards, off the render thread, as one more undo step. Fire and forget: both resolve to a status the
 * callers do not need, and neither throws.
 */
import { liveFallDeps, livePostStepDeps } from './context.ts';
import { type FreeRelease, releaseFree, type ReleaseOutcome } from './fall.ts';
import { seatAfterHang } from './seat.ts';
import { settleAfterDrop } from './suggest.ts';

/** A tool was dropped at the wall point `at` and hangs on the nearest holder: seat it, or move it to a clearly better holder in reach. */
export function seatAfterDrop(
  toolId: string,
  at: { readonly x: number; readonly y: number },
): void {
  void settleAfterDrop(toolId, at, livePostStepDeps());
}

/** A tool was hung on a holder the user chose (a suggested holder, a new holder for the tool): seat it in that holder. */
export function seatAfterChosenHang(toolId: string): void {
  void seatAfterHang(toolId, livePostStepDeps());
}

/**
 * A tool was let go with no mount (free drag release, free drop from the Tools panel): submits the ops that put it there,
 * together with its fall to the floor when nothing holds it. Never throws; resolves once the ops are in the wall.
 */
export function releaseFreeTool(release: FreeRelease): Promise<ReleaseOutcome> {
  return releaseFree(release, liveFallDeps());
}
