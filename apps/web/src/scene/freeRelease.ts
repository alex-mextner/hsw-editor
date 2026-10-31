/**
 * A tool let go with nothing to hang it on. It hovers where it was released while the physics decides; when nothing holds it
 * it falls to the floor (one undo step with the release), otherwise it stays. The floor is lit for the whole time
 * (`fallingStore`, `FloorPlane`).
 */
import { releaseFreeTool } from '@/physics/postStep.ts';
import type { FreeRelease, ReleaseOutcome } from '@/physics/fall.ts';
import type { PreviewPose } from '@/state/editor.ts';
import { fallTo, holdInAir, releaseHold } from './fallAnimation.ts';

type FullPose = Required<PreviewPose>;

/** Submits `release` and plays the fall when the tool falls; `from` is the pose it is shown at until then. */
export async function letGoFree(release: FreeRelease, from: FullPose): Promise<ReleaseOutcome> {
  const hold = holdInAir(release.toolId, from, release.draft);
  const outcome = await releaseFreeTool(release);
  if (outcome.kind === 'fell') fallTo(hold, from, outcome.to, outcome.dropMm);
  else releaseHold(hold);
  return outcome;
}
