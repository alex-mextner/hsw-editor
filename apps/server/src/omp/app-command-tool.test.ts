import { afterEach, describe, expect, test } from 'bun:test';
import type { AppCommandResult } from '@hsw-editor/commands';
import type { JsonValue, OmpFrame, ViewportCall, ViewportResult } from '@hsw-editor/omp-protocol';
import { createAppCommandToolFactory } from './app-command-tool.ts';
import { DEFAULT_TIMINGS, OmpSession } from './session.ts';
import { rpcCommand, testConfig, TestPage } from './testing/harness.ts';
import type { HostTool, ToolEnv } from './tool-types.ts';

const INFO_UNDO = {
  id: 'edit.undo',
  title: { en: 'Undo', ru: 'Отменить' },
  group: 'edit',
  mutates: true,
  keybinding: 'Ctrl+Z',
  args: null,
};

/** The tool with a viewport port that records calls and answers with `reply`. */
function toolWith(reply: (call: ViewportCall) => Promise<ViewportResult>) {
  const calls: ViewportCall[] = [];
  const signals: AbortSignal[] = [];
  const env: ToolEnv = {
    wallId: 'w1',
    config: testConfig(),
    viewport: {
      call: (call, signal) => {
        calls.push(call);
        signals.push(signal);
        return reply(call);
      },
    },
    prompts: { ask: async () => ({ cancelled: true }) },
  };
  const [tool] = createAppCommandToolFactory()(env);
  if (tool === undefined) throw new Error('the factory registered no tool');
  return { tool, calls, signals };
}

function textOf(result: Awaited<ReturnType<HostTool['execute']>>): string {
  const block = result.content.find((entry) => entry.type === 'text');
  return block?.type === 'text' ? block.text : '';
}

const context = { wallId: 'w1', signal: new AbortController().signal };

describe('app_command tool', () => {
  test('is registered under the name the allow prompt auto-approves, with a flat object schema', () => {
    const { tool } = toolWith(async () => ({ selected: [] }));
    expect(tool.definition.name).toBe('app_command');
    expect(tool.definition.parameters).toMatchObject({ type: 'object', required: ['op'] });
    expect(tool.definition.parameters).not.toHaveProperty('anyOf');
    expect(tool.definition.parameters).not.toHaveProperty('oneOf');
  });

  test('forwards a valid request to the page and returns its answer as JSON', async () => {
    const answer: AppCommandResult = {
      ok: true,
      op: 'search',
      commands: [INFO_UNDO],
      truncated: false,
    };
    const { tool, calls } = toolWith(async () => answer);
    const result = await tool.execute({ op: 'search', query: 'undo', limit: 3 }, context);
    expect(calls).toEqual([
      { method: 'app_command', params: { op: 'search', query: 'undo', limit: 3 } },
    ]);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual(answer);
  });

  test('requests that need a field the op lacks never reach the page', async () => {
    const { tool, calls } = toolWith(async () => ({ selected: [] }));
    const bad: JsonValue[] = [
      { op: 'search' },
      { op: 'run' },
      { op: 'explode' },
      'undo',
      { op: 'run', id: 5 },
    ];
    for (const args of bad) {
      const result = await tool.execute(args, context);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Invalid app_command arguments');
    }
    expect(calls).toEqual([]);
  });

  test('a declined or failed command comes back as an error result with its code', async () => {
    const answer: AppCommandResult = {
      ok: false,
      code: 'rejected',
      message: 'the user did not approve this action',
    };
    const { tool } = toolWith(async () => answer);
    const result = await tool.execute({ op: 'run', id: 'edit.undo' }, context);
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({ code: 'rejected' });
    expect(JSON.parse(textOf(result))).toEqual(answer);
  });

  test('a reply that is not an app_command result is refused', async () => {
    const { tool } = toolWith(async () => ({ selected: ['i-1'] }));
    const result = await tool.execute({ op: 'list' }, context);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unexpected reply');
  });

  test('a page error propagates so the session reports it to the model', async () => {
    const { tool } = toolWith(async () => {
      throw new Error('the command palette is not available in this window');
    });
    await expect(tool.execute({ op: 'list' }, context)).rejects.toThrow('not available');
  });

  test('hands the abort signal of the call to the viewport port', async () => {
    const { tool, signals } = toolWith(async () => ({
      ok: true,
      op: 'list',
      commands: [],
      truncated: false,
    }));
    const controller = new AbortController();
    await tool.execute({ op: 'list' }, { wallId: 'w1', signal: controller.signal });
    expect(signals[0]).toBe(controller.signal);
  });
});

// ---- Through a real session with the scripted omp -----------------------------------------------------

const sessions: OmpSession[] = [];

/** Viewport calls give up after this; `app_command` has its own, longer timeout. */
const VIEWPORT_TIMEOUT_MS = 200;
/** Longer than the viewport timeout: proves `app_command` is not bound by it. */
const WAIT_PAST_VIEWPORT_TIMEOUT_MS = 600;

function makeSession(appCommandTimeoutMs?: number): OmpSession {
  const session = new OmpSession({
    wallId: 'w1',
    config: testConfig(),
    createTools: createAppCommandToolFactory(
      appCommandTimeoutMs === undefined ? {} : { timeoutMs: appCommandTimeoutMs },
    ),
    ompVersion: async () => '18.8.1',
    timings: {
      ...DEFAULT_TIMINGS,
      backoffMs: [30, 30],
      maxRestarts: 2,
      viewportTimeoutMs: VIEWPORT_TIMEOUT_MS,
    },
  });
  sessions.push(session);
  return session;
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.stop('shutdown')));
});

async function attach(session: OmpSession, page: TestPage): Promise<void> {
  session.attach(page);
  await page.until((p) => p.find('snapshot') !== undefined);
}

function toolEnd(page: TestPage): Extract<OmpFrame, { type: 'tool_execution_end' }> | undefined {
  return page
    .frames()
    .find(
      (frame): frame is Extract<OmpFrame, { type: 'tool_execution_end' }> =>
        frame.type === 'tool_execution_end' && frame.toolName === 'app_command',
    );
}

function uiCalls(page: TestPage) {
  return page.messages.flatMap((message) => (message.t === 'ui_call' ? [message] : []));
}

describe('app_command through the omp session', () => {
  test('the page gets a ui_call and its ui_result becomes the tool result of the turn', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await attach(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'tool:app_command:{"op":"search","query":"undo"}' }),
    });
    await page.until((p) => uiCalls(p).length > 0);
    const [call] = uiCalls(page);
    expect(call?.call).toEqual({ method: 'app_command', params: { op: 'search', query: 'undo' } });
    const result: AppCommandResult = {
      ok: true,
      op: 'search',
      commands: [INFO_UNDO],
      truncated: false,
    };
    session.handleClientMessage('p1', { t: 'ui_result', id: call?.id ?? '', ok: true, result });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    const end = toolEnd(page);
    expect(end?.isError).toBeFalsy();
    expect(JSON.stringify(end?.result)).toContain('edit.undo');
  });

  test('a page answering with an error gives the model an error result', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await attach(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'tool:app_command:{"op":"list"}' }),
    });
    await page.until((p) => uiCalls(p).length > 0);
    session.handleClientMessage('p1', {
      t: 'ui_result',
      id: uiCalls(page)[0]?.id ?? '',
      ok: false,
      error: 'the command palette is not available in this window',
    });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    expect(toolEnd(page)?.isError).toBe(true);
    expect(JSON.stringify(toolEnd(page)?.result)).toContain('not available');
  });

  test('waits far longer than a viewport call for the answer (an approval may be pending)', async () => {
    const session = makeSession(60_000);
    const page = new TestPage('p1');
    await attach(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'tool:app_command:{"op":"run","id":"edit.undo"}' }),
    });
    await page.until((p) => uiCalls(p).length > 0);
    // A real delay on purpose: the claim is about elapsed wall-clock time versus the viewport timeout
    // (a wall_view would have failed by now), which fake timers cannot show across the child process.
    await new Promise((resolve) => setTimeout(resolve, WAIT_PAST_VIEWPORT_TIMEOUT_MS));
    expect(toolEnd(page)).toBeUndefined();
    expect(page.find('ui_cancel')).toBeUndefined();
    session.handleClientMessage('p1', {
      t: 'ui_result',
      id: uiCalls(page)[0]?.id ?? '',
      ok: true,
      result: { ok: true, op: 'run', id: 'edit.undo', value: null },
    });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    expect(toolEnd(page)?.isError).toBeFalsy();
  });

  test('an unanswered call times out, tells the page to stop and fails the tool', async () => {
    const session = makeSession(300);
    const page = new TestPage('p1');
    await attach(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'tool:app_command:{"op":"list"}' }),
    });
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    const call = uiCalls(page)[0];
    expect(page.find('ui_cancel')).toEqual({ t: 'ui_cancel', id: call?.id ?? '' });
    expect(toolEnd(page)?.isError).toBe(true);
    expect(JSON.stringify(toolEnd(page)?.result)).toContain('did not answer app_command in time');
  });

  test('aborting the run cancels the call on the page', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await attach(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'tool:app_command:{"op":"run","id":"edit.undo"}' }),
    });
    await page.until((p) => uiCalls(p).length > 0);
    session.handleClientMessage('p1', { t: 'rpc', command: rpcCommand('abort') });
    await page.until((p) => p.find('ui_cancel') !== undefined);
    expect(page.find('ui_cancel')?.id).toBe(uiCalls(page)[0]?.id ?? '');
    await page.until((p) => p.frames().some((f) => f.type === 'agent_end'));
    // A late answer from the page is ignored: the call is gone and the turn is not touched again.
    const framesAtEnd = page.frames().length;
    session.handleClientMessage('p1', {
      t: 'ui_result',
      id: uiCalls(page)[0]?.id ?? '',
      ok: true,
      result: { ok: true, op: 'run', id: 'edit.undo', value: null },
    });
    // Let the child answer a request sent after the late result: anything the late result triggered
    // would have reached the page by then.
    const ping = rpcCommand('get_state');
    session.handleClientMessage('p1', { t: 'rpc', command: ping });
    await page.until((p) =>
      p.frames().some((f) => f.type === 'response' && f.id === ping.id),
    );
    expect(
      page.frames().filter((f) => f.type !== 'response' || f.id === ping.id),
    ).toHaveLength(framesAtEnd - page.frames().filter((f) => f.type === 'response' && f.id !== ping.id).length + 1);
    expect(
      page.frames().filter((f) => f.type === 'tool_execution_end' && f.toolName === 'app_command'),
    ).toHaveLength(1);
  });

  test('a child crash during a pending call tells the page to stop', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await attach(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'toolcrash:{"op":"run","id":"edit.undo"}' }),
    });
    await page.until((p) => uiCalls(p).length > 0);
    const call = uiCalls(page)[0];
    if (call === undefined) throw new Error('no ui_call reached the page');
    await page.until((p) => p.find('ui_cancel') !== undefined);
    expect(page.find('ui_cancel')).toEqual({ t: 'ui_cancel', id: call.id });
  });

  test('a restart during a pending call tells the page to stop', async () => {
    const session = makeSession();
    const page = new TestPage('p1');
    await attach(session, page);
    session.handleClientMessage('p1', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'tool:app_command:{"op":"run","id":"edit.undo"}' }),
    });
    await page.until((p) => uiCalls(p).length > 0);
    await session.restart();
    expect(page.find('ui_cancel')).toEqual({ t: 'ui_cancel', id: uiCalls(page)[0]?.id ?? '' });
  });

  test('goes to the window that asked, not to one that was merely active later', async () => {
    const session = makeSession();
    const asker = new TestPage('asker');
    const other = new TestPage('other');
    await attach(session, asker);
    await attach(session, other);
    session.handleClientMessage('asker', {
      t: 'rpc',
      command: rpcCommand('prompt', { message: 'tool:app_command:{"op":"list"}' }),
    });
    // The other tab refreshes its state right after: it is now the most recently active window.
    session.handleClientMessage('other', { t: 'rpc', command: rpcCommand('get_state') });
    session.handleClientMessage('other', { t: 'ping' });
    await asker.until((p) => uiCalls(p).length > 0);
    expect(uiCalls(other)).toEqual([]);
  });
});
