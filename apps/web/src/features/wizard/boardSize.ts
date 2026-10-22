import { boardSizeMm, DEFAULT_BOARD, type Board } from '@hsw-editor/core';

export interface BoardSizeInput {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly colPitchMm: number;
  readonly rowPitchMm: number;
}

export const BOARD_LIMITS = { minCells: 1, maxCells: 400 } as const;

/**
 * Board that fits inside a requested size: whole columns, whole rows, and the half-row stagger of odd
 * columns counted against the height. Returns null for sizes that cannot hold a single cell.
 */
export function boardFromSize(input: BoardSizeInput): Board | null {
  const { widthMm, heightMm, colPitchMm, rowPitchMm } = input;
  if (
    ![widthMm, heightMm, colPitchMm, rowPitchMm].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return null;
  }
  const cols = Math.floor(widthMm / colPitchMm);
  const rows = Math.floor((heightMm - (cols > 1 ? rowPitchMm / 2 : 0)) / rowPitchMm);
  if (cols < BOARD_LIMITS.minCells || rows < BOARD_LIMITS.minCells) return null;
  if (cols > BOARD_LIMITS.maxCells || rows > BOARD_LIMITS.maxCells) return null;
  return { cols, rows, colPitchMm, rowPitchMm };
}

/**
 * Size in mm of a given board, for presets and the live preview line. Rounded up: typing the rounded
 * size back must still yield the same whole number of cells (981 mm for 48 columns of 20.4382 mm).
 */
export function sizeOfBoard(board: Board): { widthMm: number; heightMm: number } {
  const { width, height } = boardSizeMm(board);
  return { widthMm: Math.ceil(width), heightMm: Math.ceil(height) };
}

export const BOARD_PRESETS: readonly {
  readonly id: 'small' | 'standard' | 'large';
  readonly board: Board;
}[] = [
  { id: 'small', board: { ...DEFAULT_BOARD, cols: 24, rows: 16 } },
  { id: 'standard', board: DEFAULT_BOARD },
  { id: 'large', board: { ...DEFAULT_BOARD, cols: 72, rows: 48 } },
];
