/**
 * The fall of a released tool, drawn as a preview pose in `editorStore.dragging` like the glide onto a mount (`snapAnimation.ts`):
 * the wall already holds the resting pose, this only plays how the tool got there. It speeds up under gravity from the release
 * pose (height fallen = g t^2 / 2, so a 0.6 m drop takes 0.35 s), turns into the lying pose while it falls and stops on the floor.
 * `fallingStore` tells the viewport that a fall is under way (waiting for the decision or playing it) so the floor stays lit.
 */
import type { WallItem } from '@hsw-editor/core';
import { createValueStore } from '#state-backend';
import { patchEditor, type PreviewPose } from '@/state/editor.ts';
import { dropPreview, ownsPreview, takePreview } from './snapAnimation.ts';

type FullPose = Required<PreviewPose>;

/** Gravity in mm/s^2. */
const GRAVITY_MM_S2 = 9810;
/** A fall is never shorter than this, so even a short drop is seen. */
const MIN_FALL_MS = 220;

/** Ids of tools in the air: released and waiting for the physics' decision, or falling. */
export const fallingStore = createValueStore<ReadonlySet<string>>(new Set());

/** Tools dropped from the library that are not on the wall yet (the physics decides where they land): drawn from here meanwhile. */
export const pendingToolsStore = createValueStore<readonly WallItem[]>([]);

function setPending(draft: WallItem, pending: boolean): void {
  const rest = pendingToolsStore.get().filter((item) => item.id !== draft.id);
  pendingToolsStore.set(pending ? [...rest, draft] : rest);
}

function setFalling(id: string, falling: boolean): void {
  const next = new Set(fallingStore.get());
  if (falling) next.add(id);
  else next.delete(id);
  fallingStore.set(next);
}

/** Milliseconds for a free fall of `dropMm`. */
export function fallDurationMs(dropMm: number): number {
  return Math.max(MIN_FALL_MS, Math.sqrt((2 * Math.max(dropMm, 0)) / GRAVITY_MM_S2) * 1000);
}

/** Pose at time `t` (0..1 of the fall): y by gravity (t^2), x and z straight, the turn done by 70% of the way down. */
export function fallPoseAt(from: FullPose, to: FullPose, t: number): FullPose {
  const turn = Math.min(1, t / 0.7);
  const eased = turn * turn * (3 - 2 * turn);
  const angle = (a: number, b: number): number =>
    a + (((((b - a) % 360) + 540) % 360) - 180) * eased;
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t * t,
    z: from.z + (to.z - from.z) * t,
    rotX: angle(from.rotX, to.rotX),
    rotY: angle(from.rotY, to.rotY),
    rotZ: angle(from.rotZ, to.rotZ),
  };
}

/** A tool held at its release pose, or falling: its owner token for `snapAnimation`'s preview. */
export interface AirHold {
  readonly id: string;
  readonly draft?: WallItem;
  readonly token: number;
}

/** Holds the tool at its release pose while the physics decides (a new drag takes the preview over). */
export function holdInAir(id: string, at: FullPose, draft?: WallItem): AirHold {
  const token = takePreview();
  setFalling(id, true);
  if (draft) setPending(draft, true);
  patchEditor({ dragging: new Map([[id, at]]), dragValid: true });
  return draft ? { id, token, draft } : { id, token };
}

/** The decision was "it stays" (or nothing could be decided): the preview is dropped, the wall pose shows. */
export function releaseHold(hold: AirHold): void {
  setFalling(hold.id, false);
  if (hold.draft) setPending(hold.draft, false);
  dropPreview(hold.token);
}

/** Plays the fall from `from` to `to` (`dropMm` of fall), then clears the preview; reduced motion lands at once. */
export function fallTo(hold: AirHold, from: FullPose, to: FullPose, dropMm: number): void {
  const raf = globalThis.requestAnimationFrame;
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (raf === undefined || reduced || !ownsPreview(hold.token)) {
    releaseHold(hold);
    return;
  }
  const duration = fallDurationMs(dropMm);
  const startedAt = performance.now();
  const step = (now: number): void => {
    // A new drag took the preview over: it is theirs, the fall is over for this tool.
    if (!ownsPreview(hold.token)) {
      setFalling(hold.id, false);
      if (hold.draft) setPending(hold.draft, false);
      return;
    }
    const t = Math.min(1, Math.max(0, (now - startedAt) / duration));
    if (t >= 1) {
      releaseHold(hold);
      return;
    }
    patchEditor({ dragging: new Map([[hold.id, fallPoseAt(from, to, t)]]), dragValid: true });
    raf(step);
  };
  patchEditor({ dragging: new Map([[hold.id, from]]), dragValid: true });
  raf(step);
}
