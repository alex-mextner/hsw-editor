/**
 * HTTP + WebSocket surface of the omp bridge (mounted as a `ServerModule`, after the global loopback guard):
 *
 *   GET  /api/omp/ws?wall=<id>        WebSocket (envelope protocol in @hsw-editor/omp-protocol)
 *   GET  /api/omp/status              omp version, config, running sessions
 *   GET  /api/omp/sessions?wall=<id>  sessions stored for the wall (newest first)
 *   POST /api/omp/stop?wall=<id>      stop the wall's omp child (it restarts on the next attach)
 *
 * The global guard checks `Host` and `Origin`; this module additionally refuses non-loopback peers, so a
 * daemon accidentally bound to a LAN address never hands an agent shell to the network.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  parseClientMessage,
  type OmpServerMessage,
} from '@hsw-editor/omp-protocol';
import type { ModuleSocketData } from '../modules.ts';
import { publicConfig } from './config.ts';
import { isValidWallId, OmpCapacityError, type OmpHost } from './host.ts';
import { listSessionFiles } from './session-files.ts';

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

function error(code: string, status: number): Response {
  return Response.json({ error: { code, message: code.replaceAll('_', ' ') } }, { status });
}

export interface OmpRoutes {
  /** `null` for paths this module does not own; `undefined` after a successful WebSocket upgrade. */
  readonly handle: (
    request: Request,
    server: Server<ModuleSocketData>,
  ) => Promise<Response | undefined | null>;
  readonly websocket: WebSocketHandler<ModuleSocketData>;
}

export function createOmpRoutes(host: OmpHost): OmpRoutes {
  let clientSeq = 0;

  const send = (ws: ServerWebSocket<ModuleSocketData>, message: OmpServerMessage): void => {
    if (ws.readyState !== 1) return;
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) {
      ws.close(1013, 'client too slow');
      return;
    }
    ws.send(JSON.stringify(message));
  };

  const websocket: WebSocketHandler<ModuleSocketData> = {
    maxPayloadLength: MAX_CLIENT_MESSAGE_BYTES,
    idleTimeout: 120,
    sendPings: true,
    async open(ws) {
      if (!isOmpSocketData(ws.data)) return;
      const { wallId, clientId } = ws.data;
      try {
        await host.attach(wallId, { id: clientId, send: (message) => send(ws, message) });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        send(ws, { t: 'error', message });
        ws.close(cause instanceof OmpCapacityError ? 1013 : 1011, message.slice(0, 120));
      }
    },
    message(ws, raw) {
      if (!isOmpSocketData(ws.data)) return;
      if (typeof raw !== 'string') {
        send(ws, { t: 'error', message: 'binary frames are not supported' });
        return;
      }
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        send(ws, { t: 'error', message: parsed.error });
        return;
      }
      host.session(ws.data.wallId)?.handleClientMessage(ws.data.clientId, parsed.message);
    },
    close(ws) {
      if (!isOmpSocketData(ws.data)) return;
      host.session(ws.data.wallId)?.detach(ws.data.clientId);
    },
  };

  const handle: OmpRoutes['handle'] = async (request, server) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/omp/')) return null;
    const peer = server.requestIP(request)?.address;
    if (peer !== undefined && !LOOPBACK_PEERS.includes(peer)) return error('forbidden_peer', 403);
    const wallId = url.searchParams.get('wall') ?? '';
    switch (url.pathname) {
      case '/api/omp/ws': {
        if (!isValidWallId(wallId)) return error('invalid_id', 400);
        clientSeq += 1;
        const data: OmpSocketData = {
          module: 'omp',
          wallId,
          clientId: `c${clientSeq}-${crypto.randomUUID()}`,
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
        if (!isValidWallId(wallId)) return error('invalid_id', 400);
        const dir = host.session(wallId)?.sessionDir ?? `${host.config.dataDir}/omp/${wallId}`;
        return Response.json({ sessions: listSessionFiles(dir) });
      }
      case '/api/omp/stop': {
        if (request.method !== 'POST') return error('method_not_allowed', 405);
        if (!isValidWallId(wallId)) return error('invalid_id', 400);
        await host.session(wallId)?.stop('evicted');
        return Response.json({ ok: true });
      }
      default:
        return error('not_found', 404);
    }
  };

  return { handle, websocket };
}
