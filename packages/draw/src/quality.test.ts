import { describe, expect, test } from 'bun:test';
import { type QualityIssueCode, type RawImage, analyzeImage } from './quality.ts';

type Paint = (x: number, y: number) => [number, number, number] | null;

function render(width: number, height: number, paint: Paint, background = 255): RawImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y) ?? [background, background, background];
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const BLUE: [number, number, number] = [30, 60, 160];
const rect =
  (x0: number, y0: number, x1: number, y1: number): Paint =>
  (x, y) =>
    x >= x0 && x < x1 && y >= y0 && y < y1 ? BLUE : null;

const codes = (issues: readonly { code: QualityIssueCode }[]) => issues.map((i) => i.code);
const expectSquare = { aspect: 1 };

describe('analyzeImage', () => {
  test('accepts a centred object on pure white', () => {
    const report = analyzeImage(render(400, 400, rect(120, 80, 280, 320)), expectSquare);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.metrics.objectAspect).toBeCloseTo(160 / 240, 2);
  });

  test('rejects a non-white (gray) background', () => {
    const report = analyzeImage(render(400, 400, rect(120, 80, 280, 320), 200), expectSquare);
    expect(codes(report.issues)).toContain('background_not_white');
    expect(report.ok).toBe(false);
  });

  test('rejects an object cut by the frame', () => {
    const report = analyzeImage(render(400, 400, rect(120, 80, 280, 400)), expectSquare);
    expect(codes(report.issues)).toContain('object_cut');
  });

  test('rejects an empty white canvas', () => {
    const report = analyzeImage(
      render(400, 400, () => null),
      expectSquare,
    );
    expect(codes(report.issues)).toEqual(['object_missing']);
  });

  test('rejects a canvas whose aspect differs from the requested size', () => {
    const report = analyzeImage(render(400, 300, rect(120, 60, 280, 240)), expectSquare);
    expect(codes(report.issues)).toContain('aspect_mismatch');
  });

  test('rejects a soft ground shadow under the object', () => {
    const shadow: Paint = (x, y) => {
      const inObject = rect(140, 80, 260, 280)(x, y);
      if (inObject) return inObject;
      const dx = (x - 200) / 110;
      const dy = (y - 300) / 22;
      return dx * dx + dy * dy < 1 ? [205, 205, 205] : null;
    };
    const report = analyzeImage(render(400, 400, shadow), expectSquare);
    expect(codes(report.issues)).toContain('shadow');
  });

  test('anti-aliased object edges are not mistaken for a shadow', () => {
    const soft: Paint = (x, y) => {
      const inner = rect(140, 80, 260, 320)(x, y);
      if (inner) return inner;
      const ring = rect(138, 78, 262, 322)(x, y);
      return ring ? [200, 205, 220] : null;
    };
    expect(analyzeImage(render(400, 400, soft), expectSquare).ok).toBe(true);
  });

  test('flags converging straight edges as perspective (warning by default, reject when strict)', () => {
    const trapezoid: Paint = (x, y) => {
      if (y < 80 || y >= 320) return null;
      const half = 40 + ((y - 80) / 240) * 90; // narrow top, wide bottom
      return Math.abs(x - 200) < half ? BLUE : null;
    };
    const image = render(400, 400, trapezoid);
    const lax = analyzeImage(image, expectSquare);
    expect(lax.issues.find((i) => i.code === 'perspective')?.severity).toBe('warn');
    expect(lax.ok).toBe(true);
    expect(analyzeImage(image, { ...expectSquare, strictPerspective: true }).ok).toBe(false);
  });

  test('a straight-sided box has no perspective issue', () => {
    const report = analyzeImage(render(400, 400, rect(120, 80, 280, 320)), expectSquare);
    expect(codes(report.issues)).toEqual([]);
  });

  test('rejects an object whose silhouette proportions contradict the fit', () => {
    const report = analyzeImage(render(400, 400, rect(60, 150, 340, 250)), {
      aspect: 1,
      objectAspect: 0.5,
    });
    expect(codes(report.issues)).toContain('proportion_mismatch');
  });

  test('composites transparent pixels over white', () => {
    const image = render(400, 400, rect(120, 80, 280, 320));
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i] === 255) image.data[i + 3] = 0; // transparent background
    }
    expect(analyzeImage(image, expectSquare).ok).toBe(true);
  });
});
