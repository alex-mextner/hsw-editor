/**
 * One `omp --mode rpc-ui` child process: JSONL framing (v1 lines, v2 chunks), request/response
 * correlation by id, stderr capture, and graceful close (stdin EOF, then SIGTERM, then SIGKILL).
 */
import {
  isKnownFrame,
  parseOmpFrame,
  type JsonValue,
  type OmpFrame,
  type OmpResponseFrame,
  type OmpUnknownFrame,
} from '@hsw-editor/omp-protocol';
import { ChunkAssembler, isChunkFrame, LineSplitter, type ChunkFrame } from './frame.ts';

export interface ChildSpawnOptions {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export type ChildFrame = OmpFrame | OmpUnknownFrame;

export interface ChildHandlers {
  /** Every decoded frame, in stdout order (responses included). */
  readonly onFrame: (frame: ChildFrame) => void;
  /** Transport-level problems (bad chunk, oversized line) that do not end the child. */
  readonly onProtocolError: (message: string) => void;
  readonly onExit: (exit: { readonly code: number | null; readonly signal: string | null }) => void;
}

interface PendingRequest {
  readonly resolve: (frame: OmpResponseFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly sync: ((frame: OmpResponseFrame) => void) | undefined;
}

export interface RequestOptions {
  readonly timeoutMs?: number;
  /** Runs inside the stdout loop, before any later frame is processed: use it to snapshot state atomically. */
  readonly sync?: (frame: OmpResponseFrame) => void;
}

const MAX_LINE_CHARS = 72 * 1024 * 1024;
const STDERR_TAIL_LINES = 40;
const STDERR_LINE_CAP = 4096;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class OmpChild {
  readonly #proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #stderrTail: string[] = [];
  readonly #exited: Promise<void>;
  #assembler: ChunkAssembler | null = null;
  #seq = 0;
  #closed = false;

  private constructor(
    proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>,
    private readonly handlers: ChildHandlers,
  ) {
    this.#proc = proc;
    void this.#readStdout();
    void this.#readStderr();
    this.#exited = proc.exited.then((code) => {
      this.#failPending(new Error('omp exited'));
      handlers.onExit({ code: proc.exitCode ?? code, signal: proc.signalCode });
    });
  }

  static spawn(options: ChildSpawnOptions, handlers: ChildHandlers): OmpChild {
    const [bin, ...args] = options.command;
    if (bin === undefined) throw new Error('empty omp command');
    const proc = Bun.spawn([bin, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return new OmpChild(proc, handlers);
  }

  get pid(): number {
    return this.#proc.pid;
  }

  get stderrTail(): readonly string[] {
    return this.#stderrTail;
  }

  /** Enable v2 chunk reassembly; call right after the `negotiate_protocol` response succeeded. */
  enableChunks(maxReassembledBytes: number): void {
    this.#assembler = new ChunkAssembler(maxReassembledBytes);
  }

  /** Write one JSON object as a line to the child's stdin. */
  send(message: object): void {
    if (this.#closed) return;
    this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
    void this.#proc.stdin.flush();
  }

  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq}`;
  }

  /** Send a command and await its `response` frame (success or failure). */
  request(
    command: { readonly type: string } & { readonly [key: string]: JsonValue | undefined },
    options: RequestOptions = {},
  ): Promise<OmpResponseFrame> {
    const id = typeof command['id'] === 'string' ? command['id'] : this.nextId('srv');
    return new Promise<OmpResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`omp command ${command.type} timed out`));
      }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer, sync: options.sync });
      this.send({ ...command, id });
    });
  }

  /** Close stdin (omp finishes the current work and exits 0), escalating if it does not. */
  async close(graceMs = 4000): Promise<void> {
    if (this.#closed) {
      await this.#exited;
      return;
    }
    this.#closed = true;
    try {
      await this.#proc.stdin.end();
    } catch {
      // Already closed by an exiting child.
    }
    const term = setTimeout(() => this.#proc.kill('SIGTERM'), graceMs);
    const kill = setTimeout(() => this.#proc.kill('SIGKILL'), graceMs * 2);
    await this.#exited;
    clearTimeout(term);
    clearTimeout(kill);
  }

  /** Synchronous best-effort kill for process-exit hooks. */
  killNow(): void {
    this.#closed = true;
    this.#proc.kill('SIGTERM');
  }

  #failPending(error: Error): void {
    for (const [id, request] of this.#pending) {
      clearTimeout(request.timer);
      request.reject(error);
      this.#pending.delete(id);
    }
  }

  #dispatch(text: string): void {
    const frame = parseOmpFrame(text);
    if (frame === null) {
      this.handlers.onProtocolError('omp emitted a line that is not a JSON frame');
      return;
    }
    if (isChunkFrame(frame)) {
      const assembler = this.#assembler;
      if (assembler === null) {
        this.handlers.onProtocolError('rpc_chunk received before protocol v2 was negotiated');
        return;
      }
      const result = assembler.push(frame as unknown as ChunkFrame);
      if (result.kind === 'complete') this.#dispatch(result.text);
      else if (result.kind === 'error') this.handlers.onProtocolError(result.message);
      return;
    }
    const interrupted = this.#assembler?.interrupt();
    if (interrupted?.kind === 'error') this.handlers.onProtocolError(interrupted.message);
    if (isKnownFrame(frame) && frame.type === 'response' && frame.id !== undefined) {
      const request = this.#pending.get(frame.id);
      if (request !== undefined) {
        this.#pending.delete(frame.id);
        clearTimeout(request.timer);
        request.sync?.(frame);
        request.resolve(frame);
      }
    }
    this.handlers.onFrame(frame);
  }

  async #readStdout(): Promise<void> {
    let splitter = new LineSplitter(MAX_LINE_CHARS);
    try {
      for await (const chunk of this.#proc.stdout) {
        try {
          for (const line of splitter.push(chunk)) this.#dispatch(line);
        } catch (error) {
          // An oversized line is dropped; keep draining stdout so the child never blocks on a full pipe.
          this.handlers.onProtocolError(error instanceof Error ? error.message : String(error));
          splitter = new LineSplitter(MAX_LINE_CHARS);
        }
      }
    } catch (error) {
      this.handlers.onProtocolError(error instanceof Error ? error.message : String(error));
    }
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    for await (const chunk of this.#proc.stderr) {
      pending += decoder.decode(chunk, { stream: true });
      // Progress bars use \r; a runaway line keeps only its tail so memory stays bounded.
      const lines = pending.split(/[\r\n]/);
      pending = (lines.pop() ?? '').slice(-STDERR_LINE_CAP);
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        this.#stderrTail.push(line.slice(0, 500));
        if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift();
      }
    }
  }
}
