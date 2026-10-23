import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createEmptyWall, PhotoSchema, type Wall } from '@hsw-editor/core';
import { sessionStore } from '@/wall/session.ts';
import { leavePhotoMode, patchPhoto, photoStore, startCalibration } from '@/state/photo.ts';
import { calibrateShownPhoto } from './photoActions.ts';

function wallWithPhotos(count: number): Wall {
  const wall = createEmptyWall('w', 'Wall');
  const photos = Array.from({ length: count }, (_, index) =>
    PhotoSchema.parse({
      id: `p${index + 1}`,
      file: `photos/p${index + 1}.jpg`,
      mime: 'image/jpeg',
      width: 100,
      height: 80,
    }),
  );
  return { ...wall, photos };
}

function open(wall: Wall): void {
  sessionStore.set({
    wallId: wall.id,
    status: 'ready',
    wall,
    confirmedRev: 0,
    pending: 0,
    warnings: [],
    canUndo: false,
    canRedo: false,
    lastRemote: null,
    notice: null,
    conflict: null,
    errorMessage: null,
  });
}

beforeEach(() => leavePhotoMode());
afterEach(() => {
  sessionStore.set(null);
  leavePhotoMode();
});

describe('calibrating with the photo hidden', () => {
  test('the command enters the calibrate view on the first photo although none is shown', () => {
    open(wallWithPhotos(2));
    expect(photoStore.get().photoId).toBeNull();
    calibrateShownPhoto();
    expect(photoStore.get()).toMatchObject({
      photoId: 'p1',
      calibrating: true,
    });
  });

  test('with photo mode off, a stale hidden flag is cleared so the photo shows behind the wizard', () => {
    open(wallWithPhotos(1));
    patchPhoto({ photoId: null, photoHidden: true, split: 0.5 });
    calibrateShownPhoto();
    expect(photoStore.get()).toMatchObject({
      photoId: 'p1',
      calibrating: true,
      photoHidden: false,
    });
  });

  test('the pencil on a photo row enters photo mode on that photo, whatever was shown or hidden', () => {
    const wall = wallWithPhotos(2);
    open(wall);
    patchPhoto({ photoId: 'p1', photoHidden: true });
    const second = wall.photos[1];
    if (!second) throw new Error('no photo');
    startCalibration(second.id);
    expect(photoStore.get()).toMatchObject({
      photoId: 'p2',
      calibrating: true,
      photoHidden: false,
    });
  });

  test('the command also opens the wizard for a photo whose overlay is hidden', () => {
    open(wallWithPhotos(1));
    patchPhoto({ photoId: 'p1', photoHidden: true });
    calibrateShownPhoto();
    expect(photoStore.get()).toMatchObject({ photoId: 'p1', calibrating: true });
  });

  test('a divider that is on survives calibrating', () => {
    patchPhoto({ photoId: 'p1', split: 0.5 });
    startCalibration('p1');
    expect(photoStore.get().split).toBe(0.5);
  });

  test('a wall with only a cleaned variant has no photo to calibrate', () => {
    const wall = wallWithPhotos(1);
    const [original] = wall.photos;
    if (!original) throw new Error('no photo');
    const cleaned = { ...original, id: 'c1', cleanOf: original.id };
    open({ ...wall, photos: [cleaned] });
    calibrateShownPhoto();
    expect(photoStore.get()).toMatchObject({ photoId: null, calibrating: false });
  });

  test('with no photo at all the command changes nothing', () => {
    open(wallWithPhotos(0));
    calibrateShownPhoto();
    expect(photoStore.get()).toMatchObject({
      photoId: null,
      calibrating: false,
    });
  });
});
