/**
 * Photo mode state of the editor: which wall photo is the viewport backdrop and how it is shown. Transient
 * (never persisted, never an op): the photo itself and its calibration live in the wall.
 */
import { createValueStore } from '#state-backend';
import type { Calibration } from '@hsw-editor/core';

export type AlignMode = 'move' | 'roll';

/** How the web is outlined over the photo: from the wall's brightness (`auto`), or forced on / off. */
export type WebContrastMode = 'auto' | 'on' | 'off';
const NEXT_WEB_CONTRAST: Readonly<Record<WebContrastMode, WebContrastMode>> = {
  auto: 'on',
  on: 'off',
  off: 'auto',
};

export function nextWebContrastMode(mode: WebContrastMode): WebContrastMode {
  return NEXT_WEB_CONTRAST[mode];
}

export interface PhotoModeState {
  /** The wall photo shown behind the board; null = photo mode is off. */
  readonly photoId: string | null;
  /** The calibration wizard replaces the 3D view until the photo is calibrated (or the user leaves it). */
  readonly calibrating: boolean;
  /** How strongly the HSW overlay (board, grid, items) covers the photo, 0..1. */
  readonly overlayOpacity: number;
  /** The photo is hidden: the overlay is drawn on the plain viewport background. */
  readonly photoHidden: boolean;
  /** Before/after divider as a fraction of the stage width (left of it: the bare photo); null = off. */
  readonly split: number | null;
  /** Dragging (`move`) or turning (`roll`) the board over the photo is on. */
  readonly align: AlignMode | null;
  /** Outline and shading of the white web so it shows on a white wall: auto from the photo, or forced on / off. */
  readonly webContrast: WebContrastMode;
  /** Show the cleaned variant of the photo (the wall without the old board) when there is one. */
  readonly showCleaned: boolean;
  /** The calibration while a board drag is in progress; committed as one `setCalibration` on release. */
  readonly draft: Calibration | null;
}

export const DEFAULT_OVERLAY_OPACITY = 0.9;

const INITIAL: PhotoModeState = {
  photoId: null,
  calibrating: false,
  overlayOpacity: DEFAULT_OVERLAY_OPACITY,
  photoHidden: false,
  split: null,
  align: null,
  webContrast: 'auto',
  showCleaned: true,
  draft: null,
};

export const photoStore = createValueStore<PhotoModeState>(INITIAL);

export function patchPhoto(patch: Partial<PhotoModeState>): void {
  photoStore.set({ ...photoStore.get(), ...patch });
}

/** Photo mode on for `photoId`; an uncalibrated photo opens the wizard straight away. */
export function enterPhotoMode(photoId: string, options: { readonly calibrated: boolean }): void {
  patchPhoto({
    photoId,
    calibrating: !options.calibrated,
    photoHidden: false,
    split: null,
    align: null,
    draft: null,
  });
}

export function leavePhotoMode(): void {
  patchPhoto({ photoId: null, calibrating: false, split: null, align: null, draft: null });
}

/**
 * Opens the wizard on `photoId`. From another photo, or from photo mode off, photo mode is entered the usual way
 * (clearing a stale "photo hidden" and the divider); on the shown photo only the wizard opens.
 */
export function startCalibration(photoId: string): void {
  if (photoStore.get().photoId !== photoId) {
    enterPhotoMode(photoId, { calibrated: false });
    return;
  }
  patchPhoto({ calibrating: true, align: null, draft: null });
}

export function finishCalibration(): void {
  patchPhoto({ calibrating: false });
}

export function setOverlayOpacity(value: number): void {
  patchPhoto({ overlayOpacity: Math.min(1, Math.max(0, value)) });
}

export function togglePhotoHidden(): void {
  patchPhoto({ photoHidden: !photoStore.get().photoHidden });
}

/** Before/after divider on (centred) or off. */
export function toggleSplit(): void {
  patchPhoto({ split: photoStore.get().split === null ? 0.5 : null });
}

export function setSplit(value: number): void {
  patchPhoto({ split: Math.min(1, Math.max(0, value)) });
}

/** Turns board dragging on, or off when it already is on in that mode. */
export function toggleAlign(mode: AlignMode): void {
  const { align } = photoStore.get();
  patchPhoto({ align: align === mode ? null : mode, draft: null });
}

/** Cycles the web outline auto -> on -> off. */
export function cycleWebContrast(): void {
  patchPhoto({ webContrast: nextWebContrastMode(photoStore.get().webContrast) });
}

/** Cleaned / original background. */
export function toggleShowCleaned(): void {
  patchPhoto({ showCleaned: !photoStore.get().showCleaned });
}
