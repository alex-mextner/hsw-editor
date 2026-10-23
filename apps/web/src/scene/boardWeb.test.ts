import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD } from '@hsw-editor/core';
import { drawBoardWeb } from './boardWeb.ts';
import { CONTRAST_WEB, PLAIN_WEB } from './webContrast.ts';

const realPath2D = globalThis.Path2D;
afterEach(() => {
  globalThis.Path2D = realPath2D;
});

class FakePath2D {
  moveTo(): void {}
  lineTo(): void {}
  closePath(): void {}
}

function recorder(): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        (...args: unknown[]) => {
          calls.push(name === 'fill' || name === 'stroke' ? `${name}(${args.length})` : name);
        },
      set: (_target, name: string, value: unknown) => {
        if (name === 'globalCompositeOperation') calls.push(`op:${String(value)}`);
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('drawBoardWeb', () => {
  test('a plain style punches the holes and strokes nothing', () => {
    globalThis.Path2D = FakePath2D as unknown as typeof Path2D;
    const { ctx, calls } = recorder();
    drawBoardWeb(ctx, { ...DEFAULT_BOARD, cols: 2, rows: 2 }, PLAIN_WEB);
    expect(calls).toContain('fill(1)');
    expect(calls.some((call) => call.startsWith('stroke'))).toBe(false);
    expect(calls.at(-1)).toBe('op:source-over');
  });

  test('a contrast style strokes the holes and the border only where the plate is', () => {
    globalThis.Path2D = FakePath2D as unknown as typeof Path2D;
    const { ctx, calls } = recorder();
    drawBoardWeb(ctx, { ...DEFAULT_BOARD, cols: 2, rows: 2 }, CONTRAST_WEB);
    const atop = calls.indexOf('op:source-atop');
    expect(atop).toBeGreaterThan(calls.indexOf('fill(1)'));
    expect(calls.slice(atop)).toContain('stroke(1)');
    expect(calls.slice(atop)).toContain('strokeRect');
    expect(calls.at(-1)).toBe('op:source-over');
  });
});
