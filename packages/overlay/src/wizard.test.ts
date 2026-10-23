import { describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD } from '@hsw-editor/core';
import { boardExtent } from './calibration.ts';
import type { Vec2 } from './matrix.ts';
import {
  reduceWizard,
  startWizard,
  wizardPreview,
  wizardPrompt,
  type WizardEvent,
  type WizardState,
} from './wizard.ts';
import { syntheticCamera, wallToPhoto } from './test-helpers.ts';

const image = { width: 1200, height: 1600 };
const extent = boardExtent(DEFAULT_BOARD);

function run(state: WizardState, events: WizardEvent[]): WizardState {
  return events.reduce(reduceWizard, state);
}

describe('two-point wizard', () => {
  test('walks click, click, confirm with the default 1 m length', () => {
    let state = startWizard('two-point', extent);
    expect(state).toMatchObject({ realMm: 1000, axis: 'free', clicks: [] });
    expect(wizardPrompt(state)).toEqual({ kind: 'click', index: 0, label: 'reference-start' });
    state = run(state, [{ type: 'click', px: [100, 500] }]);
    expect(wizardPrompt(state)).toEqual({ kind: 'click', index: 1, label: 'reference-end' });
    state = run(state, [{ type: 'click', px: [1100, 500] }]);
    expect(wizardPrompt(state)).toEqual({ kind: 'confirm' });
    // further clicks do nothing
    expect(run(state, [{ type: 'click', px: [5, 5] }])).toBe(state);
  });

  test('live preview: scale, click-error bounds and warnings', () => {
    const state = run(startWizard('two-point', extent), [
      { type: 'click', px: [100, 500] },
      { type: 'click', px: [1100, 500] },
    ]);
    const out = wizardPreview(state, image, extent);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.preview.result.mmPerPx).toBeCloseTo(1, 12);
    expect(out.preview.clickError?.threePx.worstMmPerMeter).toBeCloseTo(6.036, 2);
    expect(out.preview.warnings).toEqual(['single-scale-only-at-reference']);
    // one scale everywhere: nothing to report as a spread
    expect(out.preview.spread).toBeUndefined();
  });

  test('a short reference is flagged', () => {
    const state = run(startWizard('two-point', extent), [
      { type: 'click', px: [100, 500] },
      { type: 'click', px: [180, 500] },
      { type: 'setLength', realMm: 100 },
    ]);
    const out = wizardPreview(state, image, extent);
    expect(out.ok && out.preview.warnings[0]).toBe('short-reference');
  });

  test('a placed click can be moved and the preview follows', () => {
    let state = run(startWizard('two-point', extent), [
      { type: 'click', px: [100, 500] },
      { type: 'click', px: [1100, 500] },
    ]);
    state = reduceWizard(state, { type: 'moveClick', index: 1, px: [600, 500] });
    const out = wizardPreview(state, image, extent);
    expect(out.ok && out.preview.result.mmPerPx).toBeCloseTo(2, 12);
    expect(reduceWizard(state, { type: 'moveClick', index: 5, px: [0, 0] })).toBe(state);
  });

  test('typed length and axis feed the result; bad input is reported, not thrown', () => {
    const base = run(startWizard('two-point', extent), [
      { type: 'click', px: [100, 500] },
      { type: 'click', px: [900, 700] },
    ]);
    expect(
      wizardPreview(reduceWizard(base, { type: 'setLength', realMm: 0 }), image, extent),
    ).toEqual({
      ok: false,
      problem: 'invalid-length',
    });
    const tooClose = run(startWizard('two-point', extent), [
      { type: 'click', px: [100, 500] },
      { type: 'click', px: [101, 500] },
    ]);
    expect(wizardPreview(tooClose, image, extent)).toEqual({
      ok: false,
      problem: 'clicks-too-close',
    });
    expect(wizardPreview(startWizard('two-point', extent), image, extent)).toEqual({
      ok: false,
      problem: 'need-clicks',
    });
    const rolled = wizardPreview(
      reduceWizard(base, { type: 'setAxis', axis: 'horizontal' }),
      image,
      extent,
    );
    expect(rolled.ok && rolled.preview.result.method).toBe('two-point');
  });

  test('undo removes the last click, reset all', () => {
    const state = run(startWizard('two-point', extent), [
      { type: 'click', px: [1, 1] },
      { type: 'click', px: [9, 9] },
    ]);
    expect(reduceWizard(state, { type: 'undo' }).clicks).toEqual([[1, 1]]);
    expect(reduceWizard(state, { type: 'reset' }).clicks).toEqual([]);
    expect(reduceWizard(startWizard('two-point', extent), { type: 'undo' }).clicks).toEqual([]);
  });
});

describe('corners wizard', () => {
  const camera = syntheticCamera({
    image,
    focalPx: 1100,
    yawDeg: 20,
    pitchDeg: 12,
    rollDeg: 2,
    distanceMm: 2200,
    lookAt: [490, 380],
  });
  const wall: Vec2[] = [
    [0, 0],
    [extent.widthMm, 0],
    [extent.widthMm, extent.heightMm],
    [0, extent.heightMm],
  ];
  const clicks = wall.map((p) => wallToPhoto(camera, p));

  test('asks for the four corners in order, defaulting the size to the board', () => {
    let state = startWizard('corners', extent);
    expect(state).toMatchObject({ widthMm: extent.widthMm, heightMm: extent.heightMm });
    const labels = [];
    for (const px of clicks) {
      const step = wizardPrompt(state);
      expect(step.kind).toBe('click');
      if (step.kind === 'click') labels.push(step.label);
      state = reduceWizard(state, { type: 'click', px });
    }
    expect(labels).toEqual(['lower-left', 'lower-right', 'upper-right', 'upper-left']);
    expect(wizardPrompt(state)).toEqual({ kind: 'confirm' });
  });

  test('the preview rectifies the board and reports a near-zero reprojection error', () => {
    const state = run(
      startWizard('corners', extent),
      clicks.map((px): WizardEvent => ({ type: 'click', px })),
    );
    const out = wizardPreview(state, image, extent);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.preview.result.reprojection.maxPx).toBeLessThan(1e-6);
    expect(out.preview.spread?.relativeSpread).toBeGreaterThan(0.05);
    expect(out.preview.warnings).toEqual([]);
  });

  test('swapped corners are a corner-order problem; a typed size changes the scale', () => {
    const swapped = run(startWizard('corners', extent), [
      { type: 'click', px: clicks[0]! },
      { type: 'click', px: clicks[2]! },
      { type: 'click', px: clicks[1]! },
      { type: 'click', px: clicks[3]! },
    ]);
    expect(wizardPreview(swapped, image, extent)).toEqual({ ok: false, problem: 'corner-order' });
    const good = run(
      startWizard('corners', extent),
      clicks.map((px): WizardEvent => ({ type: 'click', px })),
    );
    const half = reduceWizard(good, {
      type: 'setSize',
      widthMm: extent.widthMm / 2,
      heightMm: extent.heightMm / 2,
    });
    const a = wizardPreview(good, image, extent);
    const b = wizardPreview(half, image, extent);
    expect(a.ok && b.ok && b.preview.result.mmPerPx / a.preview.result.mmPerPx).toBeCloseTo(0.5, 9);
    expect(
      wizardPreview(reduceWizard(good, { type: 'setSize', widthMm: 0 }), image, extent),
    ).toEqual({
      ok: false,
      problem: 'invalid-size',
    });
  });
});
