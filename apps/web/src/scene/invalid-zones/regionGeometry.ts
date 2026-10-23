/** Merges region meshes into one BufferGeometry (one draw call per pass) and maps picked triangles back to regions. */
import { BufferAttribute, BufferGeometry } from 'three';
import type { RegionMesh } from './engine.ts';

export interface RegionBatch {
  readonly geometry: BufferGeometry;
  /** Outline segments of every region (line segments, scene units). */
  readonly edges: BufferGeometry;
  readonly regions: readonly RegionMesh[];
  /** The region a triangle (as reported by raycasting `faceIndex`) belongs to. */
  regionOfTriangle(faceIndex: number): RegionMesh | undefined;
}

/** `scale` converts the engine's millimetres to scene units (metres in the editor). */
export function buildRegionBatch(
  regions: readonly RegionMesh[],
  scale: number,
): RegionBatch | null {
  let vertexCount = 0;
  let triangleCount = 0;
  for (const region of regions) {
    vertexCount += region.positions.length / 3;
    triangleCount += region.indices.length / 3;
  }
  if (triangleCount === 0) return null;
  const positions = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(triangleCount * 3);
  let edgeFloats = 0;
  for (const region of regions) edgeFloats += region.edges.length;
  const edgePositions = new Float32Array(edgeFloats);
  let edgeOffset = 0;
  const firstTriangle: number[] = [];
  let vertexOffset = 0;
  let triangleOffset = 0;
  for (const region of regions) {
    firstTriangle.push(triangleOffset);
    for (let i = 0; i < region.edges.length; i += 1) {
      edgePositions[edgeOffset + i] = (region.edges[i] ?? 0) * scale;
    }
    edgeOffset += region.edges.length;
    for (let i = 0; i < region.positions.length; i += 1) {
      positions[vertexOffset * 3 + i] = (region.positions[i] ?? 0) * scale;
    }
    for (let i = 0; i < region.indices.length; i += 1) {
      indices[triangleOffset * 3 + i] = (region.indices[i] ?? 0) + vertexOffset;
    }
    vertexOffset += region.positions.length / 3;
    triangleOffset += region.indices.length / 3;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  const edges = new BufferGeometry();
  edges.setAttribute('position', new BufferAttribute(edgePositions, 3));
  return {
    geometry,
    edges,
    regions,
    regionOfTriangle(faceIndex) {
      let low = 0;
      let high = firstTriangle.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((firstTriangle[mid] ?? 0) <= faceIndex) low = mid;
        else high = mid - 1;
      }
      return regions[low];
    },
  };
}

/** Exact identity of a region set: region ids plus the operand keys the engine computed them from. */
export function regionsSignature(regions: readonly RegionMesh[]): string {
  return regions.map((region) => `${region.key}#${region.geometryKey}`).join('|');
}
