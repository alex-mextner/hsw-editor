/**
 * Photo mode state of the editor: which wall photo is the viewport backdrop and how it is shown. Transient
 * (never persisted, never an op): the photo itself and its calibration live in the wall.
 */
import { createValueStore } from '#state-backend';

export interface PhotoModeState {
  /** The wall photo shown behind the board; null = photo mode is off. */
  readonly photoId: string | null;
  /** The calibration wizard replaces the 3D view until the photo is calibrated (or the user leaves it). */
  readonly calibrating: boolean;
  /** Opacity of the photo laid over the board, 0..1. */
  readonly overlayOpacity: number;
}

export const DEFAULT_OVERLAY_OPACITY = 0.5;

const INITIAL: PhotoModeState = {
  photoId: null,
  calibrating: false,
  overlayOpacity: DEFAULT_OVERLAY_OPACITY,
};

export const photoStore = createValueStore<PhotoModeState>(INITIAL);

function patchPhoto(patch: Partial<PhotoModeState>): void {
  photoStore.set({ ...photoStore.get(), ...patch });
}

/** Photo mode on for `photoId`; an uncalibrated photo opens the wizard straight away. */
export function enterPhotoMode(photoId: string, options: { readonly calibrated: boolean }): void {
  patchPhoto({ photoId, calibrating: !options.calibrated });
}

export function leavePhotoMode(): void {
  patchPhoto({ photoId: null, calibrating: false });
}

export function startCalibration(photoId: string): void {
  patchPhoto({ photoId, calibrating: true });
}

export function finishCalibration(): void {
  patchPhoto({ calibrating: false });
}

export function setOverlayOpacity(value: number): void {
  patchPhoto({ overlayOpacity: Math.min(1, Math.max(0, value)) });
}
