import { describe, expect, test } from 'bun:test';
import { ChunkAssembler, LineSplitter, type ChunkFrame } from './frame.ts';

const encoder = new TextEncoder();

function chunkFrames(text: string, size: number, chunkId = 'c1'): ChunkFrame[] {
  const bytes = Buffer.from(text, 'utf8');
  const count = Math.ceil(bytes.length / size);
  return Array.from({ length: count }, (_, index) => ({
    type: 'rpc_chunk',
    chunkId,
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString('base64'),
  }));
}

function frameAt(frames: readonly ChunkFrame[], index: number): ChunkFrame {
  const frame = frames[index];
  if (frame === undefined) throw new Error(`no frame ${index}`);
  return frame;
}

describe('LineSplitter', () => {
  test('keeps a partial line until its newline arrives', () => {
    const splitter = new LineSplitter(1000, () => undefined);
    expect(splitter.push(encoder.encode('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
    expect(splitter.push(encoder.encode(':2}\n\n'))).toEqual(['{"b":2}']);
  });

  test('does not corrupt a multi-byte character split across chunks', () => {
    const splitter = new LineSplitter(1000, () => undefined);
    const bytes = encoder.encode('{"t":"стена 🧱"}\n');
    const cut = bytes.indexOf(0xd1) + 1; // between the two bytes of "с"
    expect(splitter.push(bytes.subarray(0, cut))).toEqual([]);
    expect(splitter.push(bytes.subarray(cut))).toEqual(['{"t":"стена 🧱"}']);
  });

  test('drops a line that outgrows the cap, keeps the lines around it and resumes after its newline', () => {
    const overflows: number[] = [];
    const splitter = new LineSplitter(10, (limit) => overflows.push(limit));
    expect(splitter.push(encoder.encode('ok\n' + 'x'.repeat(11)))).toEqual(['ok']);
    expect(overflows).toEqual([10]);
    expect(splitter.push(encoder.encode('yyyy'))).toEqual([]);
    expect(splitter.push(encoder.encode('zz\nnext\n'))).toEqual(['next']);
    expect(overflows).toEqual([10]);
  });
});

describe('ChunkAssembler', () => {
  test('reassembles an in-order sequence, including multi-byte text split mid-character', () => {
    const text = JSON.stringify({ type: 'response', data: 'стена'.repeat(500) });
    const assembler = new ChunkAssembler(1 << 20);
    const results = chunkFrames(text, 7).map((frame) => assembler.push(frame));
    expect(results.slice(0, -1).every((result) => result.kind === 'pending')).toBe(true);
    expect(results.at(-1)).toEqual({ kind: 'complete', text });
    expect(assembler.inProgress).toBe(false);
  });

  test('an interleaved frame invalidates the sequence in progress', () => {
    const assembler = new ChunkAssembler(1 << 20);
    assembler.push(frameAt(chunkFrames('abcdefghij', 4), 0));
    expect(assembler.interrupt()?.kind).toBe('error');
    expect(assembler.inProgress).toBe(false);
  });

  test('rejects out-of-order, inconsistent and oversized sequences', () => {
    const frames = chunkFrames('abcdefghij', 4);
    const outOfOrder = new ChunkAssembler(1 << 20);
    outOfOrder.push(frameAt(frames, 0));
    expect(outOfOrder.push(frameAt(frames, 2)).kind).toBe('error');

    const inconsistent = new ChunkAssembler(1 << 20);
    inconsistent.push(frameAt(frames, 0));
    expect(inconsistent.push({ ...frameAt(frames, 1), chunkId: 'other' }).kind).toBe('error');

    expect(new ChunkAssembler(5).push(frameAt(frames, 0)).kind).toBe('error');
  });

  test('rejects a payload whose joined bytes disagree with byteLength or are not UTF-8', () => {
    const lying = new ChunkAssembler(1 << 20);
    expect(
      lying.push({
        type: 'rpc_chunk',
        chunkId: 'x',
        index: 0,
        count: 1,
        byteLength: 99,
        data: Buffer.from('abc').toString('base64'),
      }).kind,
    ).toBe('error');
    const invalid = new ChunkAssembler(1 << 20);
    expect(
      invalid.push({
        type: 'rpc_chunk',
        chunkId: 'y',
        index: 0,
        count: 1,
        byteLength: 2,
        data: Buffer.from([0xff, 0xfe]).toString('base64'),
      }),
    ).toEqual({ kind: 'error', message: 'rpc_chunk payload is not valid UTF-8' });
  });
});
