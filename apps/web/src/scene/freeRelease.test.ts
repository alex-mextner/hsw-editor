import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import type { LeafOp, Pose } from '@hsw-editor/core';
import * as realPostStep from '@/physics/postStep.ts';
import type { ReleaseOutcome } from '@/physics/fall.ts';
import type { PreviewPose } from '@/state/editor.ts';

const realPostStepExports = { ...realPostStep };
import type { FreeRelease } from '@/physics/fall.ts';
const PLACED: ReleaseOutcome = { kind: 'placed' };
/** What the physics answers to the next free release. */
let decide: () => Promise<ReleaseOutcome> = async () => PLACED;
const released: FreeRelease[] = [];

mock.module('@/physics/postStep.ts', () => ({
  ...realPostStepExports,
  releaseFreeTool: (release: FreeRelease) => {
    released.push(release);
    return decide();
  },
}));

const { editorStore, patchEditor } = await import('@/state/editor.ts');
const { fallDurationMs, fallPoseAt, fallingStore } = await import('./fallAnimation.ts');
const { letGoFree } = await import('./freeRelease.ts');
const { takePreview, cancelSnap } = await import('./snapAnimation.ts');

const FROM: Required<PreviewPose> = {
  x: 300,
  y: 400,
  z: 40,
  rotX: 0,
  rotY: 0,
  rotZ: 180,
};
const TO: Pose = { x: 300, y: -231, z: 41, rotX: 0, rotY: 90, rotZ: 90 };
const OPS: LeafOp[] = [{ type: 'moveItem', id: 'drv', to: { x: 300, y: 400 } }];

afterEach(() => {
  cancelSnap();
  fallingStore.set(new Set());
  patchEditor({ dragging: new Map() });
  released.length = 0;
  decide = async () => PLACED;
});

describe('fall animation maths', () => {
  test('a fall takes as long as a body under gravity: 0.6 m in about 0.35 s, never less than a visible moment', () => {
    expect(fallDurationMs(600)).toBeCloseTo(350, -1);
    expect(fallDurationMs(1)).toBe(220);
  });

  test('y accelerates (a quarter of the way in time is a sixteenth of the way down), x and z are straight', () => {
    const quarter = fallPoseAt(FROM, TO, 0.25);
    expect((FROM.y - quarter.y) / (FROM.y - TO.y)).toBeCloseTo(0.0625, 6);
    expect(quarter.x).toBe(300);
    expect(quarter.z).toBeCloseTo(40.25, 6);
    expect(fallPoseAt(FROM, TO, 1)).toEqual({
      x: 300,
      y: -231,
      z: 41,
      rotX: 0,
      rotY: 90,
      rotZ: 90,
    });
    expect(fallPoseAt(FROM, TO, 0)).toEqual(FROM);
  });
});

describe('letGoFree', () => {
  test('the tool hovers at its release pose with the floor lit until the decision comes', async () => {
    const pending = Promise.withResolvers<ReleaseOutcome>();
    decide = () => pending.promise;
    const running = letGoFree({ toolId: 'drv', ops: OPS, label: 'move-item' }, FROM);
    expect(editorStore.get().dragging.get('drv')).toEqual(FROM);
    expect(fallingStore.get().has('drv')).toBe(true);
    pending.resolve(PLACED);
    await running;
    expect(editorStore.get().dragging.size).toBe(0);
    expect(fallingStore.get().size).toBe(0);
  });

  test('a tool that stays: the preview and the lit floor are dropped at once', async () => {
    expect(await letGoFree({ toolId: 'drv', ops: OPS, label: 'move-item' }, FROM)).toEqual(PLACED);
    expect(editorStore.get().dragging.size).toBe(0);
    expect(fallingStore.get().size).toBe(0);
  });

  test('a tool that falls (no animation frames in the test run): it lands, the preview is dropped', async () => {
    decide = async () => ({ kind: 'fell', to: TO, dropMm: 640, landedOn: null });
    const result = await letGoFree({ toolId: 'drv', ops: OPS, label: 'move-item' }, FROM);
    expect(result.kind).toBe('fell');
    expect(released).toEqual([{ toolId: 'drv', ops: OPS, label: 'move-item' }]);
    expect(fallingStore.get().size).toBe(0);
  });

  test('a new drag taking the preview over ends the fall for the old tool without clearing the new preview', async () => {
    const pending = Promise.withResolvers<ReleaseOutcome>();
    decide = () => pending.promise;
    const running = letGoFree({ toolId: 'drv', ops: OPS, label: 'move-item' }, FROM);
    takePreview();
    patchEditor({ dragging: new Map([['other', { x: 1, y: 2, rotZ: 0 }]]) });
    pending.resolve({ kind: 'fell', to: TO, dropMm: 640, landedOn: null });
    await running;
    expect(editorStore.get().dragging.has('other')).toBe(true);
    expect(fallingStore.get().size).toBe(0);
  });
});

afterAll(() => {
  mock.module('@/physics/postStep.ts', () => realPostStepExports);
});
