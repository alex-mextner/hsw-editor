/**
 * HSW honeycomb grid geometry.
 *
 * Wall coordinates: millimetres, x to the right, y up, z out of the wall towards the room. The board
 * occupies [0, width] x [0, height] with its lower-left corner at the origin. Cells sit in columns
 * `HSW_COL_PITCH_MM` apart; consecutive columns are staggered by half a row, so every cell has six
 * neighbours at `HSW_ROW_PITCH_MM` (20.4382 * 2 / sqrt(3) = 23.6).
 *
 * Source of the pitches: HSW panel calibration (`refit/design.json` of the HSW project).
 */
export const HSW_COL_PITCH_MM = 20.4382;
export const HSW_ROW_PITCH_MM = 23.6;
/** The lattice is six-fold symmetric: holders snap to multiples of this angle. */
export const HEX_SYMMETRY_DEG = 60;

export interface GridCell {
  col: number;
  row: number;
}

export interface Board {
  /** Number of columns (x direction). */
  cols: number;
  /** Number of cells per column (y direction). */
  rows: number;
  colPitchMm: number;
  rowPitchMm: number;
}

export const DEFAULT_BOARD: Board = {
  cols: 48,
  rows: 32,
  colPitchMm: HSW_COL_PITCH_MM,
  rowPitchMm: HSW_ROW_PITCH_MM,
};

/** Bounding rectangle of the board in mm. Odd columns are shifted up by half a row. */
export function boardSizeMm(board: Board): { width: number; height: number } {
  const stagger = board.cols > 1 ? board.rowPitchMm / 2 : 0;
  return { width: board.cols * board.colPitchMm, height: board.rows * board.rowPitchMm + stagger };
}

export function cellInBoard(board: Board, cell: GridCell): boolean {
  return (
    Number.isInteger(cell.col) &&
    Number.isInteger(cell.row) &&
    cell.col >= 0 &&
    cell.col < board.cols &&
    cell.row >= 0 &&
    cell.row < board.rows
  );
}

/** Centre of a cell in wall coordinates (mm). Pure and deterministic: the same cell always yields the same bits. */
export function cellCenter(board: Board, cell: GridCell): { x: number; y: number } {
  const stagger = (cell.col & 1) === 1 ? 0.5 : 0;
  return {
    x: (cell.col + 0.5) * board.colPitchMm,
    y: (cell.row + 0.5 + stagger) * board.rowPitchMm,
  };
}

/** Nearest cell to a wall point, clamped to the board. */
export function nearestCell(board: Board, x: number, y: number): GridCell {
  const clamp = (value: number, max: number): number => Math.min(Math.max(value, 0), max);
  const guessCol = Math.round(x / board.colPitchMm - 0.5);
  let best: GridCell = { col: 0, row: 0 };
  let bestDistance = Infinity;
  for (let col = guessCol - 1; col <= guessCol + 1; col++) {
    const c = clamp(col, board.cols - 1);
    const stagger = (c & 1) === 1 ? 0.5 : 0;
    const r = clamp(Math.round(y / board.rowPitchMm - 0.5 - stagger), board.rows - 1);
    const center = cellCenter(board, { col: c, row: r });
    const distance = (center.x - x) ** 2 + (center.y - y) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = { col: c, row: r };
    }
  }
  return best;
}

/** Degrees normalised to [0, 360). */
export function normalizeDeg(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped === 360 ? 0 : wrapped;
}

/** Nearest multiple of the honeycomb symmetry angle, in [0, 360). */
export function snapRotationDeg(deg: number): number {
  return normalizeDeg(Math.round(deg / HEX_SYMMETRY_DEG) * HEX_SYMMETRY_DEG);
}
