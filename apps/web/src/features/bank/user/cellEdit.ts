/**
 * Editing rules of the footprint and the mounting cells. The server enforces the same invariants
 * (docs/bank.md "User elements"): the anchor cell {0,0} is always in the footprint, mounting cells are a subset
 * of the footprint, and a mounting kind other than `none` needs at least one mounting cell.
 */
import type { CellOffset, Mounting } from '@hsw-editor/bank';
import { hasCell, isAnchor, sameCell } from './hexGrid.ts';

export type MountingKind = Mounting['kind'];

export interface CellSets {
  readonly footprint: readonly CellOffset[];
  readonly mounting: readonly CellOffset[];
}

/** Toggles one footprint cell. The anchor stays; removing a cell also removes its peg. */
export function toggleFootprintCell(sets: CellSets, cell: CellOffset): CellSets {
  if (isAnchor(cell)) return sets;
  if (hasCell(sets.footprint, cell)) {
    return {
      footprint: sets.footprint.filter((other) => !sameCell(other, cell)),
      mounting: sets.mounting.filter((other) => !sameCell(other, cell)),
    };
  }
  return { footprint: [...sets.footprint, cell], mounting: sets.mounting };
}

/** Sets a footprint cell on or off (drag-painting); same invariants as the toggle. */
export function paintFootprintCell(sets: CellSets, cell: CellOffset, on: boolean): CellSets {
  return hasCell(sets.footprint, cell) === on ? sets : toggleFootprintCell(sets, cell);
}

/** Toggles a peg; only cells of the footprint can carry one. */
export function toggleMountingCell(sets: CellSets, cell: CellOffset): CellSets {
  if (!hasCell(sets.footprint, cell)) return sets;
  return {
    footprint: sets.footprint,
    mounting: hasCell(sets.mounting, cell)
      ? sets.mounting.filter((other) => !sameCell(other, cell))
      : [...sets.mounting, cell],
  };
}

export function paintMountingCell(sets: CellSets, cell: CellOffset, on: boolean): CellSets {
  return hasCell(sets.mounting, cell) === on ? sets : toggleMountingCell(sets, cell);
}

/** Mounting cells that survive in the footprint (detected pegs after the footprint was edited). */
export function clampMounting(
  footprint: readonly CellOffset[],
  mounting: readonly CellOffset[],
): CellOffset[] {
  return mounting.filter((cell) => hasCell(footprint, cell));
}

export type MountingIssue = 'no-pegs' | null;

/** Inline validation of the peg editor: a real mounting kind needs at least one peg. */
export function mountingIssue(kind: MountingKind, mounting: readonly CellOffset[]): MountingIssue {
  return kind !== 'none' && mounting.length === 0 ? 'no-pegs' : null;
}

/** Default mounting kind of a category, as the server picks it when none is sent. */
export function defaultMountingKind(category: string): MountingKind {
  return category.startsWith('panels') ? 'none' : 'hex-plug';
}
