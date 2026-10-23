import { describe, expect, test } from 'bun:test';
import type { Draft, DraftObject } from '@hsw-editor/tools/contract';
import {
  calibrationOf,
  canGroup,
  canMerge,
  committable,
  isVisionUnavailable,
  MAX_PHOTOS,
  percent,
  photoProblem,
  takePhotos,
  topClasses,
} from './wizardModel.ts';

function object(key: string, photo: number, patch: Partial<DraftObject> = {}): DraftObject {
  return {
    key,
    photo,
    objectId: 1,
    alsoSeenIn: [],
    status: 'pending',
    name: {},
    suggestions: [],
    tags: [],
    classId: null,
    classOverridden: false,
    observation: null,
    fit: null,
    dimensionsMm: null,
    needsScale: false,
    images: {},
    preview: null,
    ...patch,
  };
}

function draftOf(objects: DraftObject[]): Draft {
  return {
    version: 1,
    id: 'd1',
    createdAt: '2026-10-22T10:00:00Z',
    updatedAt: '2026-10-22T10:00:00Z',
    state: 'ready',
    mode: 'multi',
    photos: [],
    calibration: null,
    objects,
  };
}

const file = (name: string, size = 1000, type = 'image/jpeg'): File => new File([new Uint8Array(size)], name, { type });

describe('calibrationOf', () => {
  test('auto means no calibration field, the others map to the request body', () => {
    expect(calibrationOf({ kind: 'auto' })).toBeNull();
    expect(calibrationOf({ kind: 'mmPerPx', mmPerPx: 0.25 })).toEqual({ mmPerPx: 0.25 });
    expect(
      calibrationOf({ kind: 'twoPoint', pointsPx: [[0, 0], [100, 0]], distanceMm: 50 }),
    ).toEqual({ pointsPx: [[0, 0], [100, 0]], distanceMm: 50 });
  });
});

describe('photos', () => {
  test('type, size and the HEIC-without-MIME case', () => {
    expect(photoProblem(file('a.jpg'))).toBeNull();
    expect(photoProblem(file('a.heic', 10, ''))).toBeNull();
    expect(photoProblem(file('a.pdf', 10, 'application/pdf'))).toBe('type');
    expect(photoProblem({ name: 'big.jpg', type: 'image/jpeg', size: 41 * 1024 * 1024 })).toBe('size');
  });
  test('takePhotos keeps good files, refuses bad ones and stops at the limit', () => {
    const taken = takePhotos([], [file('a.jpg'), file('b.txt', 5, 'text/plain')]);
    expect(taken.accepted.map((f) => f.name)).toEqual(['a.jpg']);
    expect(taken.rejected).toEqual([{ file: expect.any(File), problem: 'type' }]);
    const existing = Array.from({ length: MAX_PHOTOS }, (_, i) => file(`p${i}.jpg`));
    const over = takePhotos(existing, [file('x.jpg')]);
    expect(over.accepted).toEqual([]);
    expect(over.rejected[0]?.problem).toBe('count');
  });
});

describe('objects', () => {
  test('topClasses sorts by score and cuts to n', () => {
    const o = object('0:1', 0, {
      suggestions: [
        { classId: 'a', score: 0.2 },
        { classId: 'b', score: 0.7 },
        { classId: 'c', score: 0.5 },
        { classId: 'd', score: 0.1 },
      ],
    });
    expect(topClasses(o).map((s) => s.classId)).toEqual(['b', 'c', 'a']);
  });
  test('only accepted objects with a scale are committed', () => {
    const draft = draftOf([
      object('0:1', 0, { status: 'accepted' }),
      object('0:2', 0, { status: 'accepted', needsScale: true }),
      object('0:3', 0, { status: 'discarded' }),
      object('0:4', 0, { status: 'added' }),
    ]);
    expect(committable(draft).map((o) => o.key)).toEqual(['0:1']);
  });
  test('merge needs two objects of one photo, group needs two from different photos', () => {
    const draft = draftOf([object('0:1', 0), object('0:2', 0), object('1:1', 1)]);
    expect(canMerge(draft, ['0:1', '0:2'])).toBe(true);
    expect(canMerge(draft, ['0:1', '1:1'])).toBe(false);
    expect(canMerge(draft, ['0:1'])).toBe(false);
    expect(canGroup(draft, ['0:1', '1:1'])).toBe(true);
    expect(canGroup(draft, ['0:1', '0:2'])).toBe(false);
    expect(canGroup(draft, ['0:1', 'nope'])).toBe(false);
  });
});

describe('helpers', () => {
  test('percent clamps to 0..100', () => {
    expect(percent(0.456)).toBe(46);
    expect(percent(2)).toBe(100);
    expect(percent(-1)).toBe(0);
  });
  test('vision failures are told apart from bad photos', () => {
    expect(isVisionUnavailable('vision sidecar not reachable at http://127.0.0.1:8795')).toBe(true);
    expect(isVisionUnavailable('photo 2 is corrupt')).toBe(false);
    expect(isVisionUnavailable(null)).toBe(false);
  });
});
