import { describe, expect, test } from 'bun:test';
import { cellCenter, DEFAULT_BOARD } from '@hsw-editor/core';
import { homographyFromCamera } from './camera.ts';
import { inv3, type Vec2 } from './matrix.ts';
import { extentCorners, outlineToPx, poseToPx, pxToPosition, snapDrag } from './overlay.ts';
import { createPhotoMap, transformWallFrame } from './photo-map.ts';
import { IMG_4937_SIZE, img4937Camera, mulberry32, wallToPhoto } from './test-helpers.ts';

const board = DEFAULT_BOARD;
const camera = img4937Camera();
const map = createPhotoMap(inv3(homographyFromCamera(camera)), IMG_4937_SIZE);

function cellPx(col: number, row: number): Vec2 {
  const c = cellCenter(board, { col, row });
  return wallToPhoto(camera, [c.x, c.y]);
}

describe('pose <-> pixel', () => {
  test('round-trips both ways through the photo map', () => {
    const px = poseToPx(map, { x: 300, y: 400 })!;
    const back = pxToPosition(map, px)!;
    expect(back.x).toBeCloseTo(300, 9);
    expect(back.y).toBeCloseTo(400, 9);
    const px2 = poseToPx(map, back)!;
    expect(Math.hypot(px2[0] - px[0], px2[1] - px[1])).toBeLessThan(1e-9);
  });

  test('wall (0,0) of the test photo lands where the camera puts it', () => {
    const px = poseToPx(map, { x: 0, y: 0 })!;
    const truth = wallToPhoto(camera, [0, 0]);
    expect(Math.hypot(px[0] - truth[0], px[1] - truth[1])).toBeLessThan(1e-6);
  });

  test('a rotated outline is projected around the pose and rotZ turns it counter-clockwise on the wall', () => {
    const outline: Vec2[] = [
      [0, 0],
      [100, 0],
    ];
    const flat = outlineToPx(map, { x: 300, y: 400, rotZ: 0 }, outline)!;
    const turned = outlineToPx(map, { x: 300, y: 400, rotZ: 90 }, outline)!;
    const origin = map.pxToWall(turned[0]!)!;
    const tip = map.pxToWall(turned[1]!)!;
    // 90 degrees counter-clockwise (seen from the room): +x becomes +y on the wall
    expect(tip[0] - origin[0]).toBeCloseTo(0, 6);
    expect(tip[1] - origin[1]).toBeCloseTo(100, 6);
    expect(flat[0]).toEqual(turned[0]!);
  });

  test('extent corners are counter-clockwise from the lower-left', () => {
    expect(extentCorners({ minX: 0, maxX: 2, minY: 1, maxY: 3 })).toEqual([
      [0, 1],
      [2, 1],
      [2, 3],
      [0, 3],
    ]);
  });
});

describe('snapDrag on the real photo', () => {
  test('pointer over a cell snaps to it and the ghost sits on the cell in the photo', () => {
    const px = cellPx(14, 9);
    const drag = snapDrag(map, board, [px[0] + 2, px[1] - 2])!;
    expect(drag.snap.snapped?.cell).toEqual({ col: 14, row: 9 });
    expect(Math.hypot(drag.ghostCenterPx![0] - px[0], drag.ghostCenterPx![1] - px[1])).toBeLessThan(
      1e-6,
    );
    expect(drag.ghostOutlinePx).toHaveLength(4);
  });

  test('every pointer position within a third of the pitch of a cell centre snaps to that cell', () => {
    const random = mulberry32(21);
    for (let i = 0; i < 300; i++) {
      const col = 3 + Math.floor(random() * 40);
      const row = 3 + Math.floor(random() * 24);
      const c = cellCenter(board, { col, row });
      // offset in wall space, projected: robust to the perspective scale of the photo
      const target = wallToPhoto(camera, [
        c.x + (random() - 0.5) * board.colPitchMm * 0.6,
        c.y + (random() - 0.5) * board.rowPitchMm * 0.6,
      ]);
      const drag = snapDrag(map, board, target)!;
      expect(drag.snap.snapped?.cell).toEqual({ col, row });
    }
  });

  test('a grab offset keeps the item under the cursor instead of jumping to its centre', () => {
    const anchorPx = cellPx(14, 9);
    const anchorWall = cellCenter(board, { col: 14, row: 9 });
    const grabWall = map.pxToWall([anchorPx[0] + 15, anchorPx[1] + 15])!;
    const grabOffsetMm = { x: anchorWall.x - grabWall[0], y: anchorWall.y - grabWall[1] };
    // moving the pointer to the original grab spot again leaves the item on its own cell
    const drag = snapDrag(map, board, [anchorPx[0] + 15, anchorPx[1] + 15], { grabOffsetMm })!;
    expect(drag.snap.snapped?.cell).toEqual({ col: 14, row: 9 });
    expect(drag.snap.reason).toEqual({ code: 'exact' });
  });

  test('dragging outside the board keeps the item inside it', () => {
    const drag = snapDrag(map, board, [20, 1500])!;
    expect(drag.snap.snapped).not.toBeNull();
    expect(drag.snap.snapped!.cell.col).toBeGreaterThanOrEqual(0);
    expect(drag.snap.snapped!.cell.row).toBeGreaterThanOrEqual(0);
  });

  test('a pointer beyond the horizon yields no drag', () => {
    // w = 1 - x / 2000: the horizon is the vertical line x = 2000, outside the 1152 px wide photo
    const tilted = createPhotoMap([1, 0, 0, 0, 1, 0, -1 / 2000, 0, 1], IMG_4937_SIZE);
    expect(snapDrag(tilted, board, [10, 10])).not.toBeNull();
    expect(snapDrag(tilted, board, [2500, 10])).toBeNull();
  });
});

describe('wallToPx beyond the vanishing line of the plane', () => {
  test('a wall point behind the camera has no pixel instead of a mirrored one', () => {
    // photo -> wall: (x, y) / (1 - x / 2000). Wall -> photo: (X, Y) / (1 + X / 2000): X < -2000 is behind the camera.
    const tilted = createPhotoMap([1, 0, 0, 0, 1, 0, -1 / 2000, 0, 1], IMG_4937_SIZE);
    expect(tilted.wallToPx([4000, 100])).not.toBeNull();
    expect(tilted.wallToPx([-4000, 100])).toBeNull();
    expect(tilted.wallToPx([-1000, 100])).not.toBeNull();
  });
});

describe('transformWallFrame', () => {
  const base = createPhotoMap([0.5, 0, 0, 0, -0.5, 0, 0, 0, 1], IMG_4937_SIZE);

  test('shifts the wall frame without changing the scale', () => {
    const shifted = createPhotoMap(
      transformWallFrame(base.pxToWallMatrix, { dxMm: 30, dyMm: -10 }),
      IMG_4937_SIZE,
    );
    const a = base.pxToWall([100, 100])!;
    const b = shifted.pxToWall([100, 100])!;
    expect(b[0] - a[0]).toBeCloseTo(30, 9);
    expect(b[1] - a[1]).toBeCloseTo(-10, 9);
    expect(shifted.centerScaleMmPerPx).toBeCloseTo(base.centerScaleMmPerPx, 12);
  });

  test('rotates about a wall point, keeping that point fixed', () => {
    const turned = createPhotoMap(
      transformWallFrame(base.pxToWallMatrix, { rollDeg: 30, about: [50, 50] }),
      IMG_4937_SIZE,
    );
    const px = base.wallToPx([50, 50])!;
    const fixed = turned.pxToWall(px)!;
    expect(fixed[0]).toBeCloseTo(50, 9);
    expect(fixed[1]).toBeCloseTo(50, 9);
    expect(turned.centerScaleMmPerPx).toBeCloseTo(base.centerScaleMmPerPx, 12);
  });
});
