import { deflateSync } from 'node:zlib';
import { GLYPHS, GLYPH_H, GLYPH_W } from './font.ts';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode RGBA8 as PNG. */
export function encodePng(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Canvas {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export function newCanvas(
  width: number,
  height: number,
  fill: [number, number, number] = [236, 239, 243],
): Canvas {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = fill[0];
    rgba[i * 4 + 1] = fill[1];
    rgba[i * 4 + 2] = fill[2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

export function blit(dst: Canvas, src: Canvas, x0: number, y0: number): void {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (dy * dst.width + dx) * 4;
      const a = (src.rgba[s + 3] as number) / 255;
      for (let k = 0; k < 3; k++) {
        dst.rgba[d + k] = (src.rgba[s + k] as number) * a + (dst.rgba[d + k] as number) * (1 - a);
      }
      dst.rgba[d + 3] = 255;
    }
  }
}

/** Draw ASCII text with the embedded 6x12 bitmap font; `size` is an integer pixel multiplier. */
export function drawText(
  c: Canvas,
  text: string,
  x0: number,
  y0: number,
  color: [number, number, number] = [30, 34, 40],
  size = 1,
): void {
  let cx = x0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const g = code >= 32 && code <= 126 ? code - 32 : 63 - 32;
    for (let row = 0; row < GLYPH_H; row++) {
      const bits = GLYPHS[g * GLYPH_H + row] as number;
      for (let col = 0; col < GLYPH_W; col++) {
        if (!(bits & (1 << (GLYPH_W - 1 - col)))) continue;
        for (let sy = 0; sy < size; sy++) {
          for (let sx = 0; sx < size; sx++) {
            const px = cx + col * size + sx;
            const py = y0 + row * size + sy;
            if (px < 0 || py < 0 || px >= c.width || py >= c.height) continue;
            const o = (py * c.width + px) * 4;
            c.rgba[o] = color[0];
            c.rgba[o + 1] = color[1];
            c.rgba[o + 2] = color[2];
            c.rgba[o + 3] = 255;
          }
        }
      }
    }
    cx += GLYPH_W * size;
  }
}

export function textWidth(text: string, size = 1): number {
  return text.length * GLYPH_W * size;
}
