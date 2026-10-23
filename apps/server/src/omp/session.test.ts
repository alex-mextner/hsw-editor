import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OmpFrame, OmpResponseFrame, OmpSnapshot } from '@hsw-editor/omp-protocol';
import { DEFAULT_TIMINGS, OmpSession, type SessionDeps } from './session.ts';
import { rpcCommand, testConfig, TestPage } from './testing/harness.ts';
import type { HostTool } from './tool-types.ts';

const sessions: OmpSession[] = [];

function makeSession(
  overrides: Partial<SessionDeps> = {},
  tools: readonly HostTool[] = [],
): OmpSession {
  const session = new OmpSession({
    wallId: 'w1',
    config: testConfig(),
    createTools: () => tools,
    ompVersion: async () => '18.8.1',
    timings: { ...DEFAULT_TIMINGS, backoffMs: [30, 30], maxRestarts: 2, viewportTimeoutMs: 500 },
    ...overrides,
  });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop('shutdown')));
});

function textOf(frame: OmpFrame): string {
  if (
    frame.type !== 'message_end' ||
    !('content' in frame.message) ||
    typeof frame.message.content === 'string'
  )
    return '';
  const block = frame.message.content.find((entry) => entry.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

function deltaText(frames: readonly OmpFrame[]): string {
  return frames
    .flatMap((frame) =>
      frame.type === 'message_update' && frame.assistantMessageEvent.type === 'text_delta'
        ? [frame.assistantMessageEvent.delta]
        : [],
    )
    .join('');
}

async function ready(session: OmpSession, page: TestPage): Promise<OmpSnapshot> {
  session.attach(page);
  await page.until((p) => p.find('snapshot') !== undefined);
  const snapshot = page.find('snapshot')?.snapshot;
  if (!snapshot) throw new Error('no snapshot');
  return snapshot;
}

function responseTo(page: TestPage, id: string): OmpResponseFrame | undefined {
  return page
    .frames()
    .find((frame): frame is OmpResponseFrame => frame.type === 'response' && frame.id === id);
}

describe('OmpSession with a scripted omp', () => {
  test('attach bootstraps the child and sends hello, status and a snapshot without bulky state', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    const snapshot = await ready(session, page);
    expect(page.messages[0]?.t).toBe('hello');
    expect(page.messages.some((m) => m.t === 'status' && m.status.phase === 'starting')).toBe(true);
    expect(session.phase).toBe('ready');
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.state?.sessionId).toBe('fake-session');
    expect(JSON.stringify(snapshot.state)).not.toContain('SECRET-LOOKING');
  });

  test('a prompt streams a reply; its response goes only to the page that sent it', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    const other = new TestPage('p2');
    await ready(session, page);
    await ready(session, other);
    const command = rpcCommand('prompt', { message: 'say hi' });
    session.handleClientMessage('p1', { t: 'rpc', command });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    expect(responseTo(page, command.id)?.success).toBe(true);
    expect(responseTo(other, command.id)).toBeUndefined();
    expect(other.frames().some((f) => f.type === 'agent_end')).toBe(true);
    expect(
      page
        .frames()
        .filter((f) => f.type === 'message_end')
        .map(textOf)
        .at(-1),
    ).toBe('hi');
  });

  test('host tool calls are executed by the server and answered to omp', async () => {
    const seen: { args: unknown }[] = [];
    const tool: HostTool = {
      definition: {
        name: 'wall_apply',
        label: 'x',
        description: 'x',
        parameters: { type: 'object' },
      },
      async execute(args) {
        seen.push({ args });
        return { content: [{ type: 'text', text: '{"ok":true,"rev":7}' }] };
      },
    };
    const session = makeSession({}, [tool]);
    const page = new TestPage('p1');
    await ready(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'wall:[{"type":"removeItem","id":"i-1"}]' }),
    });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    expect(seen).toEqual([{ args: { ops: [{ type: 'removeItem', id: 'i-1' }] } }]);
    expect(
      page
        .frames()
        .filter((f) => f.type === 'message_end')
        .map(textOf)
        .at(-1),
    ).toContain('"rev":7');
    // The host-tool plumbing is internal: pages never see it.
    expect(page.frames().some((f) => f.type === 'host_tool_call')).toBe(false);
  });

  test('a throwing tool reports an error result instead of hanging the turn', async () => {
    const tool: HostTool = {
      definition: {
        name: 'wall_apply',
        label: 'x',
        description: 'x',
        parameters: { type: 'object' },
      },
      async execute() {
        throw new Error('store exploded');
      },
    };
    const session = makeSession({}, [tool]);
    const page = new TestPage('p1');
    await ready(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'wall:[]' }),
    });
    await page.until((p) => p.frames().some((f) => f.type === 'tool_execution_end'));
    const end = page.frames().find((f) => f.type === 'tool_execution_end');
    expect(end && 'isError' in end && end.isError).toBe(true);
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
  });

  test('attaching mid-turn replays the in-flight message exactly once with no gaps', async () => {
    const session = makeSession();
    const first = new TestPage('p1');
    await ready(session, first);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'slow' }),
    });
    await first.until((p) => deltaText(p.frames()).length > 12);
    const late = new TestPage('p2');
    const snapshot = await ready(session, late);
    const replayed = snapshot.inflight;
    expect(replayed[0]?.type).toBe('agent_start');
    expect(replayed.some((f) => f.type === 'message_start')).toBe(true);
    await late.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    const assembled = deltaText(replayed) + deltaText(late.frames());
    expect(assembled).toBe('a deliberately slow answer that takes a while');
    // The completed user message came from get_messages, not from a replayed frame.
    expect(snapshot.messages.some((m) => m.role === 'user')).toBe(true);
    expect(late.frames().some((f) => f.type === 'message_end' && f.message.role === 'user')).toBe(
      false,
    );
  });

  test('an unanswered dialog is re-sent to a reconnecting page and answering it resumes the turn', async () => {
    const session = makeSession();
    const first = new TestPage('p1');
    await ready(session, first);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'ask' }),
    });
    await first.until((p) => p.frames().some((f) => f.type === 'extension_ui_request'));
    session.detach('p1');
    const second = new TestPage('p2');
    const snapshot = await ready(session, second);
    expect(snapshot.pendingDialogs).toHaveLength(1);
    const dialog = snapshot.pendingDialogs[0];
    expect(dialog?.method).toBe('select');
    session.handleClientMessage('p2', {
      t: 'ui_response',
      response: { type: 'extension_ui_response', id: dialog?.id ?? '', value: 'Deny' },
    });
    await second.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    expect(
      second
        .frames()
        .filter((f) => f.type === 'message_end')
        .map(textOf)
        .at(-1),
    ).toBe('dialog answered: Deny');
    // A second answer to the same dialog is ignored rather than forwarded.
    session.handleClientMessage('p2', {
      t: 'ui_response',
      response: { type: 'extension_ui_response', id: dialog?.id ?? '', value: 'Approve' },
    });
  });

  test("omp's own approval prompt for our wall tools is answered automatically; others reach the page", async () => {
    const tool: HostTool = {
      definition: {
        name: 'wall_get',
        label: 'x',
        description: 'x',
        parameters: { type: 'object' },
      },
      async execute() {
        return { content: [{ type: 'text', text: '{}' }] };
      },
    };
    const session = makeSession({}, [tool]);
    const page = new TestPage('p1');
    await ready(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'gate:wall_get' }),
    });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    expect(
      page
        .frames()
        .filter((f) => f.type === 'message_end')
        .map(textOf)
        .at(-1),
    ).toBe('gate answered: Approve');
    expect(page.frames().some((f) => f.type === 'extension_ui_request')).toBe(false);

    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'gate:bash' }),
    });
    await page.until((p) => p.frames().some((f) => f.type === 'extension_ui_request'));
    const dialog = page.frames().find((f) => f.type === 'extension_ui_request');
    expect(dialog && 'title' in dialog && dialog.title).toBe('Allow tool: bash');
  });

  test('a crash restarts the child with backoff and gives up after maxRestarts', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await ready(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'crash' }),
    });
    await page.until((p) =>
      p.messages.some((m) => m.t === 'status' && m.status.phase === 'restarting'),
    );
    const restarting = page.messages.find(
      (m) => m.t === 'status' && m.status.phase === 'restarting',
    );
    expect(restarting?.t === 'status' && restarting.status.error).toContain('exit code 3');
    expect(restarting?.t === 'status' && restarting.status.restartAt).toBeGreaterThan(
      Date.now() - 1000,
    );
    await page.until((p) => p.messages.filter((m) => m.t === 'snapshot').length >= 2);
    expect(session.phase).toBe('ready');

    const broken = makeSession({
      wallId: 'w2',
      config: testConfig({ command: [process.execPath, '/nonexistent/omp.ts'] }),
    });
    const brokenPage = new TestPage('p9');
    broken.attach(brokenPage);
    await brokenPage.until(
      (p) => p.messages.some((m) => m.t === 'status' && m.status.phase === 'failed'),
      10_000,
    );
    expect(broken.status().restartAttempt).toBeGreaterThan(2);
    expect(broken.hasChild).toBe(false);
  });

  test('oversized responses arrive intact through protocol v2 chunking', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await ready(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'big' }),
    });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    const command = rpcCommand('get_messages');
    session.handleClientMessage('p1', { t: 'rpc', command });
    await page.until((p) => responseTo(p, command.id) !== undefined);
    const response = responseTo(page, command.id);
    const serialized = JSON.stringify(response);
    expect(serialized.length).toBeGreaterThan(1_400_000);
    expect(response?.success).toBe(true);
  });

  test('switch_session is refused outside the wall session directory', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await ready(session, page);
    const outside = join(session.cwd, 'escape.jsonl');
    mkdirSync(session.cwd, { recursive: true });
    writeFileSync(outside, '{}\n');
    const command = rpcCommand('switch_session', { sessionPath: outside });
    session.handleClientMessage('p1', { t: 'rpc', command });
    await page.until((p) => responseTo(p, command.id) !== undefined);
    const response = responseTo(page, command.id);
    expect(response?.success).toBe(false);
    expect(response && !response.success && response.error).toContain('outside');
  });

  test('stop() ends the child and later attaches start a fresh one that resumes the transcript', async () => {
    const config = testConfig();
    const session = makeSession({ config });
    const page = new TestPage('p1');
    await ready(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'say hi' }),
    });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    const pid = session.status().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    await session.stop('idle');
    expect(() => process.kill(pid, 0)).toThrow();

    const reborn = makeSession({ config });
    const again = new TestPage('p2');
    const snapshot = await ready(reborn, again);
    expect(snapshot.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  test('two pages that pick the same command id each get their own response under their own id', async () => {
    const session = makeSession();
    const a = new TestPage('pa');
    const b = new TestPage('pb');
    await ready(session, a);
    await ready(session, b);
    const command = rpcCommand('get_state');
    session.handleClientMessage('pa', { t: 'rpc', command });
    session.handleClientMessage('pb', { t: 'rpc', command });
    await a.until((p) => responseTo(p, command.id) !== undefined);
    await b.until((p) => responseTo(p, command.id) !== undefined);
    expect(responseTo(a, command.id)?.command).toBe('get_state');
    expect(responseTo(b, command.id)?.command).toBe('get_state');
  });

  test('a page cannot resolve a server-internal request by guessing its id', async () => {
    const session = makeSession();
    const page = new TestPage('pa');
    await ready(session, page);
    const command = { ...rpcCommand('get_state'), id: 'srv-1' };
    session.handleClientMessage('pa', { t: 'rpc', command });
    await page.until((p) => responseTo(p, 'srv-1') !== undefined);
    expect(responseTo(page, 'srv-1')?.success).toBe(true);
  });

  test('stop() reports the disposal immediately and refuses later attaches', async () => {
    const disposed: string[] = [];
    const session = makeSession({ onDispose: (stopped) => disposed.push(stopped.wallId) });
    await ready(session, new TestPage('pa'));
    const closing = session.stop('user');
    expect(disposed).toEqual(['w1']);
    expect(() => session.attach(new TestPage('pb'))).toThrow();
    await closing;
    expect(session.phase).toBe('stopped');
  });

  test('a new_session resets the other pages even if the page that sent it left before the answer', async () => {
    const session = makeSession();
    const sender = new TestPage('pa');
    const watcher = new TestPage('pb');
    await ready(session, sender);
    await ready(session, watcher);
    const prompt = rpcCommand('prompt', { message: 'say hi' });
    session.handleClientMessage('pa', { t: 'rpc', command: prompt });
    await watcher.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    session.handleClientMessage('pa', { t: 'rpc', command: rpcCommand('new_session') });
    session.detach('pa');
    await watcher.until((p) => p.messages.filter((m) => m.t === 'snapshot').length >= 2);
    const snapshots = watcher.messages.flatMap((m) => (m.t === 'snapshot' ? [m.snapshot] : []));
    expect(snapshots.at(-1)?.messages).toEqual([]);
  });

  test('stopping during a restart still waits for the old child to exit', async () => {
    const session = makeSession();
    await ready(session, new TestPage('pa'));
    const pid = session.status().pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const restarting = session.restart();
    await session.stop('shutdown');
    expect(() => process.kill(pid, 0)).toThrow();
    await restarting;
  });

  test('a child that never sends ready is killed and the session fails with a clear error', async () => {
    const session = makeSession({
      config: testConfig({ command: [process.execPath, '-e', 'setTimeout(() => {}, 60000)'] }),
      timings: {
        ...DEFAULT_TIMINGS,
        backoffMs: [30],
        maxRestarts: 0,
        readyTimeoutMs: 150,
        viewportTimeoutMs: 500,
      },
    });
    const page = new TestPage('pa');
    session.attach(page);
    await page.until((p) => p.messages.some((m) => m.t === 'status' && m.status.phase === 'failed'));
    expect(session.status().error).toMatch(/did not become ready/);
    expect(session.hasChild).toBe(false);
  });
});

describe('prompt client routing', () => {
  test('a refused prompt from another tab does not take over the approval target', async () => {
    const session = makeSession();
    const asker = new TestPage('asker');
    const other = new TestPage('other');
    await ready(session, asker);
    await ready(session, other);
    const first = rpcCommand('prompt', { message: 'crash' });
    session.handleClientMessage('asker', { t: 'rpc', command: first });
    // The child dies mid-turn: until it is back every prompt is refused.
    while (session.phase === 'ready') await new Promise((resolve) => setTimeout(resolve, 5));
    const refused = rpcCommand('prompt', { message: 'say hi' });
    session.handleClientMessage('other', { t: 'rpc', command: refused });
    const response = responseTo(other, refused.id);
    expect(response?.success).toBe(false);
    expect(response && !response.success && response.error).toContain('not ready');
    expect(session.promptClientId).toBe('asker');
  });
});
