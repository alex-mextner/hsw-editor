/**
 * The honeycomb panel as the white web between the cell holes, for photo mode: the real wall shows through the
 * holes, as it does on the hung board. Drawn once into a canvas that becomes an alpha-masked plane texture.
 */
import { boardSizeMm, cellCenter, type Board } from '@hsw-editor/core';
import type { WebStyle } from './webContrast.ts';

/** Texture density: finer than the photo resolves, coarse enough for a 3000 px canvas. */
export const WEB_PX_PER_MM = 2;

/** Canvas limits that hold on phones (iOS Safari draws nothing above ~16.7 Mpx): the density drops for huge boards. */
const MAX_WEB_PIXELS = 12_000_000;
const MAX_WEB_SIDE = 8192;

export function webPxPerMm(board: Board): number {
  const size = boardSizeMm(board);
  return Math.min(
    WEB_PX_PER_MM,
    MAX_WEB_SIDE / Math.max(size.width, size.height),
    Math.sqrt(MAX_WEB_PIXELS / (size.width * size.height)),
  );
}

export function webCanvasSize(board: Board): { width: number; height: number } {
  const size = boardSizeMm(board);
  return {
    width: Math.ceil(size.width * webPxPerMm(board)),
    height: Math.ceil(size.height * webPxPerMm(board)),
  };
}

/**
 * Fills the board with the style's plate colour and punches a flat-top hexagon at every cell (wall y up, canvas y
 * down); a style with an edge then strokes the hole edges and the board border onto the plate only.
 */
export function drawBoardWeb(ctx: CanvasRenderingContext2D, board: Board, style: WebStyle): void {
  const { width, height } = webCanvasSize(board);
  const density = webPxPerMm(board);
  const mmHeight = height / density;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = style.fill;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'destination-out';
  const radius = (board.colPitchMm / 1.5) * 0.86 * density;
  const holes = new Path2D();
  for (let col = 0; col < board.cols; col += 1) {
    for (let row = 0; row < board.rows; row += 1) {
      const centre = cellCenter(board, { col, row });
      const cx = centre.x * density;
      const cy = (mmHeight - centre.y) * density;
      for (let corner = 0; corner < 6; corner += 1) {
        const angle = (Math.PI / 3) * corner;
        const x = cx + radius * Math.cos(angle);
        const y = cy - radius * Math.sin(angle);
        if (corner === 0) holes.moveTo(x, y);
        else holes.lineTo(x, y);
      }
      holes.closePath();
    }
  }
  ctx.fill(holes);
  if (style.edge !== null) {
    // source-atop paints only where the plate is: the half of the hairline that falls into the hole stays clear.
    ctx.globalCompositeOperation = 'source-atop';
    ctx.strokeStyle = style.edge;
    ctx.lineWidth = style.edgeMm * density;
    ctx.lineJoin = 'round';
    ctx.stroke(holes);
    // The board's outer border gets the same hairline, so the plate edge reads against the wall too.
    ctx.strokeRect(0, 0, width, height);
  }
  ctx.globalCompositeOperation = 'source-over';
}
