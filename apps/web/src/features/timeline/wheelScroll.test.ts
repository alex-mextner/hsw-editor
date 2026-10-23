import { describe, expect, test } from 'bun:test';
import { horizontalWheelDelta, type StripMetrics, type WheelInput } from './wheelScroll.ts';

const strip: StripMetrics = { scrollLeft: 100, scrollWidth: 1000, clientWidth: 400 };

function wheel(patch: Partial<WheelInput>): WheelInput {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...patch,
  };
}

describe('wheel over the horizontal history strip', () => {
  test('a plain mouse-wheel notch scrolls the strip sideways by the same distance', () => {
    expect(horizontalWheelDelta(wheel({ deltaY: 100 }), strip)).toBe(100);
    expect(horizontalWheelDelta(wheel({ deltaY: -100 }), strip)).toBe(-100);
  });

  test('line- and page-based wheels (Firefox, some mice) are converted to pixels', () => {
    expect(horizontalWheelDelta(wheel({ deltaY: 3, deltaMode: 1 }), strip)).toBe(48);
    expect(horizontalWheelDelta(wheel({ deltaY: 1, deltaMode: 2 }), strip)).toBe(400);
  });

  test('a trackpad swipe that is already horizontal is left to the browser', () => {
    expect(horizontalWheelDelta(wheel({ deltaX: 80, deltaY: 6 }), strip)).toBeNull();
    expect(horizontalWheelDelta(wheel({ deltaX: -80 }), strip)).toBeNull();
  });

  test('Shift + wheel is already translated by the browser, so it is not doubled', () => {
    expect(horizontalWheelDelta(wheel({ deltaY: 100, shiftKey: true }), strip)).toBeNull();
  });

  test('Ctrl/Cmd + wheel is a zoom gesture and is never hijacked', () => {
    expect(horizontalWheelDelta(wheel({ deltaY: 100, ctrlKey: true }), strip)).toBeNull();
    expect(horizontalWheelDelta(wheel({ deltaY: 100, metaKey: true }), strip)).toBeNull();
  });

  test('a strip that fits has nothing to scroll', () => {
    expect(
      horizontalWheelDelta(wheel({ deltaY: 100 }), {
        scrollLeft: 0,
        scrollWidth: 400,
        clientWidth: 400,
      }),
    ).toBeNull();
  });

  test('at an end the wheel is not swallowed when it would scroll further that way', () => {
    expect(
      horizontalWheelDelta(wheel({ deltaY: 100 }), {
        scrollLeft: 600,
        scrollWidth: 1000,
        clientWidth: 400,
      }),
    ).toBeNull();
    expect(
      horizontalWheelDelta(wheel({ deltaY: -100 }), {
        scrollLeft: 0,
        scrollWidth: 1000,
        clientWidth: 400,
      }),
    ).toBeNull();
    // ...but it still scrolls back from the end.
    expect(
      horizontalWheelDelta(wheel({ deltaY: -100 }), {
        scrollLeft: 600,
        scrollWidth: 1000,
        clientWidth: 400,
      }),
    ).toBe(-100);
  });
});
