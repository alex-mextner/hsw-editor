/**
 * HTTP + WebSocket surface of the omp bridge (mounted as a `ServerModule`, after the global loopback guard):
 *
 *   GET  /api/omp/ws?wall=<id>        WebSocket (envelope protocol in @hsw-editor/omp-protocol)
 *   GET  /api/omp/status              omp version, config, running sessions
 *   GET  /api/omp/sessions?wall=<id>  sessions stored for the wall (newest first)
 *   POST /api/omp/stop?wall=<id>      stop the wall's omp child; an attached page re-attaches (and so
 *                                     restarts omp) with its next message
 *
 * The global guard checks `Host` and `Origin`; this module additionally refuses non-loopback peers, so a
 * daemon accidentally bound to a LAN address never hands an agent shell to the network.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  type OmpClientMessage,
  type OmpServerMessage,
} from '@hsw-editor/omp-protocol';
import type { ModuleSocketData } from '../modules.ts';
import { publicConfig, sessionDirFor } from './config.ts';
import { isValidWallId, OmpCapacityError, type OmpHost } from './host.ts';
import { listSessionFiles } from './session-files.ts';
import type { OmpSession } from './session.ts';

export interface OmpSocketData extends ModuleSocketData {
  readonly module: 'omp';
  readonly wallId: string;
  readonly clientId: string;
}

function isOmpSocketData(data: ModuleSocketData): data is OmpSocketData {
  return data.module === 'omp' && 'wallId' in data && 'clientId' in data;
}

const LOOPBACK_PEERS: readonly string[] = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
/** A page that stops reading must not make the daemon buffer without bound. */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const WS_OPEN = 1;
const WS_CLOSE_INTERNAL_ERROR = 1011;
const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * Socket-level limits. Bun applies one set per server, so `server.ts` merges these into the daemon's
 * WebSocket handler; the backpressure limit sits above `MAX_BUFFERED_BYTES` so our own check closes slow
 * pages before Bun starts dropping frames.
 */
export const OMP_SOCKET_OPTIONS = {
  maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
  backpressureLimit: MAX_BUFFERED_BYTES * 2,
  idleTimeout: 120,
  sendPings: true,
} as const satisfies Partial<WebSocketHandler<ModuleSocketData>>;

function errorResponse(code: string, status: number): Response {
  return Response.json({ error: { code, message: code.replaceAll('_', ' ') } }, { status });
}

/**
 * Per-socket state. Every operation on a socket (attach, message, detach) runs through `tail`, so a
 * message sent while the attach is still waiting for capacity is neither dropped nor reordered, and a
 * close during that wait detaches the client the moment it is registered.
 */
interface ClientState {
  session: OmpSession | null;
  tail: Promise<void>;
  closed: boolean;
}

export interface OmpRoutes {
  /** Serves `/api/omp/*` (the module filters other paths); `undefined` after a successful WebSocket upgrade. */
  readonly handle: (
    request: Request,
    server: Server<ModuleSocketData>,
  ) => Promise<Response | undefined>;
  readonly websocket: WebSocketHandler<ModuleSocketData>;
}

export function createOmpRoutes(host: OmpHost): OmpRoutes {
  const clients = new Map<string, ClientState>();

  const send = (ws: ServerWebSocket<ModuleSocketData>, message: OmpServerMessage): void => {
    if (ws.readyState !== WS_OPEN) return;
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
      ws.close(WS_CLOSE_TRY_AGAIN_LATER, 'client too slow');
      return;
    }
    ws.send(JSON.stringify(message));
  };

  const enqueue = (state: ClientState, operation: () => Promise<void> | void): void => {
    state.tail = state.tail.then(operation).catch((cause: unknown) => {
      console.warn('[omp] socket operation failed:', cause);
    });
  };

  const attach = async (
    ws: ServerWebSocket<ModuleSocketData>,
    state: ClientState,
    { wallId, clientId }: OmpSocketData,
  ): Promise<void> => {
    state.session?.detach(clientId);
    state.session = null;
    try {
      state.session = await host.attach(wallId, {
        id: clientId,
        send: (message) => send(ws, message),
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      send(ws, { t: 'error', message });
      ws.close(
        cause instanceof OmpCapacityError ? WS_CLOSE_TRY_AGAIN_LATER : WS_CLOSE_INTERNAL_ERROR,
        message.slice(0, 120),
      );
    }
  };

  const deliver = async (
    ws: ServerWebSocket<ModuleSocketData>,
    state: ClientState,
    data: OmpSocketData,
    message: OmpClientMessage,
  ): Promise<void> => {
    if (state.closed) return;
    if (state.session === null || host.session(data.wallId) !== state.session) {
      // The session was stopped (stop button, idle eviction). Only a command for omp brings up a fresh
      // one: pings and answers to dialogs of the dead session must not undo the stop. A `restart` needs
      // nothing more (attaching starts the child); a command waits until the new child is ready.
      if (message.t !== 'rpc' && message.t !== 'restart') return;
      await attach(ws, state, data);
      if (message.t === 'restart') return;
      await state.session?.whenReady();
    }
    if (message.t === 'restart') {
      if (state.session === null) return;
      try {
        await host.restart(state.session);
      } catch (cause) {
        send(ws, { t: 'error', message: cause instanceof Error ? cause.message : String(cause) });
      }
      return;
    }
    state.session?.handleClientMessage(data.clientId, message);
  };

  const websocket: WebSocketHandler<ModuleSocketData> = {
    ...OMP_SOCKET_OPTIONS,
    open(ws) {
      if (!isOmpSocketData(ws.data)) return;
      const data = ws.data;
      const state: ClientState = { session: null, tail: Promise.resolve(), closed: false };
      clients.set(data.clientId, state);
      enqueue(state, () => attach(ws, state, data));
    },
    message(ws, raw) {
      if (!isOmpSocketData(ws.data)) return;
      const data = ws.data;
      const state = clients.get(data.clientId);
      if (state === undefined) return;
      if (typeof raw !== 'string') {
        send(ws, { t: 'error', message: 'binary frames are not supported' });
        return;
      }
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        send(ws, { t: 'error', message: parsed.error });
        return;
      }
      enqueue(state, () => deliver(ws, state, data, parsed.message));
    },
    close(ws) {
      if (!isOmpSocketData(ws.data)) return;
      const { clientId } = ws.data;
      const state = clients.get(clientId);
      if (state === undefined) return;
      clients.delete(clientId);
      state.closed = true;
      enqueue(state, () => state.session?.detach(clientId));
    },
  };

  const handle: OmpRoutes['handle'] = async (request, server) => {
    const url = new URL(request.url);
    const peer = server.requestIP(request)?.address;
    if (peer === undefined || !LOOPBACK_PEERS.includes(peer)) {
      return errorResponse('forbidden_peer', 403);
    }
    const wallId = url.searchParams.get('wall') ?? '';
    switch (url.pathname) {
      case '/api/omp/ws': {
        if (!isValidWallId(wallId)) return errorResponse('invalid_id', 400);
        const data: OmpSocketData = {
          module: 'omp',
          wallId,
          clientId: `c-${crypto.randomUUID()}`,
        };
        return server.upgrade(request, { data })
          ? undefined
          : new Response('WebSocket upgrade expected', { status: 426 });
      }
      case '/api/omp/status':
        return Response.json({
          ompVersion: (await host.ompVersion()) ?? null,
          config: publicConfig(host.config),
          sessions: host.statuses(),
        });
      case '/api/omp/sessions': {
        if (!isValidWallId(wallId)) return errorResponse('invalid_id', 400);
        const dir = host.session(wallId)?.sessionDir ?? sessionDirFor(host.config, wallId);
        return Response.json({ sessions: listSessionFiles(dir) });
      }
      case '/api/omp/stop': {
        if (request.method !== 'POST') return errorResponse('method_not_allowed', 405);
        if (!isValidWallId(wallId)) return errorResponse('invalid_id', 400);
        await host.session(wallId)?.stop('user');
        return Response.json({ ok: true });
      }
      default:
        return errorResponse('not_found', 404);
    }
  };

  return { handle, websocket };
}
