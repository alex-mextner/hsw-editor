import { BufferAttribute, type BufferGeometry } from 'three';

/**
 * A copy of `source` with the `color` attribute the stripe shader reads (1 = stripe in the look's own colour; 0 would
 * switch the vertex to the white stripes of red-on-red invalid zones). Tool meshes have no vertex colours, and a missing
 * attribute reads as 0, which painted the amber stripes white.
 */
export function withStripeColour(source: BufferGeometry): BufferGeometry {
  const geometry = source.clone();
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  return geometry;
}
