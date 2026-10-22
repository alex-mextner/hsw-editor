/**
 * Geometry de-duplication. Two parts are the same element when their normalised triangle soups hash
 * equal, or — to catch STEP/STL/3MF copies of one part, whose tessellations differ — when their sorted
 * bounding-box extents agree within DIM_TOL_MM and volume within VOLUME_TOL and surface area within AREA_TOL.
 */
import type { ProbePart } from './meshTool.ts';

export const DIM_TOL_MM = 0.25;
export const VOLUME_TOL = 0.005;
export const AREA_TOL = 0.01;

export interface Candidate {
  /** Unique key of the part (file + part id). */
  key: string;
  /** Lower value = preferred as the representative of its cluster. */
  priority: number;
  part: Pick<ProbePart, 'geometryHash' | 'mirrorHashes' | 'sortedDimsMm' | 'volumeMm3' | 'areaMm2'>;
}

export interface Cluster<T extends Candidate> {
  representative: T;
  duplicates: T[];
}

export function sameShape(a: Candidate['part'], b: Candidate['part']): boolean {
  if (a.geometryHash === b.geometryHash) return true;
  // left/right hand pairs have identical size, volume and area: never fold a mirror image into its twin
  if (a.mirrorHashes.includes(b.geometryHash)) return false;
  for (let i = 0; i < 3; i++) {
    if (Math.abs((a.sortedDimsMm[i] ?? 0) - (b.sortedDimsMm[i] ?? 0)) > DIM_TOL_MM) return false;
  }
  const larger = Math.max(a.volumeMm3, b.volumeMm3);
  if (larger === 0) return false;
  if (Math.abs(a.volumeMm3 - b.volumeMm3) / larger > VOLUME_TOL) return false;
  return Math.abs(a.areaMm2 - b.areaMm2) / Math.max(a.areaMm2, b.areaMm2) <= AREA_TOL;
}

export function clusterParts<T extends Candidate>(candidates: readonly T[]): Cluster<T>[] {
  const sorted = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.key.localeCompare(b.key),
  );
  const clusters: Cluster<T>[] = [];
  for (const candidate of sorted) {
    const home = clusters.find((c) =>
      [c.representative, ...c.duplicates].some((member) => sameShape(member.part, candidate.part)),
    );
    if (home) home.duplicates.push(candidate);
    else clusters.push({ representative: candidate, duplicates: [] });
  }
  return clusters;
}
