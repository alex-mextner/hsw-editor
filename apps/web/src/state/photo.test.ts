import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_OVERLAY_OPACITY,
  enterPhotoMode,
  finishCalibration,
  leavePhotoMode,
  photoStore,
  setOverlayOpacity,
  startCalibration,
} from './photo.ts';

beforeEach(() => leavePhotoMode());

describe('photo mode state', () => {
  test('an uncalibrated photo opens the wizard, a calibrated one the view', () => {
    enterPhotoMode('p1', { calibrated: false });
    expect(photoStore.get()).toMatchObject({ photoId: 'p1', calibrating: true });
    finishCalibration();
    expect(photoStore.get().calibrating).toBe(false);
    enterPhotoMode('p2', { calibrated: true });
    expect(photoStore.get()).toMatchObject({ photoId: 'p2', calibrating: false });
  });

  test('recalibrating keeps the photo and reopens the wizard', () => {
    enterPhotoMode('p1', { calibrated: true });
    startCalibration('p1');
    expect(photoStore.get().calibrating).toBe(true);
  });

  test('leaving clears the photo and the wizard', () => {
    enterPhotoMode('p1', { calibrated: false });
    leavePhotoMode();
    expect(photoStore.get()).toMatchObject({ photoId: null, calibrating: false });
  });

  test('opacity is clamped to 0..1', () => {
    expect(photoStore.get().overlayOpacity).toBe(DEFAULT_OVERLAY_OPACITY);
    setOverlayOpacity(3);
    expect(photoStore.get().overlayOpacity).toBe(1);
    setOverlayOpacity(-1);
    expect(photoStore.get().overlayOpacity).toBe(0);
  });
});
