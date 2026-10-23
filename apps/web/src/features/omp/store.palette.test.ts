/**
 * The omp store as the palette's transport: `ui_call`s with method `app_command` reach the registered
 * handler and are answered over the same socket, `ui_cancel` and a lost connection abort them, and the
 * palette's `prompt` goes out as an ordinary rpc command. A scripted WebSocket stands in for the server.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { AppCommandResult, AppCommandToolArgs } from '@hsw-editor/commands';
import type { OmpFrame, OmpServerMessage } from '@hsw-editor/omp-protocol';
import { statusOf, type AppCommandHandler } from './paletteBridge.ts';
import { omp } from './store.ts';

class FakeSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeSocket[] = [];
  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
  }

  receive(message: OmpServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

/** The test files of a run share one process: put back what this file replaces. */
const REPLACED_GLOBALS = ['WebSocket', 'location'] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  for (const name of REPLACED_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeSocket, configurable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'http:', host: 'editor.test' },
    configurable: true,
  });
});

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
});

const handlers: (() => void)[] = [];

/** Registers a handler for the test; it is gone before the next one (the store is a singleton). */
function install(handler: AppCommandHandler): () => void {
  const dispose = omp.palette.setAppCommandHandler(handler);
  handlers.push(dispose);
  return dispose;
}

afterEach(() => {
  for (const dispose of handlers.splice(0)) dispose();
  omp.connect(null);
  FakeSocket.instances.length = 0;
});

/** Connects the store to a wall and returns the scripted socket the connection opened. */
function connect(): FakeSocket {
  omp.connect('w1');
  const socket = FakeSocket.instances.at(-1);
  if (socket === undefined) throw new Error('no socket was opened');
  socket.onopen?.();
  return socket;
}

/** Id of the rpc command a socket sent (the connection assigns it). */
function sentCommandId(frame: Record<string, unknown> | undefined): string {
  const command = frame?.['command'];
  if (typeof command === 'object' && command !== null && 'id' in command) {
    const { id } = command;
    if (typeof id === 'string') return id;
  }
  throw new Error('the socket sent no rpc command');
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const call = (id: string, params: AppCommandToolArgs): OmpServerMessage => ({
  t: 'ui_call',
  id,
  call: { method: 'app_command', params },
});

const undone: AppCommandResult = { ok: true, op: 'run', id: 'edit.undo', value: null };

describe('app_command ui_calls', () => {
  test('are run by the registered handler and answered with ui_result on the same socket', async () => {
    const socket = connect();
    const seen: { request: unknown; aborted: boolean | undefined }[] = [];
    install(async (request, signal) => {
      seen.push({ request, aborted: signal?.aborted });
      return undone;
    });
    socket.receive(call('vp-1', { op: 'run', id: 'edit.undo' }));
    await flush();
    expect(seen).toEqual([{ request: { op: 'run', id: 'edit.undo' }, aborted: false }]);
    expect(socket.sent).toEqual([{ t: 'ui_result', id: 'vp-1', ok: true, result: undone }]);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('a throwing handler answers with an error instead of leaving the agent waiting', async () => {
    const socket = connect();
    install(async () => {
      throw new Error('registry exploded');
    });
    socket.receive(call('vp-2', { op: 'list' }));
    await flush();
    expect(socket.sent).toEqual([
      { t: 'ui_result', id: 'vp-2', ok: false, error: 'registry exploded' },
    ]);
  });

  test('without a handler the page says the palette is not available', async () => {
    const socket = connect();
    socket.receive(call('vp-3', { op: 'list' }));
    await flush();
    expect(socket.sent).toEqual([
      {
        t: 'ui_result',
        id: 'vp-3',
        ok: false,
        error: 'the command palette is not available in this window',
      },
    ]);
  });

  test('a disposed handler is no longer called', async () => {
    const socket = connect();
    const dispose = install(async () => undone);
    dispose();
    socket.receive(call('vp-4', { op: 'list' }));
    await flush();
    expect(socket.sent[0]).toMatchObject({ ok: false });
  });

  test('ui_cancel aborts the signal of exactly that call', async () => {
    const socket = connect();
    const signals = new Map<string, AbortSignal>();
    install(async (request, signal) => {
      const id =
        typeof request === 'object' && request !== null && 'id' in request ? request.id : null;
      if (typeof id === 'string' && signal !== undefined) signals.set(id, signal);
      return new Promise<AppCommandResult>(() => undefined);
    });
    socket.receive(call('vp-a', { op: 'run', id: 'a' }));
    socket.receive(call('vp-b', { op: 'run', id: 'b' }));
    await flush();
    socket.receive({ t: 'ui_cancel', id: 'vp-a' });
    expect(signals.get('a')?.aborted).toBe(true);
    expect(signals.get('b')?.aborted).toBe(false);
  });

  test('losing the socket aborts calls that wait for an approval', async () => {
    const socket = connect();
    let signal: AbortSignal | undefined;
    install(async (_request, given) => {
      signal = given;
      return new Promise<AppCommandResult>(() => undefined);
    });
    socket.receive(call('vp-5', { op: 'run', id: 'edit.undo' }));
    await flush();
    expect(signal?.aborted).toBe(false);
    socket.onclose?.();
    expect(signal?.aborted).toBe(true);
  });

  test('viewport calls are still answered by the viewport bridge, not the palette', async () => {
    const socket = connect();
    let paletteCalls = 0;
    install(async () => {
      paletteCalls += 1;
      return undone;
    });
    socket.receive({ t: 'ui_call', id: 'vp-6', call: { method: 'get_selection' } });
    await flush();
    expect(paletteCalls).toBe(0);
    expect(socket.sent[0]).toMatchObject({ t: 'ui_result', id: 'vp-6', ok: false });
  });
});

describe('palette transport', () => {
  test('prompt goes out as an rpc command and resolves with the response frame', async () => {
    const socket = connect();
    const pending = omp.palette.prompt('wrapped question');
    const [sent] = socket.sent;
    expect(sent).toMatchObject({
      t: 'rpc',
      command: { type: 'prompt', message: 'wrapped question' },
    });
    const id = sentCommandId(sent);
    socket.receive({
      t: 'frame',
      frame: {
        type: 'response',
        id,
        command: 'prompt',
        success: true,
        data: { agentInvoked: true },
      },
    });
    expect(await pending).toEqual({ ok: true, agentInvoked: true });

    const refused = omp.palette.prompt('again');
    const second = sentCommandId(socket.sent[1]);
    socket.receive({
      t: 'frame',
      frame: { type: 'response', id: second, command: 'prompt', success: false, error: 'busy' },
    });
    expect(await refused).toEqual({ ok: false, error: 'busy' });
  });

  test('prompt without a connection fails honestly', async () => {
    omp.connect(null);
    expect(await omp.palette.prompt('x')).toEqual({ ok: false, error: 'not connected' });
  });

  test('abort sends the omp abort command', () => {
    const socket = connect();
    omp.palette.abort();
    expect(socket.sent[0]).toMatchObject({ t: 'rpc', command: { type: 'abort' } });
  });

  test('stream frames reach palette listeners until they unsubscribe', () => {
    const socket = connect();
    const frames: OmpFrame[] = [];
    const stop = omp.palette.onFrame((frame) => frames.push(frame));
    socket.receive({ t: 'frame', frame: { type: 'agent_start' } });
    stop();
    socket.receive({ t: 'frame', frame: { type: 'agent_end', isTerminal: true } });
    expect(frames).toEqual([{ type: 'agent_start' }]);
  });

  test('a stopped omp is not working, even if its turn never ended', () => {
    const socket = connect();
    socket.receive({
      t: 'status',
      status: { phase: 'ready', wallId: 'w1', cwd: '/w', sessionDir: '/s', restartAttempt: 0 },
    });
    socket.receive({ t: 'frame', frame: { type: 'agent_start' } });
    expect(omp.palette.link().working).toBe(true);
    socket.receive({
      t: 'status',
      status: { phase: 'stopped', wallId: 'w1', cwd: '/w', sessionDir: '/s', restartAttempt: 0 },
    });
    expect(omp.palette.link().working).toBe(false);
  });

  test('the link follows the connection, the server child and the snapshot', () => {
    const socket = connect();
    const notified: number[] = [];
    const stop = omp.palette.onLink(() => notified.push(1));
    expect(statusOf(omp.palette.link())).toBe('connecting');
    socket.receive({
      t: 'status',
      status: { phase: 'ready', wallId: 'w1', cwd: '/w', sessionDir: '/s', restartAttempt: 0 },
    });
    expect(omp.palette.link()).toMatchObject({ phase: 'live', server: 'ready', loaded: false });
    socket.receive({
      t: 'snapshot',
      snapshot: { messages: [], state: null, inflight: [], pendingDialogs: [], pendingPrompts: [] },
    });
    expect(statusOf(omp.palette.link())).toBe('ready');
    omp.connect(null);
    expect(statusOf(omp.palette.link())).toBe('unavailable');
    expect(notified.length).toBeGreaterThan(0);
    stop();
  });
});
