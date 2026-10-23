/**
 * End to end: the real daemon (wall store, REST, SSE) with the omp module, a scripted omp child, and a page
 * stand-in speaking the WebSocket protocol. Covers the tool bridge acceptance of issue #17: agent edits go
 * through the op stream (attributed `agent`), show up over SSE, are undoable, destructive edits wait for approval.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplyResponse, ChangeEntry, HistoryEntry, WallResponse } from '@hsw-editor/core';
import {
  parseServerMessage,
  type OmpFrame,
  type OmpServerMessage,
  type OmpSnapshot,
  type ViewportCall,
  type ViewportResult,
} from '@hsw-editor/omp-protocol';
import { startServer, type RunningServer } from '../server.ts';
import { createOmpModule, type OmpModule } from './module.ts';
import { FAKE_OMP } from './testing/harness.ts';

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

let running: RunningServer;
let ompModule: OmpModule;
let root: string;
let base: string;
const previousConfigHome = process.env['XDG_CONFIG_HOME'];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-omp-e2e-'));
  process.env['XDG_CONFIG_HOME'] = join(root, 'config'); // keep the developer's own omp config out of the test
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<html>app</html>');
  ompModule = createOmpModule({ config: { command: [process.execPath, FAKE_OMP], idleStopMs: 0 } });
  running = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home: join(root, 'home'),
      webDist: dist,
      allowedOrigins: [],
      heartbeatMs: 5000,
    },
    { modules: [ompModule] },
  );
  base = running.url;
});

afterAll(async () => {
  await running.stop();
  if (previousConfigHome === undefined) delete process.env['XDG_CONFIG_HOME'];
  else process.env['XDG_CONFIG_HOME'] = previousConfigHome;
  rmSync(root, { recursive: true, force: true });
});

async function api<T>(
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createWall(id: string): Promise<void> {
  const created = await api('POST', '/api/walls', { name: id, id });
  expect(created.status).toBe(201);
}

const holder = { type: 'addItem', item: { kind: 'holder', bankId: 'holders/screwdriver' } };

/** A page stand-in: records server messages, answers viewport calls and exposes helpers to wait on them. */
class Page {
  readonly messages: OmpServerMessage[] = [];
  readonly calls: ViewportCall[] = [];
  readonly socket: WebSocket;
  viewport: (call: ViewportCall) => ViewportResult | Error = () =>
    new Error('viewport not mounted');
  #seq = 0;

  constructor(wallId: string, headers?: Record<string, string>) {
    const url = `${base.replace('http', 'ws')}/api/omp/ws?wall=${wallId}`;
    this.socket = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
    this.socket.onmessage = (event) => {
      const message = parseServerMessage(String(event.data));
      if (message === null) return;
      this.messages.push(message);
      if (message.t === 'ui_call') {
        this.calls.push(message.call);
        const result = this.viewport(message.call);
        this.socket.send(
          JSON.stringify(
            result instanceof Error
              ? { t: 'ui_result', id: message.id, ok: false, error: result.message }
              : { t: 'ui_result', id: message.id, ok: true, result },
          ),
        );
      }
    };
  }

  frames(): OmpFrame[] {
    return this.messages.flatMap((message) =>
      message.t === 'frame' ? [message.frame as OmpFrame] : [],
    );
  }

  snapshot(): OmpSnapshot | undefined {
    return this.messages.find((message) => message.t === 'snapshot')?.snapshot;
  }

  async until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(
          `timed out; got ${JSON.stringify(this.messages.map((m) => (m.t === 'frame' ? m.frame.type : m.t)))}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  /** Send a prompt and wait for the turn to end; returns the frames of that turn. */
  async prompt(message: string): Promise<OmpFrame[]> {
    const before = this.frames().filter((frame) => frame.type === 'agent_end').length;
    const start = this.frames().length;
    this.#seq += 1;
    this.socket.send(
      JSON.stringify({ t: 'rpc', command: { id: `p${this.#seq}`, type: 'prompt', message } }),
    );
    await this.until(
      () => this.frames().filter((frame) => frame.type === 'agent_end').length > before,
    );
    return this.frames().slice(start);
  }

  async ready(): Promise<void> {
    await this.until(() => this.snapshot() !== undefined);
  }

  close(): void {
    this.socket.close();
  }
}

function toolResult(frames: readonly OmpFrame[], toolName: string) {
  const end = frames.find(
    (frame) => frame.type === 'tool_execution_end' && frame.toolName === toolName,
  );
  if (end?.type !== 'tool_execution_end') throw new Error(`no result for ${toolName}`);
  return end;
}

function textOf(end: Extract<OmpFrame, { type: 'tool_execution_end' }>): string {
  const block = end.result.content.find((entry) => entry.type === 'text');
  return block?.type === 'text' ? block.text : '';
}

/** Minimal SSE reader for `/api/walls/:id/events`. */
async function openEvents(wallId: string): Promise<{ ops: ChangeEntry[]; close: () => void }> {
  const controller = new AbortController();
  const ops: ChangeEntry[] = [];
  const response = await fetch(`${base}/api/walls/${wallId}/events`, { signal: controller.signal });
  const reader = response.body?.getReader();
  void (async () => {
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!block.includes('event: op')) continue;
          const data = block.split('\n').find((line) => line.startsWith('data: '));
          if (data) ops.push(JSON.parse(data.slice(6)) as ChangeEntry);
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return { ops, close: () => controller.abort() };
}

describe('omp bridge end to end', () => {
  test('"add three holders": ops stream over SSE as the agent, the wall updates, and undo reverts it', async () => {
    await createWall('row');
    const events = await openEvents('row');
    const page = new Page('row');
    await page.ready();

    const turn = await page.prompt(`wall:${JSON.stringify([holder, holder, holder])}`);
    const applied = JSON.parse(textOf(toolResult(turn, 'wall_apply'))) as {
      ok: boolean;
      rev: number;
      added: { items: string[] };
    };
    expect(applied).toMatchObject({ ok: true, rev: 1 });
    expect(applied.added.items).toHaveLength(3);

    const wall = await api<WallResponse>('GET', '/api/walls/row');
    expect(wall.body.wall.items.map((item) => item.id)).toEqual(applied.added.items);
    expect(wall.body.canUndo).toBe(true);

    await page.until(() => events.ops.length >= 1);
    expect(events.ops[0]).toMatchObject({ rev: 1, actor: { kind: 'agent', name: 'omp' } });
    const history = await api<{ entries: HistoryEntry[] }>('GET', '/api/walls/row/history');
    expect(history.body.entries.at(-1)).toMatchObject({
      kind: 'op',
      actor: { kind: 'agent', name: 'omp' },
    });

    const undone = await page.prompt('tool:wall_undo:{"baseRev":1}');
    expect(JSON.parse(textOf(toolResult(undone, 'wall_undo')))).toMatchObject({
      ok: true,
      rev: 2,
      canRedo: true,
    });
    expect((await api<WallResponse>('GET', '/api/walls/row')).body.wall.items).toHaveLength(0);
    await page.until(() => events.ops.length >= 2);
    expect(events.ops[1]).toMatchObject({ kind: 'undo', actor: { kind: 'agent', name: 'omp' } });
    events.close();
    page.close();
  });

  test('a stale baseRev is rejected and the human edit survives', async () => {
    await createWall('race');
    const page = new Page('race');
    await page.ready();
    await api<ApplyResponse>('POST', '/api/walls/race/ops', {
      ops: [{ type: 'rename', name: 'by human' }],
      actor: { kind: 'human' },
    });
    const turn = await page.prompt(
      `tool:wall_apply:${JSON.stringify({ ops: [holder], baseRev: 0 })}`,
    );
    const end = toolResult(turn, 'wall_apply');
    expect(end.isError).toBe(true);
    expect(textOf(end)).toContain('rev_conflict');
    expect((await api<WallResponse>('GET', '/api/walls/race')).body.wall).toMatchObject({
      name: 'by human',
      items: [],
    });
    page.close();
  });

  test('bulk removal waits for the user: declining keeps the wall, approving applies it', async () => {
    await createWall('bulk');
    await api('POST', '/api/walls/bulk/ops', {
      ops: Array.from({ length: 8 }, (_, i) => ({
        ...holder,
        item: { ...holder.item, id: `h${i}` },
      })),
      actor: { kind: 'human' },
    });
    const page = new Page('bulk');
    await page.ready();
    const removal = `wall:${JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ type: 'removeItem', id: `h${i}` })))}`;

    const pending = page.prompt(removal);
    await page.until(() => page.messages.some((message) => message.t === 'prompt'));
    const request = page.messages.find((message) => message.t === 'prompt');
    expect(request?.t === 'prompt' && request.request).toMatchObject({
      kind: 'destructive_ops',
      removeCount: 6,
      toolName: 'wall_apply',
    });
    page.socket.send(
      JSON.stringify({
        t: 'prompt_response',
        id: request?.t === 'prompt' ? request.request.id : '',
        answer: { approved: false },
      }),
    );
    const declined = await pending;
    expect(toolResult(declined, 'wall_apply').isError).toBe(true);
    expect((await api<WallResponse>('GET', '/api/walls/bulk')).body.wall.items).toHaveLength(8);

    const second = page.prompt(removal);
    await page.until(() => page.messages.filter((message) => message.t === 'prompt').length >= 2);
    const again = page.messages.filter((message) => message.t === 'prompt').at(-1);
    page.socket.send(
      JSON.stringify({
        t: 'prompt_response',
        id: again?.t === 'prompt' ? again.request.id : '',
        answer: { approved: true },
      }),
    );
    await second;
    expect(
      (await api<WallResponse>('GET', '/api/walls/bulk')).body.wall.items.map((item) => item.id),
    ).toEqual(['h6', 'h7']);
    page.close();
  });

  test('wall_get reports the editor selection and wall_view returns the viewport screenshot to the agent', async () => {
    await createWall('look');
    const page = new Page('look');
    await page.ready();
    page.viewport = (call) => {
      if (call.method === 'get_selection') return { selected: ['i-1', 'i-2'] };
      if (call.method === 'capture')
        return { mimeType: 'image/png', dataBase64: PNG, width: 1, height: 1 };
      if (call.method === 'select') return { selected: call.params.ids };
      return { selected: [] };
    };
    const got = JSON.parse(
      textOf(toolResult(await page.prompt('tool:wall_get:{}'), 'wall_get')),
    ) as { selection: string[]; rev: number };
    expect(got).toMatchObject({ selection: ['i-1', 'i-2'], rev: 0 });

    const view = toolResult(await page.prompt('tool:wall_view:{"view":"iso"}'), 'wall_view');
    expect(view.result.content.some((block) => block.type === 'image' && block.data === PNG)).toBe(
      true,
    );
    expect(page.calls).toContainEqual({
      method: 'capture',
      params: { view: 'iso', maxSidePx: 900 },
    });

    page.viewport = () => new Error('the 3D viewport is not mounted in this window');
    const failed = toolResult(await page.prompt('tool:wall_view:{}'), 'wall_view');
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('not mounted');
    page.close();
  });

  test('a palette question reaches omp wrapped, and its app_command runs on the page and answers the agent', async () => {
    await createWall('palette');
    const page = new Page('palette');
    await page.ready();
    page.viewport = (call) =>
      call.method === 'app_command'
        ? { ok: true, op: 'run', id: call.params.id ?? '', value: 'done' }
        : { selected: [] };
    const wrapped =
      '<hsw-palette-mode>\nanswer briefly\n</hsw-palette-mode>\ntool:app_command:{"op":"run","id":"view.toggleGrid"}';
    const frames = await page.prompt(wrapped);
    expect(page.calls).toEqual([
      { method: 'app_command', params: { op: 'run', id: 'view.toggleGrid' } },
    ]);
    const end = toolResult(frames, 'app_command');
    expect(end.isError).toBeFalsy();
    expect(JSON.parse(textOf(end))).toEqual({
      ok: true,
      op: 'run',
      id: 'view.toggleGrid',
      value: 'done',
    });
    page.close();
  });

  test('reloading the page resumes the conversation from the live child', async () => {
    await createWall('resume');
    const first = new Page('resume');
    await first.ready();
    await first.prompt('say hi');
    first.close();
    await first.until(() => ompModule.host()?.session('resume')?.clientCount === 0);
    const second = new Page('resume');
    await second.ready();
    expect(second.snapshot()?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(second.snapshot()?.state?.sessionId).toBe('fake-session');
    second.close();
  });

  test('after Stop the page stays stopped until it sends a command; the command starts a fresh child and is answered', async () => {
    await createWall('stopper');
    const page = new Page('stopper');
    await page.ready();
    expect((await api('POST', '/api/omp/stop?wall=stopper')).status).toBe(200);
    await page.until(() =>
      page.messages.some((message) => message.t === 'status' && message.status.phase === 'stopped'),
    );
    page.socket.send(JSON.stringify({ t: 'ping' }));
    // Real clock on purpose: proving that nothing happens needs a bounded wait for a negative.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ompModule.host()?.session('stopper')).toBeUndefined();
    const frames = await page.prompt('say hi');
    expect(frames.some((frame) => frame.type === 'agent_end')).toBe(true);
    page.close();
  });

  test('the sessions of a wall are listed and the omp status endpoint hides secrets', async () => {
    const status = await api<{
      config: Record<string, unknown>;
      sessions: { wallId: string; phase: string }[];
    }>('GET', '/api/omp/status');
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toMatch(/key|token|secret/i);
    expect(status.body.sessions.some((session) => session.wallId === 'resume')).toBe(true);
    const sessions = await api<{ sessions: unknown[] }>('GET', '/api/omp/sessions?wall=resume');
    expect(sessions.status).toBe(200);
    expect((await api('GET', '/api/omp/sessions?wall=..%2Fetc')).status).toBe(400);
  });

  test('foreign origins and invalid wall ids cannot open the socket', async () => {
    const hostile = new Page('row', { Origin: 'https://evil.example' });
    const outcome = await new Promise<string>((resolve) => {
      hostile.socket.onopen = () => resolve('open');
      hostile.socket.onerror = () => resolve('refused');
      hostile.socket.onclose = () => resolve('refused');
    });
    expect(outcome).toBe('refused');
    const badWall = await fetch(`${base}/api/omp/ws?wall=..%2F..%2Fetc`);
    expect(badWall.status).toBe(400);
  });
});
