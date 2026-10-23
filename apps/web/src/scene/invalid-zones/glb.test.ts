import { describe, expect, test } from 'bun:test';
import { readGlbSolid } from './glb.ts';

/** Minimal GLB: one triangle (counter-clockwise from +z) instanced by two nodes, the second mirrored in x. */
function twoTriangleGlb(): ArrayBuffer {
  const bin = new Uint8Array(44);
  const view = new DataView(bin.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, i) => view.setFloat32(i * 4, value, true));
  [0, 1, 2].forEach((value, i) => view.setUint16(36 + i * 2, value, true));
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 0, scale: [-1, 1, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 44 }],
  });
  const jsonBytes = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const head = new DataView(out.buffer);
  head.setUint32(0, 0x46546c67, true);
  head.setUint32(4, 2, true);
  head.setUint32(8, total, true);
  head.setUint32(12, jsonBytes.length, true);
  head.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const binAt = 20 + jsonBytes.length;
  head.setUint32(binAt, bin.length, true);
  head.setUint32(binAt + 4, 0x004e4942, true);
  out.set(bin, binAt + 8);
  return out.buffer;
}

describe('readGlbSolid', () => {
  test('a mirrored node keeps outward-facing triangles (winding flipped back)', async () => {
    const solid = await readGlbSolid(twoTriangleGlb());
    expect(solid.indices.length).toBe(6);
    const normalZ = (tri: number): number => {
      const p = (k: number): [number, number, number] => {
        const v = (solid.indices[tri * 3 + k] ?? 0) * 3;
        return [solid.positions[v] ?? 0, solid.positions[v + 1] ?? 0, solid.positions[v + 2] ?? 0];
      };
      const [a, b, c] = [p(0), p(1), p(2)];
      return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    };
    // the mirrored copy sits at x <= 0, yet its normal still points to +z like the plain one
    expect(normalZ(0)).toBeGreaterThan(0);
    expect(normalZ(1)).toBeGreaterThan(0);
    expect(Math.min(...Array.from(solid.positions).filter((_, i) => i % 3 === 0))).toBe(-1);
  });
});
