import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { api } from '@/api/http.ts';
import { toastStore } from '@/features/notices/notices.ts';
import { sessionStore } from '@/wall/session.ts';
import { firstImage, importPhotoFile, importStore, isSupportedImage } from './photoImport.ts';

describe('isSupportedImage', () => {
  test('accepts the formats the server normalises, by MIME type or extension', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic']) {
      expect(isSupportedImage({ name: 'x', type })).toBe(true);
    }
    expect(isSupportedImage({ name: 'IMG_0001.HEIC', type: '' })).toBe(true);
    expect(isSupportedImage({ name: 'wall.JPG', type: '' })).toBe(true);
  });

  test('refuses everything else, however it is named', () => {
    expect(isSupportedImage({ name: 'wall.pdf', type: 'application/pdf' })).toBe(false);
    expect(isSupportedImage({ name: 'wall.gif', type: 'image/gif' })).toBe(false);
    expect(isSupportedImage({ name: 'heic', type: '' })).toBe(false);
  });
});

describe('firstImage', () => {
  test('skips non-images and returns the first photo', () => {
    const files = [
      new File(['a'], 'notes.txt', { type: 'text/plain' }),
      new File(['b'], 'wall.png', { type: 'image/png' }),
      new File(['c'], 'other.jpg', { type: 'image/jpeg' }),
    ];
    expect(firstImage(files)?.name).toBe('wall.png');
    expect(firstImage([files[0]!])).toBeNull();
    expect(firstImage([])).toBeNull();
  });
});

describe('importPhotoFile', () => {
  const originalUpload = api.uploadPhoto;
  let uploads = 0;

  beforeEach(() => {
    uploads = 0;
    toastStore.set([]);
    importStore.set({ phase: 'idle' });
    sessionStore.set({
      wallId: 'w',
      status: 'ready',
      wall: null,
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
  });
  afterEach(() => {
    api.uploadPhoto = originalUpload;
    sessionStore.set(null);
  });

  test('an unsupported file is refused with a notice and never uploaded', async () => {
    api.uploadPhoto = () => {
      uploads += 1;
      return Promise.reject(new Error('unreachable'));
    };
    await importPhotoFile(new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    expect(uploads).toBe(0);
    expect(toastStore.get().map((toast) => toast.kind)).toEqual(['error']);
    expect(importStore.get().phase).toBe('idle');
  });

  test('a failed upload ends in an error notice and an idle importer', async () => {
    api.uploadPhoto = () => Promise.reject(new Error('server said no'));
    await importPhotoFile(new File(['x'], 'wall.jpg', { type: 'image/jpeg' }));
    const [toast] = toastStore.get();
    expect(toast?.kind).toBe('error');
    expect(toast?.text).toContain('server said no');
    expect(importStore.get().phase).toBe('idle');
  });

  test('a second photo while one is uploading is ignored', async () => {
    importStore.set({ phase: 'uploading', name: 'first.jpg', fraction: 0.5 });
    api.uploadPhoto = () => {
      uploads += 1;
      return Promise.reject(new Error('unreachable'));
    };
    await importPhotoFile(new File(['x'], 'second.jpg', { type: 'image/jpeg' }));
    expect(uploads).toBe(0);
    expect(importStore.get()).toMatchObject({ phase: 'uploading', name: 'first.jpg' });
  });

  test('nothing happens without an open wall', async () => {
    sessionStore.set(null);
    api.uploadPhoto = () => {
      uploads += 1;
      return Promise.reject(new Error('unreachable'));
    };
    await importPhotoFile(new File(['x'], 'wall.jpg', { type: 'image/jpeg' }));
    expect(uploads).toBe(0);
    expect(toastStore.get()).toHaveLength(0);
  });
});
