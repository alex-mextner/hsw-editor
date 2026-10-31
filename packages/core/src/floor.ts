/**
 * The floor under the wall. A tool let go with nothing holding it falls to this plane (`packages/physics/src/fall.ts`) and stays
 * there until somebody picks it up. The board's lower edge is `y = 0`, gravity points along `-y` and the viewer is on the `+z`
 * side, so the floor is a horizontal rectangle below the board that reaches `FLOOR_DEPTH_MM` out from the wall.
 */
import { type Board, boardSizeMm } from './grid.ts';

/** Height of the floor (mm, wall frame): under the lowest tools (a spray can on the bottom row hangs to y = -50) and close enough that the camera that frames the wall frames it too. */
export const FLOOR_Y_MM = -150;
/** How far the floor reaches from the wall towards the viewer (mm). */
export const FLOOR_DEPTH_MM = 400;
/** The floor reaches this far (mm) past the board's left and right edges. */
export const FLOOR_SIDE_MARGIN_MM = 400;

/** The floor rectangle: x range over the board plus its margins, depth from the wall. */
export function floorExtentMm(board: Board): { x0: number; x1: number; depth: number } {
  const { width } = boardSizeMm(board);
  return { x0: -FLOOR_SIDE_MARGIN_MM, x1: width + FLOOR_SIDE_MARGIN_MM, depth: FLOOR_DEPTH_MM };
}
