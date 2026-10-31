/** The first-use hint of an icon button: shown once on screen with the label of the press, ended by a dismissal, never used up by a vanished button. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, useRef, useState } from 'react';
import { mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { hintSeen, seenHintsStore, useFirstUseHint } from './iconHints.ts';

withDomGlobals();
let mounted: Mounted | null = null;
beforeEach(() => seenHintsStore.set([]));
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const frames = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()));

/** A toggle: its label changes with each press; `gone` removes the button the way a close or dismiss button does. */
function Toggle({
  remove,
  byLabel,
  onScreen,
}: {
  readonly remove?: boolean;
  readonly byLabel?: boolean;
  readonly onScreen?: boolean;
}) {
  const [on, setOn] = useState(false);
  const [gone, setGone] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const label = on ? 'Dark theme' : 'Light theme';
  const hint = useFirstUseHint(byLabel === true ? label : 'theme', anchor);
  return (
    <div>
      {gone ? null : (
        <button
          ref={anchor}
          type="button"
          onClick={() => {
            hint.press(label, onScreen === true);
            setOn(!on);
            if (remove === true) setGone(true);
          }}
        >
          {label}
        </button>
      )}
      <output>{hint.showing ?? 'none'}</output>
      <button type="button" data-testid="dismiss" onClick={hint.dismiss}>
        dismiss
      </button>
    </div>
  );
}

const shown = (): string => mounted?.container.querySelector('output')?.textContent ?? '';

describe('useFirstUseHint', () => {
  test('shows the label the button had when pressed, not the one it has after the press, then remembers it', async () => {
    mounted = await mount(<Toggle />);
    await act(async () => mounted?.container.querySelector('button')?.click());
    await act(frames);
    expect(shown()).toBe('Light theme');
    expect(hintSeen('theme')).toBe(true);
  });

  test('a dismissal (Escape, an outside tap) ends the hint', async () => {
    mounted = await mount(<Toggle />);
    await act(async () => mounted?.container.querySelector('button')?.click());
    await act(frames);
    await act(async () =>
      mounted?.container.querySelector<HTMLElement>('[data-testid="dismiss"]')?.click(),
    );
    expect(shown()).toBe('none');
  });

  test('a second press does not show it again', async () => {
    mounted = await mount(<Toggle />);
    const press = async (): Promise<void> => {
      await act(async () => mounted?.container.querySelector('button')?.click());
      await act(frames);
    };
    await press();
    await act(async () =>
      mounted?.container.querySelector<HTMLElement>('[data-testid="dismiss"]')?.click(),
    );
    await press();
    expect(shown()).toBe('none');
  });

  test('a press that removes its own button shows nothing and does not use the hint up', async () => {
    mounted = await mount(<Toggle remove />);
    await act(async () => mounted?.container.querySelector('button')?.click());
    await act(frames);
    expect(shown()).toBe('none');
    expect(hintSeen('theme')).toBe(false);
  });

  test('a toggle whose key is its label records the label it was pressed with: each label shows once, then never again', async () => {
    mounted = await mount(<Toggle byLabel />);
    const press = async (): Promise<void> => {
      await act(async () => mounted?.container.querySelector('button')?.click());
      await act(frames);
    };
    const dismiss = (): Promise<void> =>
      act(async () =>
        mounted?.container.querySelector<HTMLElement>('[data-testid="dismiss"]')?.click(),
      );
    await press();
    expect(shown()).toBe('Light theme');
    await dismiss();
    await press();
    expect(shown()).toBe('Dark theme');
    await dismiss();
    await press();
    expect(shown()).toBe('none');
    await press();
    expect(shown()).toBe('none');
  });

  test('a press while the tooltip is already open counts as seen and holds nothing open', async () => {
    mounted = await mount(<Toggle onScreen />);
    await act(async () => mounted?.container.querySelector('button')?.click());
    await act(frames);
    expect(shown()).toBe('none');
    expect(hintSeen('theme')).toBe(true);
  });
});
