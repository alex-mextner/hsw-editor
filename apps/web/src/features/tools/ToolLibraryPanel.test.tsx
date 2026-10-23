import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { localeStore } from '@/i18n/index.ts';
import { mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { installFetch, restoreFetch, settleRequests } from '@/test/fetchStub.ts';
import { NO_QUERY } from './model.ts';
import { libraryStore, patchToolsPanel, toolsPanelStore } from './store.ts';
import { ToolLibraryPanel } from './ToolLibraryPanel.tsx';

const label = (en: string, ru: string) => ({ en, ru });
function info(id: string, family: string, familyRu: string, en: string, ru: string) {
  return {
    id,
    family,
    familyLabel: label(`${family} (en)`, familyRu),
    name: label(en, ru),
    bankClass: id,
    keywords: { en: [], ru: [] },
    schema: {},
    presets: [],
    dimsMm: { x: 20, y: 200, z: 20 },
    holdingDims: {},
  };
}
const CLASSES = [
  info('screwdriver', 'drivers', 'Отвёртки', 'Screwdriver', 'Отвёртка'),
  info('hex-key', 'drivers', 'Отвёртки', 'Hex key', 'Шестигранник'),
  info('hammer', 'striking', 'Молотки', 'Hammer', 'Молоток'),
];
const TOOLS = [
  {
    id: 'my-driver',
    name: { en: 'My driver', ru: 'Моя отвёртка' },
    classId: 'screwdriver',
    bankClass: 'screwdriver',
    dimensionsMm: { length: 180, width: 22, thickness: 22, source: 'photo' },
    dimsMm: { x: 22, y: 180, z: 22 },
    holdingDims: {},
    tags: ['garage'],
    confidence: 0.9,
    createdAt: '2026-10-22T10:00:00Z',
    updatedAt: '2026-10-22T10:00:00Z',
    triangles: 10,
  },
];

let mounted: Mounted | null = null;
withDomGlobals();

beforeEach(() => {
  localeStore.set('en');
  patchToolsPanel({ query: NO_QUERY, collapsed: [], view: { page: 'list' }, wizardOpen: false });
  installFetch((url) =>
    Response.json(url.endsWith('/classes') ? { classes: CLASSES } : { tools: TOOLS }),
  );
});
afterEach(async () => {
  restoreFetch();
  await mounted?.unmount();
  mounted = null;
  libraryStore.set({ status: 'loading' });
});

async function open(): Promise<HTMLElement> {
  mounted = await mount(<ToolLibraryPanel />);
  await act(async () => {
    await settleRequests();
  });
  return mounted.container;
}

const groupNames = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-testid="tool-group"] h3 button')].map(
    (button) => button.getAttribute('aria-label') ?? '',
  );

describe('ToolLibraryPanel', () => {
  test('lists the classes and the user tools grouped by type with counts', async () => {
    const root = await open();
    expect(groupNames(root)).toEqual(['drivers (en): 3', 'striking (en): 1']);
    expect(root.querySelectorAll('[data-testid="tool-card"]')).toHaveLength(4);
  });

  test('the user tool carries the "Mine" badge, built-in classes do not', async () => {
    const root = await open();
    const mine = root.querySelector('[data-tool-key="tool:my-driver"]');
    expect(mine?.querySelector('[data-testid="tool-card-mine-badge"]')).not.toBeNull();
    expect(
      root.querySelector('[data-tool-key="class:hammer"] [data-testid="tool-card-mine-badge"]'),
    ).toBeNull();
  });

  test('collapsing a group hides its cards but keeps the count', async () => {
    const root = await open();
    await act(async () => {
      root.querySelector<HTMLButtonElement>('[data-group="striking"] h3 button')?.click();
    });
    expect(root.querySelector('[data-group="striking"] ul')).toBeNull();
    expect(groupNames(root)).toContain('striking (en): 1');
  });

  test('searching in Russian narrows the list (the family name counts) and shows matches even in collapsed groups', async () => {
    patchToolsPanel({ collapsed: ['drivers'], query: { ...NO_QUERY, text: 'отвертка' } });
    const root = await open();
    const keys = [...root.querySelectorAll('[data-testid="tool-card"]')].map((card) =>
      card.getAttribute('data-tool-key'),
    );
    expect(keys).toEqual(['tool:my-driver', 'class:screwdriver', 'class:hex-key']);
    expect(root.querySelector('[data-group="striking"]')).toBeNull();
  });

  test('a tag chip filters to the tools that carry it', async () => {
    const root = await open();
    await act(async () => {
      root.querySelector<HTMLButtonElement>('[data-testid="tool-tags"] button')?.click();
    });
    expect(toolsPanelStore.get().query.tags).toEqual(['garage']);
    const keys = [...root.querySelectorAll('[data-testid="tool-card"]')].map((card) =>
      card.getAttribute('data-tool-key'),
    );
    expect(keys).toEqual(['tool:my-driver']);
  });

  test('a card is a drag source and a failed thumbnail shows the fallback glyph', async () => {
    const root = await open();
    const card = root.querySelector('[data-tool-key="class:hammer"]');
    expect(card?.getAttribute('draggable')).toBe('true');
    const image = card?.querySelector('img');
    expect(image?.getAttribute('src')).toBe('/api/tools/classes/hammer/thumb.webp');
    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(card?.querySelector('[data-testid="tool-thumb-fallback"]')).not.toBeNull();
  });

  test('an unreachable daemon is explained and can be retried', async () => {
    restoreFetch();
    installFetch(() => {
      throw new TypeError('connection refused');
    });
    const root = await open();
    expect(root.textContent).toContain('The tool library is unavailable');
    expect(root.textContent).toContain('hsw-editor start');
  });
});
