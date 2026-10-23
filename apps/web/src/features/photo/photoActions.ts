/** Photo mode entry points shared by the top bar, toolbar, inspector, empty-wall hints and the command registry. */
import type { Photo } from '@hsw-editor/core';
import { sessionStore } from '@/wall/session.ts';
import { choosePhotoFile } from './photoImport.ts';
import { enterPhotoMode, leavePhotoMode, photoStore } from '@/state/photo.ts';

/** Opens photo mode on `photo`; a photo without a calibration starts in the wizard. */
export function showPhoto(photo: Photo): void {
  enterPhotoMode(photo.id, { calibrated: photo.calibration !== undefined });
}

/** Photo mode on/off. With no photo on the wall yet, "on" asks for one. */
export function togglePhotoMode(): void {
  if (photoStore.get().photoId !== null) {
    leavePhotoMode();
    return;
  }
  const first = sessionStore.get()?.wall?.photos[0];
  if (first) showPhoto(first);
  else choosePhotoFile();
}
