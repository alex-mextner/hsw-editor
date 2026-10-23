import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Draft, DraftObject } from '@hsw-editor/tools/contract';
import { localeStore } from '@/i18n/index.ts';
import { mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { installFetch, restoreFetch, settleRequests } from '@/test/fetchStub.ts';
import type { ToolClassInfo } from '../api.ts';
import { PhotoStep } from './PhotoStep.tsx';
import { ReviewStep } from './ReviewStep.tsx';
import { AUTO_SCALE } from './wizardModel.ts';

withDomGlobals();

let mounted: Mounted | null = null;
beforeEach(() => localeStore.set('en'));
afterEach(async () => {
  restoreFetch();
  await mounted?.unmount();
  mounted = null;
});

const LABEL = { en: 'x', ru: 'x' };
const CLASSES: ToolClassInfo[] = ['screwdriver', 'hammer', 'punch'].map((id) => ({
  id,
  family: 'f',
  familyLabel: LABEL,
  name: { en: id, ru: id },
  bankClass: id,
  keywords: { en: [], ru: [] },
  schema: {},
  presets: [],
  dimsMm: { x: 10, y: 100, z: 10 },
  holdingDims: {},
}));

function object(key: string, patch: Partial<DraftObject> = {}): DraftObject {
  return {
    key,
    photo: 0,
    objectId: 1,
    alsoSeenIn: [],
    status: 'pending',
    name: {},
    tags: [],
    suggestions: [
      { classId: 'screwdriver', score: 0.6 },
      { classId: 'hammer', score: 0.3 },
      { classId: 'punch', score: 0.1 },
    ],
    classId: 'screwdriver',
    classOverridden: false,
    observation: null,
    fit: { method: 'class-profile', iou: 0.9, confidence: 0.9, alternatives: [] },
    dimensionsMm: { length: 200, width: 30, thickness: 30 },
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

const noop = (): void => undefined;

function photoStep(vision: { available: boolean; message?: string } | null, files: File[] = []) {
  return (
    <PhotoStep
      files={files}
      onFiles={noop}
      mode="multi"
      onMode={noop}
      scale={AUTO_SCALE}
      onScale={noop}
      vision={vision}
      onRecheckVision={noop}
      busy={false}
      onAnalyse={noop}
      error={null}
    />
  );
}

describe('PhotoStep', () => {
  test('says the vision service is not available and refuses to analyse', async () => {
    mounted = await mount(
      photoStep({ available: false, message: 'not reachable' }, [new File(['x'], 'a.jpg')]),
    );
    expect(
      mounted.container.querySelector('[data-testid="vision-unavailable"]')?.textContent,
    ).toContain('The vision service is not available');
    expect(
      mounted.container.querySelector('[data-testid="vision-unavailable"]')?.textContent,
    ).toContain('not reachable');
    expect(
      mounted.container.querySelector<HTMLButtonElement>('[data-testid="wizard-analyse"]')
        ?.disabled,
    ).toBe(true);
  });

  test('with the service up and a photo chosen, analysis can start', async () => {
    mounted = await mount(photoStep({ available: true }, [new File(['x'], 'a.jpg')]));
    expect(mounted.container.querySelector('[data-testid="vision-unavailable"]')).toBeNull();
    expect(
      mounted.container.querySelector<HTMLButtonElement>('[data-testid="wizard-analyse"]')
        ?.disabled,
    ).toBe(false);
  });

  test('no photo, no analysis', async () => {
    mounted = await mount(photoStep({ available: true }));
    expect(
      mounted.container.querySelector<HTMLButtonElement>('[data-testid="wizard-analyse"]')
        ?.disabled,
    ).toBe(true);
  });
});

describe('ReviewStep', () => {
  function review(draft: Draft, onDraft: (draft: Draft) => void = noop) {
    return (
      <ReviewStep
        draft={draft}
        classes={CLASSES}
        onDraft={onDraft}
        tags={[]}
        onTags={noop}
        saving={false}
        saveError={null}
        onSave={noop}
        onBack={noop}
      />
    );
  }

  test('shows the top-3 classes with confidence and the save count of accepted objects', async () => {
    mounted = await mount(review(draftOf([object('0:1', { status: 'accepted' }), object('0:2')])));
    const classes = mounted.container.querySelector('[data-testid="wizard-classes"]');
    expect(classes?.textContent).toContain('60%');
    expect(classes?.textContent).toContain('30%');
    expect(classes?.textContent).toContain('10%');
    expect(mounted.container.querySelector('[data-testid="wizard-save"]')?.textContent).toContain(
      'Save 1 tool',
    );
  });

  test('picking another class sends the override and shows the refitted draft', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const refit = draftOf([object('0:1', { classId: 'hammer', classOverridden: true })]);
    installFetch((url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
      return Response.json({ draft: refit });
    });
    let latest: Draft | null = null;
    mounted = await mount(review(draftOf([object('0:1')]), (draft) => (latest = draft)));
    const radios = [
      ...mounted.container.querySelectorAll<HTMLInputElement>(
        '[data-testid="wizard-classes"] input',
      ),
    ];
    await act(async () => {
      radios[1]?.click();
      await settleRequests();
    });
    expect(seen).toEqual([
      { url: '/api/tools/drafts/d1/objects/0%3A1', body: { classId: 'hammer' } },
    ]);
    expect(JSON.stringify(latest)).toBe(JSON.stringify(refit));
  });

  test('an object without a scale explains why it has no dimensions and cannot be saved', async () => {
    mounted = await mount(
      review(
        draftOf([object('0:1', { status: 'accepted', needsScale: true, dimensionsMm: null })]),
      ),
    );
    expect(mounted.container.textContent).toContain('no scale');
    expect(
      mounted.container.querySelector<HTMLButtonElement>('[data-testid="wizard-save"]')?.disabled,
    ).toBe(true);
  });

  test('merge needs two objects of one photo ticked', async () => {
    mounted = await mount(review(draftOf([object('0:1'), object('0:2')])));
    const merge = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="wizard-merge"]',
    );
    expect(merge?.disabled).toBe(true);
    const boxes = [
      ...mounted.container.querySelectorAll<HTMLInputElement>(
        '[data-testid="object-card"] input[type="checkbox"]',
      ),
    ];
    for (const box of boxes) {
      await act(async () => {
        box.click();
      });
    }
    expect(merge?.disabled).toBe(false);
  });

  test('a draft with no objects says nothing was found', async () => {
    mounted = await mount(review(draftOf([])));
    expect(mounted.container.querySelector('[data-testid="wizard-no-objects"]')).not.toBeNull();
  });
});
