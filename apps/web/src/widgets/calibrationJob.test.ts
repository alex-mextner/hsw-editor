import { describe, expect, test } from 'bun:test';
import { gridCalibration, jobErrorText } from './calibrationJob.ts';

function jobResult(core: unknown, ok = true): unknown {
  return { status: ok ? 'ok' : 'needs_calibration', calibration: { ok, method: 'grid', core } };
}

describe('gridCalibration', () => {
  test('maps the core calibration of a vision.calibrate result to a grid calibration, ignoring extra fields', () => {
    const mapped = gridCalibration(
      jobResult({
        method: 'grid',
        mmPerPx: 0.25,
        focalPx: 1800,
        reprojErrorPx: 0.8,
        points: [{ px: [10, 20], wall: [0, 0] }],
        confidence: 0.9,
      }),
    );
    expect(mapped?.calibration).toEqual({
      method: 'grid',
      mmPerPx: 0.25,
      focalPx: 1800,
      reprojErrorPx: 0.8,
      points: [{ px: [10, 20], wall: [0, 0] }],
    });
  });

  test('a homography-only result is applicable', () => {
    const homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(gridCalibration(jobResult({ homography }))?.calibration.homography).toEqual([
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ]);
  });

  test('a result without any scale, or without a found grid, is not applicable', () => {
    expect(gridCalibration(jobResult({ focalPx: 1800 }))).toBeNull();
    expect(gridCalibration(jobResult({}))).toBeNull();
    expect(gridCalibration(jobResult(undefined, false))).toBeNull();
  });

  test('garbage is rejected rather than thrown', () => {
    expect(gridCalibration(null)).toBeNull();
    expect(gridCalibration('done')).toBeNull();
    expect(gridCalibration(jobResult({ mmPerPx: -1 }))).toBeNull();
    expect(gridCalibration(jobResult({ homography: [1, 2, 3] }))).toBeNull();
    expect(gridCalibration({ mmPerPx: 0.25 })).toBeNull();
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
