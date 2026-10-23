import { BufferAttribute, BufferGeometry, EdgesGeometry } from 'three';

/** Outline of a region mesh: line-segment endpoints of every edge sharper than 30 degrees (xyz pairs, same unit). */
export function regionEdges(positions: Float32Array, indices: Uint32Array): Float32Array {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  const edges = new EdgesGeometry(geometry, 30);
  const segments = Float32Array.from(edges.getAttribute('position').array);
  edges.dispose();
  geometry.dispose();
  return segments;
}
