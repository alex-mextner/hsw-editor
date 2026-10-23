import { describe, expect, test } from 'bun:test';
import { exportGlb, generate, massPropertiesOfModel } from '@hsw-editor/tools';
import { readGlbSolid, readToolBody } from './glb.ts';

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('GLB reading', () => {
  test('a generated tool comes back as a rigid body with its mass, centre of gravity and hang point', async () => {
    const model = generate('tape-roll', {}, 1);
    const body = await readToolBody('tape', toBuffer(exportGlb(model)));
    const mass = massPropertiesOfModel(model);
    expect(body).not.toBeNull();
    if (body === null) return;
    expect(body.massG).toBeCloseTo(mass.massG, 2);
    expect(body.comMm[1]).toBeCloseTo(mass.comMm[1], 2);
    expect(body.hang?.kind).toBe(model.holding.hang?.kind);
    expect(body.hang?.diameterMm).toBeCloseTo(model.holding.hang?.diameterMm ?? 0, 3);
    expect(body.mesh.indices.length).toBeGreaterThan(300);
  });

  test('the soup is in the tool frame in millimetres', async () => {
    const model = generate('hammer', {}, 1);
    const solid = await readGlbSolid(toBuffer(exportGlb(model)));
    let maxY = -Infinity;
    for (let i = 1; i < solid.positions.length; i += 3)
      maxY = Math.max(maxY, solid.positions[i] ?? 0);
    expect(maxY).toBeCloseTo(model.bounds.max[1], 0);
  });
});
