import { describe, expect, test } from 'bun:test';
import { buildPrototypeIndex, suggestClasses } from './fuse.ts';

const unit = (...v: number[]): number[] => {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

/** Three classes; CLIP space (dim 3) cannot tell a from b, DINOv2 space (dim 2) can. */
function index(withDino: boolean) {
  const clip = [...unit(1, 0.05, 0), ...unit(1, 0, 0.05), ...unit(0, 1, 1)];
  const dino = [...unit(1, 0), ...unit(0, 1), ...unit(1, 1)];
  return buildPrototypeIndex({
    dim: 3,
    classIds: ['a', 'b', 'c'],
    text: new Float32Array([...unit(1, 0, 0), ...unit(1, 0, 0), ...unit(0, 1, 0)]),
    protos: new Float32Array(clip),
    protoClassIds: ['a', 'b', 'c'],
    ...(withDino ? { dinoDim: 2, dinoProtos: new Float32Array(dino) } : {}),
  });
}

describe('suggestClasses with DINOv2 retrieval', () => {
  const crop = new Float32Array(unit(1, 0.02, 0.02));

  test('without a DINOv2 embedding (or index side) it is the CLIP-only fusion', () => {
    const plain = suggestClasses(index(false), crop);
    expect(plain[0]?.dino).toBeUndefined();
    const ignored = suggestClasses(index(true), crop);
    expect(ignored.map((s) => s.classId)).toEqual(plain.map((s) => s.classId));
    expect(ignored[0]?.dino).toBeUndefined();
  });

  test('the DINOv2 term breaks a tie CLIP cannot, and reports its probability', () => {
    const toB = suggestClasses(index(true), crop, {}, new Float32Array(unit(0, 1)));
    expect(toB[0]?.classId).toBe('b');
    expect(toB[0]?.dino).toBeGreaterThan(0.5);
    const toA = suggestClasses(index(true), crop, {}, new Float32Array(unit(1, 0)));
    expect(toA[0]?.classId).toBe('a');
    const sum = toB.reduce((s, x) => s + x.score, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  test('wd = 0 switches the term off even when the embedding is given', () => {
    const off = suggestClasses(index(true), crop, { wd: 0 }, new Float32Array(unit(0, 1)));
    expect(off[0]?.dino).toBeUndefined();
    const plain = suggestClasses(index(false), crop);
    expect(off.map((s) => s.score)).toEqual(plain.map((s) => s.score)); // exactly the CLIP-only fusion
  });
});
