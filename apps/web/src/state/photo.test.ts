import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_OVERLAY_OPACITY,
  enterPhotoMode,
  finishCalibration,
  leavePhotoMode,
  nextWebContrastMode,
  patchPhoto,
  photoStore,
  setOverlayOpacity,
  setSplit,
  splitAtPointer,
  startCalibration,
  toggleAlign,
  toggleSplit,
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

  test('recalibrating keeps the photo, reopens the wizard and drops a board drag', () => {
    enterPhotoMode('p1', { calibrated: true });
    toggleAlign('move');
    startCalibration('p1');
    expect(photoStore.get()).toMatchObject({ calibrating: true, align: null, draft: null });
  });

  test('leaving clears the photo, the wizard, the divider and the board drag', () => {
    enterPhotoMode('p1', { calibrated: false });
    toggleSplit();
    toggleAlign('roll');
    leavePhotoMode();
    expect(photoStore.get()).toMatchObject({
      photoId: null,
      calibrating: false,
      split: null,
      align: null,
    });
  });

  test('opacity and divider are clamped to 0..1', () => {
    expect(photoStore.get().overlayOpacity).toBe(DEFAULT_OVERLAY_OPACITY);
    setOverlayOpacity(3);
    expect(photoStore.get().overlayOpacity).toBe(1);
    setOverlayOpacity(-1);
    expect(photoStore.get().overlayOpacity).toBe(0);
    setSplit(1.5);
    expect(photoStore.get().split).toBe(1);
  });

  test('a pointer over the photo box puts the divider under the pointer, clamped to the box', () => {
    const box = { left: 100, width: 400 };
    expect(splitAtPointer(300, box)).toBe(0.5);
    expect(splitAtPointer(100, box)).toBe(0);
    expect(splitAtPointer(40, box)).toBe(0);
    expect(splitAtPointer(900, box)).toBe(1);
    expect(splitAtPointer(200, { left: 0, width: 0 })).toBe(0.5);
  });

  test('the divider toggles on at the centre and off again', () => {
    toggleSplit();
    expect(photoStore.get().split).toBe(0.5);
    toggleSplit();
    expect(photoStore.get().split).toBeNull();
  });

  test('board drag modes switch and toggle off, discarding any draft', () => {
    toggleAlign('move');
    expect(photoStore.get().align).toBe('move');
    patchPhoto({ draft: { method: 'two-point', mmPerPx: 1 } });
    toggleAlign('roll');
    expect(photoStore.get()).toMatchObject({ align: 'roll', draft: null });
    toggleAlign('roll');
    expect(photoStore.get().align).toBeNull();
  });
});

describe('nextWebContrastMode', () => {
  test('cycles auto -> on -> off -> auto', () => {
    expect(nextWebContrastMode('auto')).toBe('on');
    expect(nextWebContrastMode('on')).toBe('off');
    expect(nextWebContrastMode('off')).toBe('auto');
  });
});
