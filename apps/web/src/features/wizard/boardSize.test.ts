import { describe, expect, test } from 'bun:test';
import { boardSizeMm, DEFAULT_BOARD } from '@hsw-editor/core';
import { BOARD_PRESETS, boardFromSize, sizeOfBoard } from './boardSize.ts';

const pitches = { colPitchMm: DEFAULT_BOARD.colPitchMm, rowPitchMm: DEFAULT_BOARD.rowPitchMm };

describe('boardFromSize', () => {
  test('the board never exceeds the requested size and uses whole cells', () => {
    for (const [widthMm, heightMm] of [
      [1000, 800],
      [1200, 600],
      [333, 250],
    ] as const) {
      const board = boardFromSize({ widthMm, heightMm, ...pitches });
      expect(board).not.toBeNull();
      if (!board) continue;
      const size = boardSizeMm(board);
      expect(size.width).toBeLessThanOrEqual(widthMm);
      expect(size.height).toBeLessThanOrEqual(heightMm);
      // One more row or column would not fit.
      expect(boardSizeMm({ ...board, cols: board.cols + 1 }).width).toBeGreaterThan(widthMm);
      expect(boardSizeMm({ ...board, rows: board.rows + 1 }).height).toBeGreaterThan(heightMm);
    }
  });

  test('every preset round-trips through its displayed size to the same cell counts', () => {
    for (const preset of BOARD_PRESETS) {
      const size = sizeOfBoard(preset.board);
      const board = boardFromSize({
        ...size,
        colPitchMm: preset.board.colPitchMm,
        rowPitchMm: preset.board.rowPitchMm,
      });
      expect(board).toEqual(preset.board);
    }
  });

  test('rejects sizes without room for a cell and absurd sizes', () => {
    expect(boardFromSize({ widthMm: 10, heightMm: 800, ...pitches })).toBeNull();
    expect(boardFromSize({ widthMm: 1000, heightMm: 20, ...pitches })).toBeNull();
    expect(boardFromSize({ widthMm: 1e6, heightMm: 1e6, ...pitches })).toBeNull();
    expect(boardFromSize({ widthMm: NaN, heightMm: 800, ...pitches })).toBeNull();
    expect(
      boardFromSize({ widthMm: 1000, heightMm: 800, colPitchMm: 0, rowPitchMm: 23.6 }),
    ).toBeNull();
  });
});
