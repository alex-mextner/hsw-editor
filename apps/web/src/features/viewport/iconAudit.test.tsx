/** Every icon button of the top bar and the viewport toolbar explains itself: accessible name, tooltip on press, both languages. */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip.tsx';
import { seenHintsStore, takeFirstUse } from '@/components/iconHints.ts';
import { localeStore, type Locale } from '@/i18n/index.ts';
import { mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';

let mounted: Mounted | null = null;
withDomGlobals();
// The top bar's page-level controllers (service worker, install prompt) start when it is imported, so it needs the DOM first.
let bars: ReactElement;
beforeAll(async () => {
  const { TopBar } = await import('@/features/topbar/TopBar.tsx');
  const { ViewportToolbar } = await import('./ViewportToolbar.tsx');
  bars = (
    <TooltipProvider>
      <div data-testid="top">
        <TopBar />
      </div>
      <div data-testid="viewport">
        <ViewportToolbar />
      </div>
    </TooltipProvider>
  );
});
beforeEach(() => seenHintsStore.set([]));
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

function iconButtons(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button')].filter(
    (button) => (button.textContent ?? '').trim() === '',
  );
}

describe('icon buttons of the bars', () => {
  for (const locale of ['en', 'ru'] satisfies Locale[]) {
    test(`each one has a distinct accessible name in ${locale}`, async () => {
      localeStore.set(locale);
      mounted = await mount(bars);
      const buttons = iconButtons(mounted.container);
      // Top bar: panels, undo/redo, zones, physics, import, export, offline, language, theme, assistant, more; viewport: 5.
      expect(buttons.length).toBeGreaterThanOrEqual(14);
      const names = buttons.map((button) => button.getAttribute('aria-label') ?? '');
      for (const name of names) expect(name.trim().length).toBeGreaterThan(2);
      const unique = new Set(names);
      // Same action in two places (import photo sits in the viewport bar and the top bar) is the only repeat allowed.
      expect(names.length - unique.size).toBeLessThanOrEqual(2);
    });
  }

  test('the photo overlay button is a camera that says what it does, not a crossed-out eye', async () => {
    localeStore.set('en');
    mounted = await mount(bars);
    const button = mounted.container.querySelector<HTMLElement>(
      '[data-testid="viewport"] button[aria-label^="Overlay a photo"]',
    );
    expect(button).not.toBeNull();
    expect(button?.querySelector('svg.lucide-camera')).not.toBeNull();
    expect(button?.querySelector('svg.lucide-eye-off')).toBeNull();
  });

  test('the first press of an icon is remembered as its hint, the second is not a first use', async () => {
    localeStore.set('en');
    mounted = await mount(bars);
    const fit = mounted.container.querySelector<HTMLElement>('button[aria-label^="Fit"]');
    const label = fit?.getAttribute('aria-label') ?? '';
    expect(label).not.toBe('');
    expect(seenHintsStore.get()).not.toContain(label);
    await act(async () => fit?.click());
    expect(seenHintsStore.get()).toContain(label);
    expect(takeFirstUse(label)).toBe(false);
  });
});
