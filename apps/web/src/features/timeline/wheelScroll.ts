/** What the history strip needs from a wheel event (a `WheelEvent` satisfies it). */
export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages. */
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

export interface StripMetrics {
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** Pixels per wheel "line" (the usual browser default). */
const LINE_PX = 16;

/**
 * A mouse wheel only produces vertical deltas, which a horizontally scrolling strip ignores, so
 * the strip could only be scrolled with Shift held. Returns how many pixels to scroll sideways for
 * a plain vertical wheel, or null when the browser should handle the event itself: horizontal
 * trackpad swipes and Shift+wheel are already sideways, Ctrl/Cmd+wheel is a zoom, a strip that
 * fits has nothing to scroll, and at an end the wheel passes through instead of being swallowed.
 */
export function horizontalWheelDelta(wheel: WheelInput, strip: StripMetrics): number | null {
  if (wheel.ctrlKey || wheel.metaKey || wheel.shiftKey) return null;
  if (Math.abs(wheel.deltaY) <= Math.abs(wheel.deltaX)) return null;
  const max = strip.scrollWidth - strip.clientWidth;
  if (max <= 0) return null;
  const unit = wheel.deltaMode === 1 ? LINE_PX : wheel.deltaMode === 2 ? strip.clientWidth : 1;
  const delta = wheel.deltaY * unit;
  const next = Math.min(max, Math.max(0, strip.scrollLeft + delta));
  return next === strip.scrollLeft ? null : delta;
}
