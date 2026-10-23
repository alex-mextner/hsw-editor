/**
 * Where the name chips of the tool ghosts go. Each chip wants to sit just above its object; on a crowded photo
 * the chips would pile on top of one another, so they are placed one by one and pushed up (then down) until they
 * touch no chip placed before them. Pure geometry in stage pixels.
 */
export interface LabelRequest {
  readonly id: number;
  /** The point the chip hangs from: horizontal middle and top of the object's outline. */
  readonly anchorX: number;
  readonly anchorY: number;
  readonly width: number;
}

export interface LabelPlacement {
  readonly id: number;
  /** Horizontal middle and top edge of the chip. */
  readonly x: number;
  readonly y: number;
}

export interface LabelBounds {
  /** Rectangles that must stay clear of chips (the proposals bar), stage pixels. */
  readonly reserved?: readonly { left: number; right: number; top: number; bottom: number }[];
  readonly width: number;
  readonly height: number;
  readonly chipHeight: number;
  readonly gap: number;
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

const MAX_STEPS = 12;

export function layoutLabels(
  requests: readonly LabelRequest[],
  bounds: LabelBounds,
): LabelPlacement[] {
  // Space the stage keeps for its own controls: no chip is put there.
  const placed: Box[] = [...(bounds.reserved ?? [])];
  const out: LabelPlacement[] = [];
  const { chipHeight, gap } = bounds;
  const step = chipHeight + gap;
  // Top to bottom, left to right: the chips that start lowest are pushed up past the ones above them.
  const ordered = [...requests].sort(
    (a, b) => a.anchorY - b.anchorY || a.anchorX - b.anchorX || a.id - b.id,
  );
  for (const request of ordered) {
    const half = request.width / 2;
    const x = Math.min(Math.max(request.anchorX, half), Math.max(half, bounds.width - half));
    const boxAt = (top: number): Box => ({
      left: x - half,
      right: x + half,
      top,
      bottom: top + chipHeight,
    });
    const home = request.anchorY - chipHeight - gap;
    const free = (top: number): boolean => !placed.some((box) => overlaps(box, boxAt(top)));
    // Up first (towards the room above the object), then down past it.
    const candidates = [
      ...Array.from({ length: MAX_STEPS }, (_, i) => Math.max(0, home - i * step)),
      ...Array.from({ length: MAX_STEPS }, (_, i) =>
        Math.min(bounds.height - chipHeight, request.anchorY + (i + 1) * step),
      ),
    ];
    const top = candidates.find(free) ?? Math.max(0, Math.min(home, bounds.height - chipHeight));
    placed.push(boxAt(top));
    out.push({ id: request.id, x, y: top });
  }
  return out;
}
