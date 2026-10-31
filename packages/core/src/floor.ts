/**
 * The floor under the wall. A tool let go with nothing holding it falls to this plane (`packages/physics/src/fall.ts`) and stays
 * there until somebody picks it up. The board's lower edge is `y = 0`, gravity points along `-y` and the viewer is on the `+z`
 * side, so the floor is a horizontal rectangle below the board that reaches `FLOOR_DEPTH_MM` out from the wall.
 */
import { type Board, boardSizeMm } from './grid.ts';
import type { Wall, WallItem } from './schema.ts';
import type { WallWarning } from './ops.ts';

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

/** How far (mm) around the floor plane the origin of a tool lying on it may be: the origin is a point of the tool, not its lowest one. */
const FLOOR_ORIGIN_BELOW_MM = 50;
const FLOOR_ORIGIN_ABOVE_MM = 95;

/** A loose tool that lies on the floor under the wall (where a fall leaves it): its origin is below the board by design. */
export function restsOnFloor(item: WallItem, boardWidthMm: number): boolean {
  const { x, y } = item.pose;
  return (
    item.kind === 'tool' &&
    item.parentId === undefined &&
    y <= FLOOR_Y_MM + FLOOR_ORIGIN_ABOVE_MM &&
    y >= FLOOR_Y_MM - FLOOR_ORIGIN_BELOW_MM &&
    x >= -FLOOR_SIDE_MARGIN_MM &&
    x <= boardWidthMm + FLOOR_SIDE_MARGIN_MM
  );
}

/** `warnings` of `wall` without the out-of-board ones of tools lying on the floor: that is where a fall leaves them. */
export function withoutFloorWarnings(wall: Wall, warnings: readonly WallWarning[]): WallWarning[] {
  const width = boardSizeMm(wall.board).width;
  const onFloor = new Set(wall.items.filter((item) => restsOnFloor(item, width)).map((i) => i.id));
  return warnings.filter(
    (warning) => warning.code !== 'out_of_board' || !warning.itemIds.every((id) => onFloor.has(id)),
  );
}
