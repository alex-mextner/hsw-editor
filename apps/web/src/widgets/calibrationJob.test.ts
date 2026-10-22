import { describe, expect, test } from 'bun:test';
import { gridCalibration, jobErrorText } from './calibrationJob.ts';

describe('gridCalibration', () => {
  test('maps a detector result to a grid calibration, ignoring extra fields', () => {
    const mapped = gridCalibration({
      mmPerPx: 0.25,
      focalPx: 1800,
      reprojErrorPx: 0.8,
      points: [{ px: [10, 20], wall: [0, 0] }],
      confidence: 0.9,
    });
    expect(mapped?.calibration).toEqual({
      method: 'grid',
      mmPerPx: 0.25,
      focalPx: 1800,
      reprojErrorPx: 0.8,
      points: [{ px: [10, 20], wall: [0, 0] }],
    });
  });

  test('a result without any scale is not applicable', () => {
    expect(gridCalibration({ focalPx: 1800 })).toBeNull();
    expect(gridCalibration({})).toBeNull();
  });

  test('garbage is rejected rather than thrown', () => {
    expect(gridCalibration(null)).toBeNull();
    expect(gridCalibration('done')).toBeNull();
    expect(gridCalibration({ mmPerPx: -1 })).toBeNull();
    expect(gridCalibration({ homography: [1, 2, 3] })).toBeNull();
  });
});

describe('jobErrorText', () => {
  test('reads string and {message} errors, nothing else', () => {
    const base = { id: 'j1', state: 'failed' as const };
    expect(jobErrorText({ ...base, error: 'boom' })).toBe('boom');
    expect(jobErrorText({ ...base, error: { message: 'bad photo', code: 'x' } })).toBe('bad photo');
    expect(jobErrorText({ ...base, error: 42 })).toBeNull();
    expect(jobErrorText(base)).toBeNull();
  });
});
