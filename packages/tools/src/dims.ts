/**
 * Sizes and holding data of a tool model as plain values: free of generators and of Node, so `@hsw-editor/tools/contract`
 * (what the browser's main thread imports) can carry them without the tool classes.
 */
import type { HangPoint } from './model.ts';

/** Width (x), length (y) and thickness (z) in mm: the box of a wall tool item. */
export interface ToolDims {
  x: number;
  y: number;
  z: number;
}

/** Dimension within which a typed size counts as reached. */
export const DIM_TOLERANCE_MM = 0.5;

/** Whether `wanted` asks for a size the box `dims` does not already have (axes left undefined are not asked for). */
export function differsFromDims(dims: ToolDims, wanted: Partial<ToolDims>): boolean {
  return (['x', 'y', 'z'] as const).some((axis) => {
    const target = wanted[axis];
    return target !== undefined && Math.abs(target - dims[axis]) > DIM_TOLERANCE_MM;
  });
}

/** The part of the holding interface that decides how a holder takes the tool (what `@hsw-editor/compat` reads). */
export interface HoldingSummary {
  lengthMm: number;
  hang: {
    point: [number, number, number];
    kind: HangPoint['kind'];
    diameterMm?: number | undefined;
  } | null;
  maxSection: { w: number; t: number; r: number };
  dims: Record<string, number>;
}
