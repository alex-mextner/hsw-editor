/**
 * Putting an AI-edited photo back into the original: only the masked area (feathered at the edge) comes from the
 * model, everything else is the original's own pixels. A model that re-draws the whole picture, or shifts it, is
 * detected by how far the unmasked part moved and rejected.
 */

/** Mean absolute difference per byte outside the mask (sampled), 0..255. */
export function outsideDrift(
  original: Uint8Array,
  edited: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
): number {
  const stride = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = y * width + x;
      if (mask[i]) continue;
      for (let c = 0; c < 3; c += 1) {
        sum += Math.abs((original[i * 3 + c] ?? 0) - (edited[i * 3 + c] ?? 0));
        count += 1;
      }
    }
  }
  return count === 0 ? 0 : sum / count;
}

function boxBlurRow(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(width * height);
  const span = 2 * radius + 1;
  for (let y = 0; y < height; y += 1) {
    let acc = 0;
    for (let x = -radius; x <= radius; x += 1)
      acc += src[y * width + Math.min(width - 1, Math.max(0, x))] ?? 0;
    for (let x = 0; x < width; x += 1) {
      out[y * width + x] = acc / span;
      acc +=
        (src[y * width + Math.min(width - 1, x + radius + 1)] ?? 0) -
        (src[y * width + Math.max(0, x - radius)] ?? 0);
    }
  }
  return out;
}

function transpose(src: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) out[x * height + y] = src[y * width + x] ?? 0;
  return out;
}

/** Original with the masked area (feathered over `featherPx`) replaced by the edited photo's pixels. */
export function compositeEdited(
  original: Uint8Array,
  edited: Uint8Array,
  width: number,
  height: number,
  mask: Uint8Array,
  featherPx: number,
): Uint8Array {
  const alpha0 = new Float32Array(width * height);
  for (let i = 0; i < alpha0.length; i += 1) alpha0[i] = mask[i] ? 1 : 0;
  const radius = Math.max(1, Math.round(featherPx));
  const horizontal = boxBlurRow(alpha0, width, height, radius);
  const alpha = transpose(
    boxBlurRow(transpose(horizontal, width, height), height, width, radius),
    height,
    width,
  );
  const out = new Uint8Array(original);
  for (let i = 0; i < width * height; i += 1) {
    const a = mask[i] ? 1 : (alpha[i] ?? 0);
    if (a <= 0.002) continue;
    for (let c = 0; c < 3; c += 1) {
      out[i * 3 + c] = Math.round(
        (original[i * 3 + c] ?? 0) * (1 - a) + (edited[i * 3 + c] ?? 0) * a,
      );
    }
  }
  return out;
}
