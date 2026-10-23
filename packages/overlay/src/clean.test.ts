import { describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD } from '@hsw-editor/core';
import {
  boardExtent,
  calibrateTwoPoint,
  photoMapFromCalibration,
  toCoreCalibration,
} from './calibration.ts';
import {
  CLEAN_MARGIN_MM,
  boardFootprintPx,
  fillWall,
  footprintDrift,
  footprintSignature,
  materialDrift,
  matchGrain,
  reportPatch,
  transferDetail,
  maskArea,
  rasterisePolygon,
} from './clean.ts';

const image = { width: 1400, height: 1000 };
const extent = boardExtent(DEFAULT_BOARD);

function mapFor(a: [number, number], b: [number, number], realMm: number) {
  const calibration = toCoreCalibration(calibrateTwoPoint({ a, b, realMm }, image, extent));
  const map = photoMapFromCalibration(calibration, image, extent);
  if (!map) throw new Error('no map');
  return map;
}

describe('boardFootprintPx', () => {
  test('is the board plus the margin, four corners lower-left first', () => {
    const map = mapFor([100, 800], [900, 800], 800);
    const plain = boardFootprintPx(map, extent, 0);
    const padded = boardFootprintPx(map, extent);
    if (!plain || !padded) throw new Error('no footprint');
    expect(plain).toHaveLength(4);
    // 1 px = 1 mm here (800 px = 800 mm), so the margin shows as CLEAN_MARGIN_MM px on every side.
    expect(plain[2]?.[0]).toBeCloseTo((plain[0]?.[0] ?? 0) + extent.widthMm, 0);
    expect((plain[0]?.[0] ?? 0) - (padded[0]?.[0] ?? 0)).toBeCloseTo(CLEAN_MARGIN_MM, 0);
  });

  test('is null when a corner is beyond the horizon', () => {
    const map = mapFor([100, 800], [900, 800], 800);
    const broken = { ...map, wallToPx: () => null };
    expect(boardFootprintPx(broken, extent)).toBeNull();
  });
});

describe('footprintSignature / footprintDrift', () => {
  const square: [number, number][] = [
    [100, 100],
    [500, 100],
    [500, 400],
    [100, 400],
  ];

  test('the signature reads back as zero drift, and a small nudge stays below the material limit', () => {
    const signature = footprintSignature(square, image);
    expect(signature).toBe('1400x1000@12:100,100;500,100;500,400;100,400');
    expect(footprintDrift(signature, square, image)).toBe(0);
    const nudged = square.map(([x, y]) => [x + 4, y - 3] as [number, number]);
    expect(footprintDrift(signature, nudged, image)).toBeCloseTo(5, 5);
    expect(footprintDrift(signature, nudged, image)).toBeLessThan(materialDrift(image));
  });

  test('a real move is material', () => {
    const signature = footprintSignature(square, image);
    const moved = square.map(([x, y]) => [x + 80, y] as [number, number]);
    expect(footprintDrift(signature, moved, image)).toBeGreaterThan(materialDrift(image));
  });

  test('another photo size, another corner count, or garbage never counts as unchanged', () => {
    const signature = footprintSignature(square, image);
    expect(footprintDrift(signature, square, { width: 700, height: 500 })).toBe(Infinity);
    expect(footprintDrift(signature, square.slice(0, 3), image)).toBe(Infinity);
    expect(footprintDrift('nonsense', square, image)).toBe(Infinity);
    expect(footprintDrift('1400x1000:a,b;c,d;e,f;g,h', square, image)).toBe(Infinity);
    // A variant made with another margin (the old 30 mm one) is another footprint.
    expect(footprintDrift('1400x1000@30:100,100;500,100;500,400;100,400', square, image)).toBe(
      Infinity,
    );
  });
});

describe('rasterisePolygon', () => {
  test('fills the pixels whose centre is inside, a quad area matches', () => {
    const mask = rasterisePolygon(
      [
        [10, 10],
        [60, 10],
        [60, 40],
        [10, 40],
      ],
      100,
      80,
    );
    expect(maskArea(mask)).toBe(50 * 30);
    expect(mask[10 * 100 + 10]).toBe(1);
    expect(mask[9 * 100 + 10]).toBe(0);
    expect(mask[40 * 100 + 30]).toBe(0);
  });

  test('clips to the photo and ignores a degenerate polygon', () => {
    const mask = rasterisePolygon(
      [
        [-50, -50],
        [30, -50],
        [30, 30],
        [-50, 30],
      ],
      100,
      80,
    );
    expect(maskArea(mask)).toBe(30 * 30);
    expect(maskArea(rasterisePolygon([[1, 1]], 10, 10))).toBe(0);
  });
});

/** A wall with a smooth light gradient and fine grain, and a dark "old board" blob inside the area to clean. */
function syntheticWall(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 3);
  const truth = new Float32Array(width * height * 3);
  let state = 7;
  const grain = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296 - 0.5) * 4;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const base = 200 + 30 * (x / width) - 20 * (y / height);
      for (let c = 0; c < 3; c += 1) {
        const value = base - c * 6;
        truth[(y * width + x) * 3 + c] = value;
        data[(y * width + x) * 3 + c] = value + grain();
      }
    }
  }
  return { data, truth };
}

describe('fillWall', () => {
  const width = 300;
  const height = 200;
  const area: [number, number][] = [
    [90, 50],
    [210, 50],
    [210, 150],
    [90, 150],
  ];

  test('replaces clutter inside the mask with the wall around it', () => {
    const { data, truth } = syntheticWall(width, height);
    // The old board and its holes: a dark rectangle and bright dots inside the cleaned area.
    for (let y = 60; y < 140; y += 1) {
      for (let x = 100; x < 200; x += 1) {
        for (let c = 0; c < 3; c += 1) data[(y * width + x) * 3 + c] = (x + y) % 9 === 0 ? 30 : 235;
      }
    }
    const mask = rasterisePolygon(area, width, height);
    const filled = fillWall(data, width, height, 3, mask, { seed: 3 });
    let error = 0;
    let count = 0;
    for (let y = 60; y < 140; y += 1) {
      for (let x = 100; x < 200; x += 1) {
        for (let c = 0; c < 3; c += 1) {
          error += Math.abs(
            (filled[(y * width + x) * 3 + c] ?? 0) - (truth[(y * width + x) * 3 + c] ?? 0),
          );
          count += 1;
        }
      }
    }
    expect(error / count).toBeLessThan(4);
  });

  test('something coloured standing right at the mask edge does not tint the patch', () => {
    const { data } = syntheticWall(width, height);
    // A red box (a real thing: the red cardboard box beside the old board) against the right edge of the area.
    for (let y = 70; y < 130; y += 1) {
      for (let x = 210; x < 245; x += 1) {
        data[(y * width + x) * 3] = 225;
        data[(y * width + x) * 3 + 1] = 40;
        data[(y * width + x) * 3 + 2] = 40;
      }
    }
    const mask = rasterisePolygon(area, width, height);
    const filled = fillWall(data, width, height, 3, mask, { seed: 2 });
    let tint = 0;
    let count = 0;
    for (let y = 60; y < 140; y += 1) {
      for (let x = 100; x < 200; x += 1) {
        // The wall behind is neutral-ish (green 6 darker than red); the box would add tens of levels of red.
        tint += (filled[(y * width + x) * 3] ?? 0) - (filled[(y * width + x) * 3 + 1] ?? 0) - 6;
        count += 1;
      }
    }
    expect(Math.abs(tint / count)).toBeLessThan(5);
  });

  test('leaves the photo byte-identical away from the mask and keeps the input untouched', () => {
    const { data } = syntheticWall(width, height);
    const before = new Uint8ClampedArray(data);
    const mask = rasterisePolygon(area, width, height);
    const filled = fillWall(data, width, height, 3, mask);
    expect(data).toEqual(before);
    for (const [x, y] of [
      [5, 5],
      [280, 190],
      [20, 100],
      [250, 20],
    ] as const) {
      for (let c = 0; c < 3; c += 1) {
        expect(filled[(y * width + x) * 3 + c]).toBe(before[(y * width + x) * 3 + c]);
      }
    }
  });

  test('with an empty mask the result equals the input, and an alpha channel is kept', () => {
    const rgba = new Uint8ClampedArray(20 * 20 * 4).map((_, i) =>
      i % 4 === 3 ? 255 : (i * 7) % 256,
    );
    expect(fillWall(rgba, 20, 20, 4, new Uint8Array(400))).toEqual(rgba);
    const mask = rasterisePolygon(
      [
        [5, 5],
        [15, 5],
        [15, 15],
        [5, 15],
      ],
      20,
      20,
    );
    const filled = fillWall(rgba, 20, 20, 4, mask);
    for (let i = 3; i < filled.length; i += 4) expect(filled[i]).toBe(255);
  });

  test('is deterministic for a seed', () => {
    const { data } = syntheticWall(width, height);
    const mask = rasterisePolygon(area, width, height);
    expect(fillWall(data, width, height, 3, mask, { seed: 5 })).toEqual(
      fillWall(data, width, height, 3, mask, { seed: 5 }),
    );
  });

  test('a mask covering the whole photo still returns a plain colour, not NaN', () => {
    const { data } = syntheticWall(40, 30);
    const mask = new Uint8Array(40 * 30).fill(1);
    const filled = fillWall(data, 40, 30, 3, mask);
    expect(filled.every((value) => value >= 0 && value <= 255)).toBe(true);
  });
});

describe('transferDetail', () => {
  const w = 300;
  const h = 200;
  const area = rasterisePolygon(
    [
      [80, 50],
      [220, 50],
      [220, 150],
      [80, 150],
    ],
    w,
    h,
  );
  const wall = (value: (x: number, y: number) => number): Uint8Array => {
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1)
        data.fill(Math.round(value(x, y)), (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
    return data;
  };
  const at = (data: Uint8Array, x: number, y: number): number => data[(y * w + x) * 3] ?? -1;

  test('a flat patch of another colour becomes the wall: no tint, no band at the seam', () => {
    const reference = wall((x) => 200 + x / 30);
    const edited = new Uint8Array(reference);
    for (let i = 0; i < w * h; i += 1) if (area[i]) edited.fill(240, i * 3, i * 3 + 3);
    const out = transferDetail(edited, reference, area, w, h, 10);
    for (const [x, y] of [
      [82, 52],
      [150, 100],
      [218, 148],
      [85, 100],
    ] as const) {
      expect(Math.abs(at(out, x, y) - at(reference, x, y))).toBeLessThan(2);
    }
  });

  test("the fine structure the model painted rides on the wall's colour", () => {
    const reference = wall((x) => 200 + x / 30);
    const edited = new Uint8Array(reference);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (area[y * w + x])
          edited.fill(240 + ((x + y) % 2 === 0 ? 6 : -6), (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    const out = transferDetail(edited, reference, area, w, h, 10);
    const a = at(out, 150, 100);
    const b = at(out, 151, 100);
    expect(Math.abs(a - b)).toBeGreaterThan(8);
    expect(Math.abs((a + b) / 2 - at(reference, 150, 100))).toBeLessThan(3);
  });
});

describe('reportPatch / matchGrain', () => {
  const w = 400;
  const h = 300;
  const area = rasterisePolygon(
    [
      [120, 80],
      [280, 80],
      [280, 220],
      [120, 220],
    ],
    w,
    h,
  );

  function grainyWall(): Uint8Array {
    const data = new Uint8Array(w * h * 3);
    let state = 11;
    for (let i = 0; i < data.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[i] = Math.round(210 + (state / 4294967296 - 0.5) * 8);
    }
    return data;
  }

  function paint(data: Uint8Array, [r, g, b]: [number, number, number]): Uint8Array {
    const out = new Uint8Array(data);
    for (let i = 0; i < w * h; i += 1) {
      if (!area[i]) continue;
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    return out;
  }

  test('a flat patch in the wall colour is close in colour and has no grain', () => {
    const wall = grainyWall();
    const report = reportPatch(paint(wall, [210, 210, 210]), wall, wall, w, h, area);
    expect(report.colourOff).toBeLessThan(4);
    // Only the seam pixels (a flat patch next to grainy wall) read above zero.
    expect(report.patchGrain).toBeLessThan(0.05);
    expect(report.wallGrain).toBeGreaterThan(1.5);
  });

  test('a flat white patch is far off in colour', () => {
    const wall = grainyWall();
    expect(
      reportPatch(paint(wall, [255, 255, 255]), wall, wall, w, h, area).colourOff,
    ).toBeGreaterThan(30);
  });

  test('matchGrain gives a flat patch the grain of the wall, only inside the mask', () => {
    const wall = grainyWall();
    const flat = paint(wall, [210, 210, 210]);
    const before = reportPatch(flat, wall, wall, w, h, area);
    const grained = matchGrain(flat, w, h, area, before.patchGrain, before.wallGrain, 3);
    const after = reportPatch(grained, wall, wall, w, h, area);
    expect(Math.abs(after.patchGrain - before.wallGrain)).toBeLessThan(before.wallGrain * 0.15);
    // Outside the mask nothing moved.
    for (let i = 0; i < w * h; i += 97) if (!area[i]) expect(grained[i * 3]).toBe(flat[i * 3]);
  });

  test('a patch that is already as grainy as the wall is left alone', () => {
    const wall = grainyWall();
    const report = reportPatch(wall, wall, wall, w, h, area);
    expect(matchGrain(wall, w, h, area, report.patchGrain, report.wallGrain, 3)).toEqual(wall);
  });
});
