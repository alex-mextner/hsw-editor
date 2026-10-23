import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createEmptyWall, WallItemSchema, type Wall } from '@hsw-editor/core';
import { placementOfPose, type WallPhysicsReport } from '@hsw-editor/physics';
import { bankStore } from '@/bank/client.ts';
import { localeStore } from '@/i18n/index.ts';
import { physicsStore } from '@/physics/store.ts';
import { physicsHoverStore } from '@/scene/physics/hover.ts';
import { editorStore, setSelection } from '@/state/editor.ts';
import { click, mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { errorProblem, physicsOf, warningProblem } from './physicsFixtures.ts';
import { PhysicsSection } from './PhysicsSection.tsx';
import { ToolPhysicsSection } from './ToolPhysicsSection.tsx';

let mounted: Mounted | null = null;

const wall: Wall = {
  ...createEmptyWall('w', 'Wall'),
  items: [
    WallItemSchema.parse({ id: 'holder', kind: 'holder', label: 'Rack', bankId: 'rack' }),
    WallItemSchema.parse({
      id: 'hammer',
      kind: 'tool',
      label: 'Hammer',
      parentId: 'holder',
      bankId: 'tool',
    }),
    WallItemSchema.parse({
      id: 'caliper',
      kind: 'tool',
      label: 'Caliper',
      parentId: 'holder',
      bankId: 'tool',
    }),
    WallItemSchema.parse({
      id: 'file',
      kind: 'tool',
      label: 'File',
      parentId: 'holder',
      bankId: 'tool',
    }),
  ],
};

const report: WallPhysicsReport = {
  flagged: 3,
  tools: [
    physicsOf('file', 0.9, []),
    physicsOf('caliper', 0.7, [warningProblem('swings')]),
    physicsOf('hammer', 0.1, [{ code: 'levitating', severity: 'error', params: { gapMm: 12 } }]),
  ],
};

beforeEach(() => {
  localeStore.set('en');
  bankStore.set({ status: 'loading' });
  physicsStore.set({ status: 'ready', report, at: 0 });
  setSelection([]);
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  physicsStore.set({ status: 'idle' });
  physicsHoverStore.set(null);
  setSelection([]);
});

withDomGlobals();

const rowTools = (container: HTMLElement): (string | undefined)[] =>
  [...container.querySelectorAll<HTMLElement>('[data-testid="physics-row"]')].map(
    (row) => row.dataset['tool'],
  );

describe('PhysicsSection', () => {
  test('lists tools with problems, errors first, with the reason sentences and the count', async () => {
    mounted = await mount(<PhysicsSection wall={wall} />);
    const text = mounted.container.textContent ?? '';
    expect(text).toContain('2 tools need attention');
    expect(rowTools(mounted.container)).toEqual(['hammer', 'caliper']);
    expect(text).toContain('Floats 12 mm above its holder: nothing touches it');
    expect(text).toContain('Hammer');
    expect(text).toContain('on Rack #1');
    expect(text).toContain('Rating 10%');
  });

  test('clicking a row selects that tool; hovering it points the viewport at it', async () => {
    mounted = await mount(<PhysicsSection wall={wall} />);
    const row = mounted.container.querySelector<HTMLElement>('[data-tool="caliper"]');
    expect(row).not.toBeNull();
    await click(mounted.container, '[data-tool="caliper"]');
    expect(editorStore.get().selection).toEqual(['caliper']);
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(physicsHoverStore.get()).toBe('caliper');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    });
    expect(physicsHoverStore.get()).toBeNull();
  });

  test('says so when every tool hangs well, and in Russian', async () => {
    physicsStore.set({
      status: 'ready',
      report: { flagged: 0, tools: [physicsOf('file', 0.95, [])] },
      at: 0,
    });
    localeStore.set('ru');
    mounted = await mount(<PhysicsSection wall={wall} />);
    expect(mounted.container.textContent).toContain('Все инструменты висят хорошо');
    expect(mounted.container.querySelector('[data-testid="physics-report"]')).toBeNull();
  });

  test('shows the status while checking and an error message when the check failed', async () => {
    physicsStore.set({ status: 'running', previous: null });
    mounted = await mount(<PhysicsSection wall={wall} />);
    expect(mounted.container.textContent).toContain('Checking…');
    const button = [...mounted.container.querySelectorAll('button')].find((b) =>
      /Check/.test(b.textContent ?? ''),
    );
    expect(button?.disabled).toBe(true);
    await act(async () => physicsStore.set({ status: 'error', message: 'no wasm' }));
    await mounted.render(<PhysicsSection wall={wall} />);
    expect(mounted.container.textContent).toContain('Physics check failed: no wasm');
  });

  test('keeps the previous report visible while a new check runs', async () => {
    physicsStore.set({ status: 'running', previous: report });
    mounted = await mount(<PhysicsSection wall={wall} />);
    expect(rowTools(mounted.container)).toEqual(['hammer', 'caliper']);
  });
});

describe('ToolPhysicsSection', () => {
  test('a selected tool shows its hang chip, problems, removal verdict and mass', async () => {
    const base = physicsOf('hammer', 0.35, [
      errorProblem('tips'),
      { code: 'removal_needs_tilt', severity: 'warning', params: { path: 'lift 15 mm, pull' } },
    ]);
    physicsStore.set({
      status: 'ready',
      at: 0,
      report: {
        flagged: 1,
        tools: [
          {
            ...base,
            hang: {
              ...base.hang,
              massG: 450,
              rest: {
                placement: placementOfPose({ x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 }),
                tiltDeg: 12,
              },
            },
            removal: {
              verdict: 'needs_tilt',
              convenience: 0.45,
              clearanceMm: 5,
              neighbourGapMm: 20,
              path: 'tilt x +15 deg, lift 15 mm, pull',
              liftMm: 15,
              pullMm: 20,
              blockedBy: [],
              reasons: [{ code: 'needs_tilt', params: { axis: 'x', deg: 15 } }],
            },
          },
        ],
      },
    });
    mounted = await mount(<ToolPhysicsSection wall={wall} itemId="hammer" />);
    const text = mounted.container.textContent ?? '';
    expect(mounted.container.querySelector('[data-testid="hang-chip"]')?.textContent).toBe(
      'Unstable · 35%',
    );
    expect(text).toContain('Tips over: its centre of gravity is not over the support');
    expect(text).toContain('Needs a tilt to take off (lift 15 mm, pull)');
    expect(text).toContain('Taking it off: Needs a tilt');
    expect(text).toContain('Path: tilt 15° about x, lift 15 mm, pull');
    expect(text).toContain('Convenience 45%');
    expect(text).toContain('Mass 450 g');
    expect(text).toContain('Leans 12° and rests against the holder walls');
  });

  test('says nothing before the first check, and says "not analysed" after it', async () => {
    physicsStore.set({ status: 'idle' });
    mounted = await mount(<ToolPhysicsSection wall={wall} itemId="hammer" />);
    expect(mounted.container.textContent).toBe('');
    await act(async () =>
      physicsStore.set({ status: 'ready', report: { flagged: 0, tools: [] }, at: 0 }),
    );
    await mounted.render(<ToolPhysicsSection wall={wall} itemId="hammer" />);
    expect(mounted.container.textContent).toContain('Not analysed');
  });
});
