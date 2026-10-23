/**
 * Short ease-out glide of one item from where it was released to where the edit put it (a tool snapping onto
 * its mount, or returning after a refused drop). The wall already holds the final pose; the animation only
 * overrides the preview pose in `editorStore.dragging` for a moment and then clears it.
 */
import { patchEditor, type PreviewPose } from '@/state/editor.ts';

export const SNAP_DURATION_MS = 180;

type FullPose = Required<PreviewPose>;

/** Bumped by every new glide and every cancel; a running frame loop stops when its generation is stale. */
let generation = 0;
let gliding = false;

/** Stops a running glide and drops its preview pose (a new drag takes over the preview). */
export function cancelSnap(): void {
  generation += 1;
  if (gliding) {
    gliding = false;
    patchEditor({ dragging: new Map(), dragValid: true });
  }
}

function lerpAngle(from: number, to: number, t: number): number {
  const delta = ((((to - from) % 360) + 540) % 360) - 180;
  return from + delta * t;
}

function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function glideTo(id: string, from: FullPose, to: FullPose): void {
  cancelSnap();
  const token = generation;
  const raf = globalThis.requestAnimationFrame;
  if (raf === undefined || reducedMotion()) {
    patchEditor({ dragging: new Map(), dragValid: true });
    return;
  }
  const startedAt = performance.now();
  const step = (now: number): void => {
    if (token !== generation) return;
    // The first frame's timestamp can precede `startedAt` by a few ms.
    const t = Math.min(1, Math.max(0, (now - startedAt) / SNAP_DURATION_MS));
    if (t >= 1) {
      gliding = false;
      patchEditor({ dragging: new Map(), dragValid: true });
      return;
    }
    const eased = 1 - (1 - t) ** 3;
    const pose: FullPose = {
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      z: from.z + (to.z - from.z) * eased,
      rotX: lerpAngle(from.rotX, to.rotX, eased),
      rotY: lerpAngle(from.rotY, to.rotY, eased),
      rotZ: lerpAngle(from.rotZ, to.rotZ, eased),
    };
    patchEditor({ dragging: new Map([[id, pose]]), dragValid: true });
    raf(step);
  };
  gliding = true;
  patchEditor({ dragging: new Map([[id, from]]), dragValid: true });
  raf(step);
}
