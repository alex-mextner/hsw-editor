import { describe, expect, test } from 'bun:test';
import { matchesWhen } from '@hsw-editor/commands';
import {
  deriveContext,
  type FocusSource,
  focusRegion,
  probeFocus,
  REGION_SELECTOR,
} from './context.ts';

const BASE = {
  selectionCount: 0,
  hasWall: true,
  hasPhoto: true,
  canUndo: false,
  canRedo: false,
  clipboard: false,
  textSelection: false,
  placeAt: false,
  mode: 'select',
  dialogOpen: false,
  focus: 'canvas',
  settings: { 'setting.editor.snap': true },
} as const;

describe('deriveContext', () => {
  test('exposes the keys the when-clauses use', () => {
    const context = deriveContext({ ...BASE, selectionCount: 2, canUndo: true });
    expect(context).toMatchObject({
      selection: true,
      hasWall: true,
      canUndo: true,
      canRedo: false,
      mode: 'select',
      dialog: false,
      focus: 'canvas',
      'setting.editor.snap': true,
    });
  });

  test('an empty selection is false', () => {
    expect(deriveContext(BASE).selection).toBe(false);
  });

  test('drives the default when-clauses', () => {
    const selected = deriveContext({ ...BASE, selectionCount: 1 });
    expect(matchesWhen('selection && !dialog', selected)).toBe(true);
    expect(matchesWhen('selection && !dialog', { ...selected, dialog: true })).toBe(false);
    expect(matchesWhen('canUndo && !dialog', selected)).toBe(false);
    expect(matchesWhen("mode == 'measure' || focus == canvas", selected)).toBe(true);
    expect(matchesWhen('setting.editor.snap', selected)).toBe(true);
  });

  test('settings cannot overwrite the built-in keys', () => {
    const context = deriveContext({ ...BASE, settings: { selection: true, dialog: true } });
    expect(context.selection).toBe(false);
    expect(context.dialog).toBe(false);
  });
});

describe('focusRegion', () => {
  test('a text field beats the region around it', () => {
    expect(focusRegion({ slot: 'inspector', typing: true, paletteOpen: false })).toBe('input');
  });

  test('the open palette beats everything', () => {
    expect(focusRegion({ slot: 'viewport', typing: true, paletteOpen: true })).toBe('palette');
  });

  test('shell regions map to their names, unknown ones to the canvas', () => {
    expect(focusRegion({ slot: 'viewport', typing: false, paletteOpen: false })).toBe('canvas');
    expect(focusRegion({ slot: 'palette', typing: false, paletteOpen: false })).toBe('bank');
    expect(focusRegion({ slot: 'inspector', typing: false, paletteOpen: false })).toBe('inspector');
    expect(focusRegion({ slot: 'timeline', typing: false, paletteOpen: false })).toBe('history');
    expect(focusRegion({ slot: 'omp-dock', typing: false, paletteOpen: false })).toBe('agent');
    expect(focusRegion({ slot: 'switch', typing: false, paletteOpen: false })).toBe('canvas');
    expect(focusRegion({ slot: undefined, typing: false, paletteOpen: false })).toBe('canvas');
  });
});

/** An element with ancestors, each carrying a `data-slot`; `closest` follows the real selector rules. */
function elementIn(...slots: readonly string[]): FocusSource {
  return {
    closest: (selector) => {
      const wanted = [...selector.matchAll(/\[data-slot="([^"]+)"\]/g)].map((match) => match[1]);
      const hit = slots.find((slot) => wanted.includes(slot));
      return hit === undefined ? null : { getAttribute: () => hit };
    },
  };
}

describe('probeFocus', () => {
  test('selects the shell regions only', () => {
    expect(REGION_SELECTOR).toBe(
      '[data-slot="viewport"],[data-slot="palette"],[data-slot="inspector"],[data-slot="timeline"],[data-slot="omp-dock"]',
    );
  });

  test('a button inside the inspector is in the inspector, not on the canvas', () => {
    const probe = probeFocus(false, false, elementIn('button', 'inspector'));
    expect(focusRegion(probe)).toBe('inspector');
  });

  test('UI primitives deep inside the agent dock still resolve to the dock', () => {
    const probe = probeFocus(
      false,
      false,
      elementIn('input', 'scroll-area-viewport', 'omp-dock-body', 'omp-dock'),
    );
    expect(focusRegion(probe)).toBe('agent');
  });

  test('focus outside every region, or nowhere, is the canvas', () => {
    expect(focusRegion(probeFocus(false, false, elementIn('button', 'dialog-content')))).toBe(
      'canvas',
    );
    expect(focusRegion(probeFocus(false, false, null))).toBe('canvas');
  });
});

describe('hasPhoto', () => {
  test('gates the calibrate command: off with no photo on the wall', () => {
    const on = deriveContext({ ...BASE, hasPhoto: true });
    const off = deriveContext({ ...BASE, hasPhoto: false });
    expect(matchesWhen('hasWall && hasPhoto', on)).toBe(true);
    expect(matchesWhen('hasWall && hasPhoto', off)).toBe(false);
  });
});
