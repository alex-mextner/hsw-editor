/** Photo mode entry points shared by the top bar, toolbar, inspector, empty-wall hints and the command registry. */
import type { Photo, Wall } from '@hsw-editor/core';
import { api } from '@/api/http.ts';
import { notify } from '@/features/notices/notices.ts';
import { t } from '@/i18n/index.ts';
import { sessionStore } from '@/wall/session.ts';
import { autoCleanStore, forgetAsked, planClean, runClean } from './cleanBackground.ts';
import { findToolsStore, runFindTools } from './findTools.ts';
import { exportComposite, exportFileName } from './photoExport.ts';
import { choosePhotoFile } from './photoImport.ts';
import {
  enterPhotoMode,
  leavePhotoMode,
  photoStore,
  startCalibration,
  togglePhotoHidden,
  toggleSplit,
} from '@/state/photo.ts';

/** True when the photo's calibration comes from the grid detector, i.e. the board sits on the real lattice. */
export function isGridCalibrated(wall: Wall | null | undefined, photoId: string | null): boolean {
  return wall?.photos.find((entry) => entry.id === photoId)?.calibration?.method === 'grid';
}

/** Opens photo mode on `photo`; a photo without a calibration starts in the wizard. */
export function showPhoto(photo: Photo): void {
  enterPhotoMode(photo.id, { calibrated: photo.calibration !== undefined });
}

/** The wall's first original photo (a cleaned variant is not a photo of its own); what photo commands act on when none is shown. */
export function firstPhoto(wall: Wall | null | undefined): Photo | undefined {
  return wall?.photos.find((photo) => photo.cleanOf === undefined);
}

/** Photo mode on/off. With no photo on the wall yet, "on" asks for one. */
export function togglePhotoMode(): void {
  if (photoStore.get().photoId !== null) {
    leavePhotoMode();
    return;
  }
  const first = firstPhoto(sessionStore.get()?.wall);
  if (first) showPhoto(first);
  else choosePhotoFile();
}

function shownPhoto(): {
  readonly wallId: string;
  readonly wallName: string;
  readonly photo: Photo;
  /** Its cleaned variant, when one has been made. */
  readonly variant: Photo | null;
} | null {
  const session = sessionStore.get();
  const { photoId } = photoStore.get();
  const wall = session?.wall;
  const photo = wall?.photos.find((entry) => entry.id === photoId);
  return wall && photo
    ? {
        wallId: wall.id,
        wallName: wall.name,
        photo,
        variant: wall.photos.find((entry) => entry.cleanOf === photo.id) ?? null,
      }
    : null;
}

/** Downloads the photo with the HSW overlay and the banner as one PNG. */
export async function exportPhotoPng(): Promise<void> {
  const shown = shownPhoto();
  if (!shown || photoStore.get().calibrating) return;
  try {
    const { overlayOpacity, photoHidden, showCleaned } = photoStore.get();
    // The cleaned wall is what the layout is meant to hang on; the picture shows what the viewport shows.
    const variant = shown.variant !== null && showCleaned ? shown.variant : shown.photo;
    const blob = await exportComposite({
      photoUrl: api.photoUrl(shown.wallId, variant.id),
      image: { width: shown.photo.width, height: shown.photo.height },
      overlayOpacity,
      photoHidden,
      banner: { title: t('photo.export.bannerTitle'), subtitle: t('photo.export.bannerSubtitle') },
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = exportFileName(shown.wallName);
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } catch (error) {
    notify(
      'error',
      t('photo.export.failed', { reason: error instanceof Error ? error.message : String(error) }),
    );
  }
}

/** Runs the vision tool search for the shown photo and reports its outcome. */
export async function findPhotoTools(): Promise<void> {
  const shown = shownPhoto();
  if (!shown) return;
  await runFindTools(shown.wallId, shown.photo.id);
  const state = findToolsStore.get();
  switch (state.phase) {
    case 'done':
      notify(
        'info',
        state.found > 0
          ? t('photo.findTools.done', { count: state.found })
          : t('photo.findTools.none'),
      );
      break;
    case 'unavailable':
      notify('info', t('photo.findTools.unavailable'));
      break;
    case 'failed':
      notify('error', t('photo.findTools.failed', { message: state.message ?? '' }));
      break;
    default:
      break;
  }
}

/** Recalibrates the shown photo; with the photo hidden (photo mode off) the wall's first photo is opened for it. */
export function calibrateShownPhoto(): void {
  const target = shownPhoto()?.photo ?? firstPhoto(sessionStore.get()?.wall);
  if (target) startCalibration(target.id);
}

export { togglePhotoHidden, toggleSplit };

/** Makes the cleaned background again, also when the footprint has not moved (the AI is asked once more). */
export function cleanPhotoBackground(): void {
  const { photoId } = photoStore.get();
  const wall = sessionStore.get()?.wall;
  const plan = wall && photoId !== null ? planClean(wall, photoId) : null;
  if (!wall || photoId === null || plan === null) {
    notify('info', t('photo.clean.needsCalibration'));
    return;
  }
  forgetAsked(photoId);
  void runClean(wall.id, photoId, plan.signature, { refresh: true });
}

/** The "auto-clean background" setting on / off. */
export function toggleAutoClean(): void {
  autoCleanStore.set(!autoCleanStore.get());
}
