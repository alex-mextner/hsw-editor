/**
 * Framing for the omp rpc stdout stream: newline-delimited JSON, plus protocol v2 `rpc_chunk`
 * reassembly (omp://rpc.md "Transport and Framing"). Chunks are decoded here, never in the browser.
 */

/**
 * Splits a byte stream into complete UTF-8 lines. Bytes are buffered (never string-concatenated per chunk),
 * so a huge line costs one copy when its newline arrives. A line over the cap is dropped: `onOverflow`
 * fires once, the splitter discards bytes up to the next newline and carries on, and the complete lines
 * around it are still returned.
 */
export class LineSplitter {
  readonly #decoder = new TextDecoder('utf-8');
  #parts: Uint8Array[] = [];
  #partialBytes = 0;
  #discarding = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onOverflow: (maxLineBytes: number) => void,
  ) {}

  /** Returns the complete non-empty lines in `chunk`. */
  push(chunk: Uint8Array): string[] {
    const lines: string[] = [];
    let start = 0;
    if (this.#discarding) {
      const newline = chunk.indexOf(10);
      if (newline === -1) return lines;
      this.#discarding = false;
      start = newline + 1;
    }
    for (
      let newline = chunk.indexOf(10, start);
      newline !== -1;
      newline = chunk.indexOf(10, start)
    ) {
      const line = this.#take(chunk.subarray(start, newline)).trimEnd();
      if (line.length > 0) lines.push(line);
      start = newline + 1;
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0) {
      this.#parts.push(rest);
      this.#partialBytes += rest.length;
      if (this.#partialBytes > this.maxLineBytes) {
        this.#reset();
        this.#discarding = true;
        this.onOverflow(this.maxLineBytes);
      }
    }
    return lines;
  }

  #reset(): void {
    this.#parts = [];
    this.#partialBytes = 0;
  }

  #take(tail: Uint8Array): string {
    if (this.#partialBytes + tail.length > this.maxLineBytes) {
      this.#reset();
      this.onOverflow(this.maxLineBytes);
      return '';
    }
    if (this.#parts.length === 0) return this.#decoder.decode(tail);
    const joined = Buffer.concat([...this.#parts, tail]);
    this.#reset();
    return this.#decoder.decode(joined);
  }
}

export interface ChunkFrame {
  readonly type: 'rpc_chunk';
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: string;
}

export function isChunkFrame(value: { readonly type?: string }): value is ChunkFrame {
  return value.type === 'rpc_chunk';
}

export type ChunkResult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Reassembles one logical frame at a time. Mirrors omp's `RpcFrameDecoder`: chunks must arrive as an
 * uninterrupted, in-order sequence with consistent `chunkId`/`count`/`byteLength`; the total is capped
 * and the joined bytes must be strict UTF-8 of exactly `byteLength` bytes.
 */
export class ChunkAssembler {
  #chunkId: string | null = null;
  #count = 0;
  #byteLength = 0;
  #next = 0;
  #parts: Uint8Array[] = [];
  #received = 0;

  constructor(private readonly maxReassembledBytes: number) {}

  /** True while a multi-chunk frame is half-received (any other frame type in between is an error). */
  get inProgress(): boolean {
    return this.#chunkId !== null;
  }

  /** Call for any non-chunk frame: an interleaved frame invalidates the sequence in progress. */
  interrupt(): ChunkResult | null {
    if (this.#chunkId === null) return null;
    this.#reset();
    return { kind: 'error', message: 'rpc_chunk sequence interrupted by another frame' };
  }

  push(frame: ChunkFrame): ChunkResult {
    const { chunkId, index, count, byteLength, data } = frame;
    if (
      typeof chunkId !== 'string' ||
      !Number.isInteger(index) ||
      !Number.isInteger(count) ||
      !Number.isInteger(byteLength) ||
      typeof data !== 'string' ||
      count < 1 ||
      byteLength < 0
    ) {
      this.#reset();
      return { kind: 'error', message: 'malformed rpc_chunk' };
    }
    if (byteLength > this.maxReassembledBytes) {
      this.#reset();
      return {
        kind: 'error',
        message: `rpc_chunk frame of ${byteLength} bytes exceeds the reassembly limit`,
      };
    }
    if (this.#chunkId === null) {
      if (index !== 0)
        return { kind: 'error', message: 'rpc_chunk sequence did not start at index 0' };
      this.#chunkId = chunkId;
      this.#count = count;
      this.#byteLength = byteLength;
      this.#next = 0;
      this.#parts = [];
      this.#received = 0;
    }
    if (
      chunkId !== this.#chunkId ||
      count !== this.#count ||
      byteLength !== this.#byteLength ||
      index !== this.#next
    ) {
      this.#reset();
      return { kind: 'error', message: 'rpc_chunk sequence is inconsistent or out of order' };
    }
    const bytes = Buffer.from(data, 'base64');
    this.#received += bytes.byteLength;
    if (this.#received > this.#byteLength) {
      this.#reset();
      return { kind: 'error', message: 'rpc_chunk data exceeds the declared byteLength' };
    }
    this.#parts.push(bytes);
    this.#next += 1;
    if (this.#next < this.#count) return { kind: 'pending' };
    const joined = Buffer.concat(this.#parts);
    const declared = this.#byteLength;
    this.#reset();
    if (joined.byteLength !== declared) {
      return { kind: 'error', message: 'rpc_chunk total length does not match byteLength' };
    }
    try {
      return { kind: 'complete', text: new TextDecoder('utf-8', { fatal: true }).decode(joined) };
    } catch {
      return { kind: 'error', message: 'rpc_chunk payload is not valid UTF-8' };
    }
  }

  #reset(): void {
    this.#chunkId = null;
    this.#parts = [];
    this.#received = 0;
    this.#next = 0;
  }
}
