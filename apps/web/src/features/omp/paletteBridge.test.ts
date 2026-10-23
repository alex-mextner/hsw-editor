import { describe, expect, test } from 'bun:test';
import type { AiBridgeStatus, AiEvent, AppCommandResult } from '@hsw-editor/commands';
import type { OmpFrame } from '@hsw-editor/omp-protocol';
import {
  createOmpPaletteBridge,
  statusOf,
  type AppCommandHandler,
  type PaletteLink,
  type PaletteTransport,
  type PromptAck,
} from './paletteBridge.ts';
import { buildPalettePrompt, unwrapPalettePrompt } from './paletteMode.ts';

const READY: PaletteLink = { phase: 'live', server: 'ready', loaded: true, working: false };

/** A transport the test drives by hand: no socket, no timers. */
function fakeTransport(initial: PaletteLink = READY) {
  let link = initial;
  const linkListeners = new Set<() => void>();
  const frameListeners = new Set<(frame: OmpFrame) => void>();
  const prompts: string[] = [];
  let aborts = 0;
  let ack: PromptAck = { ok: true, agentInvoked: true };
  let handler: AppCommandHandler | null = null;
  const transport: PaletteTransport = {
    link: () => link,
    onLink: (listener) => {
      linkListeners.add(listener);
      return () => linkListeners.delete(listener);
    },
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    prompt: async (message) => {
      prompts.push(message);
      return ack;
    },
    abort: () => {
      aborts += 1;
    },
    setAppCommandHandler: (next) => {
      handler = next;
      return () => {
        if (handler === next) handler = null;
      };
    },
  };
  return {
    transport,
    prompts,
    aborts: () => aborts,
    listeners: () => ({ frames: frameListeners.size, links: linkListeners.size }),
    setLink(next: PaletteLink) {
      link = next;
      for (const listener of [...linkListeners]) listener();
    },
    setAck(next: PromptAck) {
      ack = next;
    },
    frame(frame: OmpFrame) {
      for (const listener of [...frameListeners]) listener(frame);
    },
    handler: () => handler,
  };
}

const delta = (text: string, messageId = 'm1', contentIndex = 0): OmpFrame => ({
  type: 'message_update',
  messageId,
  assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text },
});
const textEnd = (content: string, messageId = 'm1', contentIndex = 0): OmpFrame => ({
  type: 'message_update',
  messageId,
  assistantMessageEvent: { type: 'text_end', contentIndex, content },
});
const agentEnd: OmpFrame = { type: 'agent_end', isTerminal: true };
const assistantEnd = (
  stopReason: 'stop' | 'error',
  errorMessage?: string,
  messageId = 'm1',
): OmpFrame => ({
  type: 'message_end',
  messageId,
  message: {
    role: 'assistant',
    content: [],
    model: 'x',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  },
});

function run(link: PaletteLink = READY) {
  const fake = fakeTransport(link);
  const bridge = createOmpPaletteBridge(fake.transport);
  const events: AiEvent[] = [];
  const handle = bridge.ask({ text: 'what can you do', locale: 'en' }, (event) =>
    events.push(event),
  );
  return { fake, bridge, events, handle };
}

/** Lets the `prompt()` promise chain of `ask` settle. */
const settle = (): Promise<void> => Promise.resolve().then(() => undefined);

describe('status', () => {
  test('follows the shared connection honestly', () => {
    const cases: readonly (readonly [Partial<PaletteLink>, AiBridgeStatus])[] = [
      [{}, 'ready'],
      [{ phase: 'closed' }, 'unavailable'],
      [{ phase: 'connecting' }, 'connecting'],
      [{ phase: 'reconnecting' }, 'connecting'],
      [{ server: 'failed' }, 'unavailable'],
      [{ server: 'starting' }, 'connecting'],
      [{ server: 'restarting' }, 'connecting'],
      [{ server: null }, 'connecting'],
      [{ loaded: false }, 'connecting'],
      // A stopped omp is brought back up by the next command.
      [{ server: 'stopped' }, 'ready'],
    ];
    for (const [patch, expected] of cases) expect(statusOf({ ...READY, ...patch })).toBe(expected);
  });

  test('onStatus reports changes of the status, not of every link detail', () => {
    const fake = fakeTransport();
    const bridge = createOmpPaletteBridge(fake.transport);
    const seen: AiBridgeStatus[] = [];
    const stop = bridge.onStatus((status) => seen.push(status));
    fake.setLink({ ...READY, working: true });
    fake.setLink({ ...READY, phase: 'reconnecting', loaded: false });
    fake.setLink({ ...READY, phase: 'reconnecting', loaded: false });
    fake.setLink({ ...READY, server: 'failed' });
    expect(seen).toEqual(['connecting', 'unavailable']);
    stop();
    fake.setLink(READY);
    expect(seen).toHaveLength(2);
  });
});

describe('ask', () => {
  test('sends the question in palette mode and streams assistant text as deltas, then done', async () => {
    const { fake, events } = run();
    await settle();
    expect(fake.prompts).toHaveLength(1);
    expect(unwrapPalettePrompt(fake.prompts[0] ?? '')).toBe('what can you do');
    expect(fake.prompts[0]).toContain('app_command');

    fake.frame({ type: 'agent_start' });
    fake.frame({
      type: 'message_update',
      messageId: 'm1',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
    });
    fake.frame(delta('I can '));
    fake.frame(delta('undo.'));
    fake.frame(textEnd('I can undo.'));
    fake.frame(agentEnd);
    expect(events).toEqual([
      { t: 'delta', text: 'I can ' },
      { t: 'delta', text: 'undo.' },
      { t: 'done' },
    ]);
    // Finished: no listeners linger on the shared connection.
    expect(fake.listeners()).toEqual({ frames: 0, links: 0 });
  });

  test('text that deltas did not carry is taken from the finished block, and nothing is shown twice', () => {
    const { fake, events } = run();
    fake.frame(delta('Hel'));
    fake.frame(textEnd('Hello there'));
    fake.frame(textEnd('Hello there'));
    fake.frame(agentEnd);
    expect(
      events.filter((e) => e.t === 'delta').map((e) => (e.t === 'delta' ? e.text : '')),
    ).toEqual(['Hel', 'lo there']);
  });

  test('a later text block (after a tool call) starts a new paragraph', () => {
    const { fake, events } = run();
    fake.frame(delta('Searching.', 'm1'));
    fake.frame(delta('Done.', 'm2'));
    fake.frame(delta(' Really.', 'm2'));
    fake.frame(agentEnd);
    expect(events).toEqual([
      { t: 'delta', text: 'Searching.' },
      { t: 'delta', text: '\n\nDone.' },
      { t: 'delta', text: ' Really.' },
      { t: 'done' },
    ]);
  });

  test('a session_settled of an earlier turn does not end a run that has not started', () => {
    const { fake, events } = run();
    fake.frame({ type: 'session_settled' });
    fake.frame({ type: 'agent_start' });
    fake.frame(delta('mine'));
    fake.frame({ type: 'session_settled' });
    expect(events).toEqual([{ t: 'delta', text: 'mine' }, { t: 'done' }]);
  });

  test('a turn that ends only inside a snapshot (working goes false) still ends the answer', () => {
    const { fake, events } = run();
    fake.frame({ type: 'agent_start' });
    fake.setLink({ ...READY, working: true });
    fake.frame(delta('part'));
    fake.setLink({ ...READY, working: false });
    expect(events).toEqual([{ t: 'delta', text: 'part' }, { t: 'done' }]);
  });

  test('a non-terminal agent_end does not end the answer', () => {
    const { fake, events } = run();
    fake.frame(delta('a'));
    fake.frame({ type: 'agent_end', isTerminal: false });
    fake.frame(delta('b'));
    fake.frame(agentEnd);
    expect(events.map((e) => e.t)).toEqual(['delta', 'delta', 'done']);
  });

  test('a refused prompt is an error and nothing streams afterwards', async () => {
    const fake = fakeTransport();
    fake.setAck({ ok: false, error: 'omp is not ready (starting)' });
    const bridge = createOmpPaletteBridge(fake.transport);
    const events: AiEvent[] = [];
    bridge.ask({ text: 'x', locale: 'ru' }, (event) => events.push(event));
    await settle();
    fake.frame(delta('late'));
    expect(events).toEqual([{ t: 'error', message: 'omp is not ready (starting)' }]);
  });

  test('a prompt omp handled itself (agentInvoked false) ends at once', async () => {
    const fake = fakeTransport();
    fake.setAck({ ok: true, agentInvoked: false });
    const bridge = createOmpPaletteBridge(fake.transport);
    const events: AiEvent[] = [];
    bridge.ask({ text: 'x', locale: 'en' }, (event) => events.push(event));
    await settle();
    expect(events).toEqual([{ t: 'done' }]);
  });

  test('a failed model turn becomes an error with the model message', () => {
    const { fake, events } = run();
    fake.frame(assistantEnd('error', '429 rate limited'));
    fake.frame(agentEnd);
    expect(events).toEqual([{ t: 'error', message: '429 rate limited' }]);
  });

  test('a prompt_result error ends the run with its message', async () => {
    const { fake, events } = run();
    await settle();
    fake.frame({
      type: 'prompt_result',
      id: 'r1',
      agentInvoked: true,
      status: 'error',
      error: 'no model configured',
    });
    fake.frame(agentEnd);
    expect(events).toEqual([{ t: 'error', message: 'no model configured' }]);
  });

  test("another page's failed prompt (a prompt_result without our id) does not end our answer", () => {
    const { fake, events } = run();
    fake.frame({ type: 'prompt_result', agentInvoked: true, status: 'error', error: 'theirs' });
    fake.frame(delta('ours'));
    fake.frame(agentEnd);
    expect(events).toEqual([{ t: 'delta', text: 'ours' }, { t: 'done' }]);
  });

  test('a prompt_result that arrives before omp answered our prompt is a cancelled one and is ignored', async () => {
    const fake = fakeTransport();
    const bridge = createOmpPaletteBridge(fake.transport);
    const events: AiEvent[] = [];
    bridge.ask({ text: 'x', locale: 'en' }, (event) => events.push(event));
    // Before the prompt's own answer is processed (still a pending microtask here).
    fake.frame({
      type: 'prompt_result',
      id: 'r0',
      agentInvoked: true,
      status: 'error',
      error: 'aborted',
    });
    await settle();
    fake.frame(delta('ours'));
    fake.frame(agentEnd);
    expect(events).toEqual([{ t: 'delta', text: 'ours' }, { t: 'done' }]);
  });

  test('a failure omp retried successfully does not turn the answer into an error', () => {
    const { fake, events } = run();
    fake.frame(assistantEnd('error', '429 rate limited'));
    fake.frame({ type: 'agent_end', isTerminal: false });
    fake.frame({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: 'x',
    });
    fake.frame(delta('fine'));
    fake.frame(assistantEnd('stop'));
    fake.frame(agentEnd);
    expect(events).toEqual([{ t: 'delta', text: 'fine' }, { t: 'done' }]);
  });

  test('stopping omp from the panel ends the answer: its frames are dropped, so no agent_end would come', () => {
    const { fake, events } = run();
    fake.frame(delta('part'));
    fake.setLink({ ...READY, server: 'stopped', loaded: false });
    expect(events).toEqual([
      { t: 'delta', text: 'part' },
      { t: 'error', message: 'the agent was stopped' },
    ]);
  });

  test('asking while omp is stopped is fine: it comes back up for the prompt', async () => {
    const { fake, events } = run({ ...READY, server: 'stopped' });
    await settle();
    fake.setLink({ ...READY, server: 'stopped' });
    fake.setLink({ ...READY, server: 'starting', loaded: false });
    fake.setLink(READY);
    fake.frame(delta('up again'));
    fake.frame(agentEnd);
    expect(fake.prompts).toHaveLength(1);
    expect(events).toEqual([{ t: 'delta', text: 'up again' }, { t: 'done' }]);
  });

  test('losing the connection mid-answer is reported once', () => {
    const { fake, events } = run();
    fake.frame(delta('part'));
    fake.setLink({ ...READY, phase: 'reconnecting', loaded: false });
    fake.setLink({ ...READY, phase: 'closed', loaded: false });
    expect(events.map((e) => e.t)).toEqual(['delta', 'error']);
    expect(fake.listeners()).toEqual({ frames: 0, links: 0 });
  });

  test('an agent already busy in the panel is not interrupted', async () => {
    const fake = fakeTransport({ ...READY, working: true });
    const bridge = createOmpPaletteBridge(fake.transport);
    const events: AiEvent[] = [];
    bridge.ask({ text: 'x', locale: 'en' }, (event) => events.push(event));
    await settle();
    expect(fake.prompts).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: 'error' });
  });
});

describe('cancel', () => {
  test('sends abort once, stops events and releases the connection listeners', () => {
    const { fake, events, handle } = run();
    fake.frame(delta('part'));
    handle.cancel();
    handle.cancel();
    fake.frame(delta(' late'));
    fake.frame(agentEnd);
    expect(fake.aborts()).toBe(1);
    expect(events).toEqual([{ t: 'delta', text: 'part' }]);
    expect(fake.listeners()).toEqual({ frames: 0, links: 0 });
  });

  test('cancelling after the answer finished does not abort the session', () => {
    const { fake, handle } = run();
    fake.frame(agentEnd);
    handle.cancel();
    expect(fake.aborts()).toBe(0);
  });
});

describe('asking again after a cancel', () => {
  test('waits for the cancelled turn to end instead of being refused as busy', async () => {
    const { fake, bridge, events, handle } = run();
    await settle();
    // The first turn is streaming.
    fake.setLink({ ...READY, working: true });
    handle.cancel();
    expect(fake.aborts()).toBe(1);

    const second: AiEvent[] = [];
    bridge.ask({ text: 'second', locale: 'en' }, (event) => second.push(event));
    await settle();
    // Not sent yet and not refused: the abort has not finished.
    expect(fake.prompts).toHaveLength(1);
    expect(second).toEqual([]);

    fake.frame(agentEnd);
    fake.setLink(READY);
    await settle();
    expect(fake.prompts).toHaveLength(2);
    expect(unwrapPalettePrompt(fake.prompts[1] ?? '')).toBe('second');
    // The old turn's end did not end the new answer.
    fake.frame(delta('answer two'));
    fake.frame(agentEnd);
    expect(second).toEqual([{ t: 'delta', text: 'answer two' }, { t: 'done' }]);
    expect(events).toEqual([]);
  });

  test('a cancelled prompt that omp refused leaves nothing to wait for', async () => {
    const fake = fakeTransport();
    fake.setAck({ ok: false, error: 'refused' });
    const bridge = createOmpPaletteBridge(fake.transport);
    const first = bridge.ask({ text: 'first', locale: 'en' }, () => undefined);
    first.cancel();
    await settle();
    const second: AiEvent[] = [];
    fake.setAck({ ok: true, agentInvoked: true });
    bridge.ask({ text: 'second', locale: 'en' }, (event) => second.push(event));
    await settle();
    expect(fake.prompts).toHaveLength(2);
    fake.frame(agentEnd);
    expect(second).toEqual([{ t: 'done' }]);
  });

  test('cancelling a question that is still waiting sends nothing and aborts nothing', async () => {
    const { fake, bridge, handle } = run();
    await settle();
    fake.setLink({ ...READY, working: true });
    handle.cancel();
    const waiting = bridge.ask({ text: 'second', locale: 'en' }, () => undefined);
    waiting.cancel();
    fake.frame(agentEnd);
    fake.setLink(READY);
    await settle();
    expect(fake.prompts).toHaveLength(1);
    expect(fake.aborts()).toBe(1);
  });
});

describe('app_command handler', () => {
  test('is the page-side handler of the transport until disposed', async () => {
    const fake = fakeTransport();
    const bridge = createOmpPaletteBridge(fake.transport);
    const answer: AppCommandResult = { ok: true, op: 'run', id: 'edit.undo', value: null };
    const dispose = bridge.setAppCommandHandler(async () => answer);
    const signal = new AbortController().signal;
    expect(await fake.handler()?.({ op: 'run', id: 'edit.undo' }, signal)).toEqual(answer);
    dispose();
    expect(fake.handler()).toBeNull();
  });
});

describe('palette prompt wrapper', () => {
  test('round trips the question in both languages and ignores other messages', () => {
    for (const locale of ['en', 'ru'] as const) {
      const wrapped = buildPalettePrompt('сделай сетку\nкрупнее', locale);
      expect(unwrapPalettePrompt(wrapped)).toBe('сделай сетку\nкрупнее');
    }
    expect(buildPalettePrompt('x', 'ru')).toContain('Russian');
    expect(unwrapPalettePrompt('plain question')).toBeNull();
    expect(unwrapPalettePrompt('<hsw-palette-mode>\nno end tag')).toBeNull();
  });
});
