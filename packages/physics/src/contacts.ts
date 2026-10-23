/**
 * Contacts of a settled tool: where the obstacles (holder, neighbours, the wall plane) touch it or are within the
 * slack a tool has inside its slot (`holdGapMm`: a shaft in a 5 mm hole is held by the hole wall although it
 * rattles 0.5 mm). Every contact carries the direction of the force it can push the tool with.
 */
import type { Vec3 } from '@hsw-editor/compat';
import { type ColumnGrid, spanRange } from './columns.ts';

export type ContactKind = 'support' | 'ceiling' | 'lateral' | 'wall';

export interface Contact {
  /** Point on the tool, world mm. */
  p: Vec3;
  /** Unit direction of the force the obstacle exerts on the tool. */
  n: Vec3;
  kind: ContactKind;
  /** Id of the obstacle (`wall` for the board plane). */
  source: string;
  /** Distance (mm) between the surfaces: 0 when touching. A loose contact cannot pinch, so it carries no friction. */
  gapMm: number;
}

export interface ContactOptions {
  /** Vertical gap that still counts as resting on a surface. */
  restGapMm: number;
  /** Lateral gap that still counts as held by a wall of the slot. */
  holdGapMm: number;
}

export const DEFAULT_CONTACT_OPTIONS: ContactOptions = { restGapMm: 0.6, holdGapMm: 3.0 };

export interface NamedGrid {
  id: string;
  grid: ColumnGrid;
}

const MIN_LATERAL_OVERLAP_MM = 1;

export function findContacts(
  tool: ColumnGrid,
  obstacles: readonly NamedGrid[],
  di: number,
  dj: number,
  y: number,
  options: ContactOptions = DEFAULT_CONTACT_OPTIONS,
): Contact[] {
  const cell = tool.cellMm;
  const reach = Math.max(1, Math.ceil(options.holdGapMm / cell));
  const out: Contact[] = [];
  const dirs: readonly (readonly [number, number])[] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (let j = tool.j0; j < tool.j0 + tool.nz; j++) {
    for (let i = tool.i0; i < tool.i0 + tool.nx; i++) {
      const [t0, t1] = spanRange(tool, i, j);
      if (t1 === t0) continue;
      const cx = (i + di + 0.5) * cell;
      const cz = (j + dj + 0.5) * cell;
      // The wall plane z = 0: tool columns in the first cells touch it.
      if ((j + dj) * cell <= options.restGapMm) {
        for (let t = t0; t < t1; t++) {
          const mid = ((tool.spans[2 * t] ?? 0) + (tool.spans[2 * t + 1] ?? 0)) / 2 + y;
          out.push({
            p: [cx, mid, 0],
            n: [0, 0, 1],
            kind: 'wall',
            source: 'wall',
            gapMm: Math.max(0, (j + dj) * cell),
          });
        }
      }
      for (const { id, grid } of obstacles) {
        // Columns farther than the hold reach from the obstacle's footprint cannot touch it.
        const oi = i + di - grid.i0;
        const oj = j + dj - grid.j0;
        if (oi < -reach || oj < -reach || oi >= grid.nx + reach || oj >= grid.nz + reach) continue;
        const [o0, o1] = spanRange(grid, i + di, j + dj);
        for (let t = t0; t < t1; t++) {
          const bottom = (tool.spans[2 * t] ?? 0) + y;
          const top = (tool.spans[2 * t + 1] ?? 0) + y;
          for (let o = o0; o < o1; o++) {
            const oBottom = grid.spans[2 * o] ?? 0;
            const oTop = grid.spans[2 * o + 1] ?? 0;
            const below = bottom - oTop;
            if (below >= -0.05 && below <= options.restGapMm) {
              out.push({
                p: [cx, bottom, cz],
                n: [0, 1, 0],
                kind: 'support',
                source: id,
                gapMm: Math.max(0, below),
              });
            }
            const above = oBottom - top;
            if (above >= -0.05 && above <= options.restGapMm) {
              out.push({
                p: [cx, top, cz],
                n: [0, -1, 0],
                kind: 'ceiling',
                source: id,
                gapMm: Math.max(0, above),
              });
            }
          }
        }
        // Lateral neighbours: obstacle material beside a boundary column of the tool, at the same height.
        for (const [dx, dz] of dirs) {
          for (let k = 1; k <= reach; k++) {
            const [n0, n1] = spanRange(grid, i + di + dx * k, j + dj + dz * k);
            if (n1 === n0) continue;
            let touched = false;
            for (let t = t0; t < t1; t++) {
              const bottom = (tool.spans[2 * t] ?? 0) + y;
              const top = (tool.spans[2 * t + 1] ?? 0) + y;
              if (selfOccupies(tool, i + dx, j + dz, bottom - y, top - y)) continue;
              let lo = Infinity;
              let hi = -Infinity;
              for (let o = n0; o < n1; o++) {
                const a = Math.max(bottom, grid.spans[2 * o] ?? 0);
                const b = Math.min(top, grid.spans[2 * o + 1] ?? 0);
                if (b - a >= MIN_LATERAL_OVERLAP_MM) {
                  lo = Math.min(lo, a);
                  hi = Math.max(hi, b);
                }
              }
              if (hi > lo) {
                touched = true;
                // A wall patch pushes with its whole height: both edges carry force (a couple resists tilting).
                const px = cx + (dx * cell) / 2;
                const pz = cz + (dz * cell) / 2;
                const gapMm = (k - 1) * cell;
                out.push({ p: [px, lo, pz], n: [-dx, 0, -dz], kind: 'lateral', source: id, gapMm });
                out.push({ p: [px, hi, pz], n: [-dx, 0, -dz], kind: 'lateral', source: id, gapMm });
              }
            }
            // The nearest wall beside the column is the one that holds; farther ones are behind it.
            if (touched) break;
          }
        }
      }
    }
  }
  return out;
}

/** True when the tool itself has material in column (i, j) over [bottom, top] (tool-frame heights): an interior neighbour, not a boundary. */
function selfOccupies(
  tool: ColumnGrid,
  i: number,
  j: number,
  bottom: number,
  top: number,
): boolean {
  const [s0, s1] = spanRange(tool, i, j);
  for (let s = s0; s < s1; s++) {
    const a = Math.max(bottom, tool.spans[2 * s] ?? 0);
    const b = Math.min(top, tool.spans[2 * s + 1] ?? 0);
    if (b - a >= MIN_LATERAL_OVERLAP_MM) return true;
  }
  return false;
}
