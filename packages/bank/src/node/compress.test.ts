import { describe, expect, test } from 'bun:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { compressGlb, LOD1_MIN_TRIANGLES } from './compress.ts';

/** A flat n x n grid of unit-spaced vertices (mm) with a bump, as a plain GLB. */
async function gridGlb(n: number, spacing: number): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions = new Float32Array(n * n * 3);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 3;
      positions.set([x * spacing, y * spacing, Math.sin(x / 3) * Math.cos(y / 3) * 2 + 5], i);
    }
  }
  const indices = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const a = y * n + x;
      indices.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], k);
      k += 6;
    }
  }
  const primitive = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer),
    )
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  const mesh = doc.createMesh().addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

async function readCompressed(bytes: Uint8Array): Promise<Document> {
  await MeshoptDecoder.ready;
  return new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
    .readBinary(bytes);
}

describe('compressGlb', () => {
  test('keeps millimetre bounds within quantisation error and builds a lighter LOD1 for dense meshes', async () => {
    const plain = await gridGlb(40, 5); // 3042 triangles, 195 x 195 mm
    const result = await compressGlb(plain);
    expect(result.trianglesLod0).toBeGreaterThan(LOD1_MIN_TRIANGLES);
    expect(result.trianglesLod1).toBeLessThan(result.trianglesLod0 / 2);
    expect(result.lod1.length).toBeLessThan(result.lod0.length);
    const doc = await readCompressed(result.lod0);
    const scene = doc.getRoot().listScenes()[0];
    if (!scene) throw new Error('no scene');
    const { min, max } = getBounds(scene);
    expect(min[0]).toBeCloseTo(0, 1);
    expect(max[0]).toBeCloseTo(195, 1);
    expect(max[1]).toBeCloseTo(195, 1);
    expect(max[2] - min[2]).toBeGreaterThan(3);
  });

  test('small meshes share one file for both LODs', async () => {
    const result = await compressGlb(await gridGlb(6, 5));
    expect(result.trianglesLod1).toBe(result.trianglesLod0);
    expect(result.lod1).toBe(result.lod0);
  });
});
