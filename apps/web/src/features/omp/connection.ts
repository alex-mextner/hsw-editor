/**
 * WebSocket client for `/api/omp/ws`: reconnects with backoff, correlates RPC commands with their
 * `response` frames, and hands every other server message to the store.
 */
import {
  parseServerMessage,
  type OmpClientMessage,
  type OmpResponseFrame,
  type OmpRpcCommand,
  type OmpServerMessage,
} from '@hsw-editor/omp-protocol';
import type { ConnectionPhase } from './render-types.ts';

/** An RPC command without its correlation id (the connection assigns one). */
export type RpcCommandInput = OmpRpcCommand extends infer C
  ? C extends OmpRpcCommand
    ? Omit<C, 'id'>
    : never
  : never;

export interface ConnectionHandlers {
  readonly onPhase: (phase: ConnectionPhase) => void;
  readonly onMessage: (message: OmpServerMessage) => void;
}

interface PendingRequest {
  readonly resolve: (response: OmpResponseFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 25_000;

export function ompWebSocketUrl(wallId: string): string {
  const { protocol, host } = globalThis.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/api/omp/ws?wall=${encodeURIComponent(wallId)}`;
}

export class OmpConnection {
  readonly #pending = new Map<string, PendingRequest>();
  #socket: WebSocket | null = null;
  #attempt = 0;
  #seq = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #closed = false;

  constructor(
    readonly wallId: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  open(): void {
    this.#closed = false;
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#pingTimer);
    this.#socket?.close(1000, 'panel closed');
    this.#socket = null;
    this.#rejectAll(new Error('connection closed'));
    this.handlers.onPhase('closed');
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  send(message: OmpClientMessage): boolean {
    if (!this.connected) return false;
    this.#socket?.send(JSON.stringify(message));
    return true;
  }

  /** Send an RPC command and resolve with its response frame (success or failure). */
  request(command: RpcCommandInput, timeoutMs = REQUEST_TIMEOUT_MS): Promise<OmpResponseFrame> {
    this.#seq += 1;
    const id = `r${this.#seq}`;
    return new Promise<OmpResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${command.type} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      // The id is the only field the input type omits.
      const sent = this.send({ t: 'rpc', command: { ...command, id } as OmpRpcCommand });
      if (!sent) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new Error('not connected'));
      }
    });
  }

  #connect(): void {
    this.handlers.onPhase(this.#attempt === 0 ? 'connecting' : 'reconnecting');
    const socket = new WebSocket(ompWebSocketUrl(this.wallId));
    this.#socket = socket;
    socket.onopen = () => {
      this.handlers.onPhase('live');
      clearInterval(this.#pingTimer);
      this.#pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_INTERVAL_MS);
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer | Blob>) => {
      if (typeof event.data !== 'string') return;
      const message = parseServerMessage(event.data);
      if (message === null) return;
      // Reset the backoff only once the server really attached us: it may accept the socket and close it
      // right away (child cap), which must keep backing off.
      if (message.t === 'snapshot') this.#attempt = 0;
      if (message.t === 'frame' && message.frame.type === 'response') {
        const frame = message.frame as OmpResponseFrame;
        const pending = frame.id === undefined ? undefined : this.#pending.get(frame.id);
        if (pending !== undefined && frame.id !== undefined) {
          this.#pending.delete(frame.id);
          clearTimeout(pending.timer);
          pending.resolve(frame);
          return;
        }
      }
      this.handlers.onMessage(message);
    };
    socket.onclose = () => {
      clearInterval(this.#pingTimer);
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#rejectAll(new Error('connection lost'));
      if (this.#closed) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.#attempt, RECONNECT_MAX_MS);
      this.#attempt += 1;
      this.handlers.onPhase('reconnecting');
      this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
    };
    socket.onerror = () => {
      // `onclose` follows and drives the reconnect.
    };
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}
