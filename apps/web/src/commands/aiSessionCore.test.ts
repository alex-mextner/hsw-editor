import { describe, expect, test } from 'bun:test';
import {
  type AiBridgeStatus,
  type AiEvent,
  type AppCommandResult,
  type ApprovalMode,
  buildKeymap,
  CommandRegistry,
  defineCommand,
  EMPTY_USER_KEYMAP,
  executeAppCommand,
  type PaletteAiBridge,
} from '@hsw-editor/commands';
import { UNAVAILABLE_AI_BRIDGE } from './aiBridge.ts';
import { AiSession } from './aiSessionCore.ts';

/** In-memory stand-in for the omp bridge, used only here. */
function fakeBridge(status: AiBridgeStatus = 'ready') {
  let emit: (event: AiEvent) => void = () => undefined;
  let handler: ((request: unknown, signal?: AbortSignal) => Promise<AppCommandResult>) | null =
    null;
  const asked: string[] = [];
  let cancelled = 0;
  const bridge: PaletteAiBridge = {
    status: () => status,
    onStatus: () => () => undefined,
    ask: (request, onEvent) => {
      asked.push(request.text);
      emit = onEvent;
      return { cancel: () => (cancelled += 1) };
    },
    setAppCommandHandler: (next) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
  };
  return {
    bridge,
    emit: (event: AiEvent) => emit(event),
    asked,
    cancelled: () => cancelled,
    callTool: (request: unknown, signal?: AbortSignal) => {
      if (handler === null) throw new Error('no handler registered');
      return handler(request, signal);
    },
    hasHandler: () => handler !== null,
  };
}

function makeSession(
  options: { mode?: ApprovalMode; bridge?: PaletteAiBridge; ui?: boolean } = {},
) {
  const fake = fakeBridge();
  const registry = new CommandRegistry();
  const ran: string[] = [];
  registry.register(
    defineCommand({
      id: 'view.fit',
      title: { en: 'Fit', ru: 'Вписать' },
      group: 'view',
      mutates: false,
      handler: () => {
        ran.push('view.fit');
        return null;
      },
    }),
    defineCommand({
      id: 'edit.delete',
      title: { en: 'Delete', ru: 'Удалить' },
      group: 'edit',
      mutates: true,
      handler: () => {
        ran.push('edit.delete');
        return null;
      },
    }),
  );
  let mode: ApprovalMode = options.mode ?? 'approve';
  const session = new AiSession({
    bridge: () => options.bridge ?? fake.bridge,
    approvalMode: () => mode,
    locale: () => 'en',
    executeAppCommand: (gate, request, signal) =>
      executeAppCommand(
        {
          registry,
          getContext: () => ({}),
          getKeymap: () => buildKeymap(registry.all(), EMPTY_USER_KEYMAP, 'linux'),
          gate,
          locale: () => 'en',
        },
        request,
        signal,
      ),
  });
  session.attach();
  // The answer pane is what shows approval prompts; tests that need it absent opt out.
  const detachUi = options.ui === false ? () => undefined : session.attachApprovalUi();
  return {
    detachUi,
    session,
    fake,
    ran,
    setMode: (next: ApprovalMode) => (mode = next),
  };
}

describe('asking', () => {
  test('streams the answer', () => {
    const { session, fake } = makeSession();
    session.ask('turn on the light theme');
    expect(fake.asked).toEqual(['turn on the light theme']);
    expect(session.answer.get().status).toBe('streaming');
    fake.emit({ t: 'delta', text: 'Switching ' });
    fake.emit({ t: 'delta', text: 'now.' });
    fake.emit({ t: 'done' });
    expect(session.answer.get()).toMatchObject({ status: 'done', text: 'Switching now.' });
  });

  test('an unavailable bridge is never asked', () => {
    const { session } = makeSession({ bridge: UNAVAILABLE_AI_BRIDGE });
    session.ask('hello');
    expect(session.answer.get().status).toBe('idle');
  });

  test('stop cancels the run and keeps the text so far', () => {
    const { session, fake } = makeSession();
    session.ask('q');
    fake.emit({ t: 'delta', text: 'part' });
    session.cancel();
    expect(fake.cancelled()).toBe(1);
    expect(session.answer.get()).toMatchObject({ status: 'done', text: 'part' });
    fake.emit({ t: 'delta', text: ' late' });
    expect(session.answer.get().text).toBe('part');
  });

  test('a new question drops the old run', () => {
    const { session, fake } = makeSession();
    session.ask('one');
    fake.emit({ t: 'delta', text: 'x' });
    session.ask('two');
    expect(session.answer.get()).toMatchObject({ status: 'streaming', text: '' });
  });
});

describe('app_command through the approval gate', () => {
  test('a read-only action runs at once and is listed as done', async () => {
    const { session, fake, ran } = makeSession();
    session.ask('fit');
    const result = await fake.callTool({ op: 'run', id: 'view.fit' });
    expect(result.ok).toBe(true);
    expect(ran).toEqual(['view.fit']);
    expect(session.answer.get().plans.map((entry) => entry.status)).toEqual(['done']);
    expect(session.approval.get()).toBeNull();
  });

  test('a changing action waits for approval, then runs', async () => {
    const { session, fake, ran } = makeSession();
    session.ask('delete');
    const pending = fake.callTool({ op: 'run', id: 'edit.delete' });
    await Promise.resolve();
    expect(session.approval.get()?.plan.commandId).toBe('edit.delete');
    expect(ran).toEqual([]);
    expect(session.answer.get().plans.map((entry) => entry.status)).toEqual(['planned']);
    session.respond(true);
    expect((await pending).ok).toBe(true);
    expect(ran).toEqual(['edit.delete']);
    expect(session.approval.get()).toBeNull();
    expect(session.answer.get().plans.map((entry) => entry.status)).toEqual(['done']);
  });

  test('a rejection comes back to the AI as an error', async () => {
    const { session, fake, ran } = makeSession();
    session.ask('delete');
    const pending = fake.callTool({ op: 'run', id: 'edit.delete' });
    await Promise.resolve();
    session.respond(false);
    expect(await pending).toMatchObject({ ok: false, code: 'rejected' });
    expect(ran).toEqual([]);
    expect(session.answer.get().plans.map((entry) => entry.status)).toEqual(['failed']);
  });

  test('auto mode skips the prompt', async () => {
    const { session, fake, ran } = makeSession({ mode: 'auto' });
    session.ask('delete');
    const result = await fake.callTool({ op: 'run', id: 'edit.delete' });
    expect(result.ok).toBe(true);
    expect(ran).toEqual(['edit.delete']);
    expect(session.approval.get()).toBeNull();
  });

  test('stopping the answer refuses the pending approval', async () => {
    const { session, fake, ran } = makeSession();
    session.ask('delete');
    const pending = fake.callTool({ op: 'run', id: 'edit.delete' });
    await Promise.resolve();
    session.cancel();
    expect(await pending).toMatchObject({ ok: false });
    expect(ran).toEqual([]);
    expect(session.approval.get()).toBeNull();
  });

  test('an aborted tool call closes its prompt', async () => {
    const { session, fake, ran } = makeSession();
    session.ask('delete');
    const controller = new AbortController();
    const pending = fake.callTool({ op: 'run', id: 'edit.delete' }, controller.signal);
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, code: 'cancelled' });
    expect(ran).toEqual([]);
    expect(session.approval.get()).toBeNull();
  });

  test('the mode is read at call time, so the toggle applies to the next action', async () => {
    const { session, fake, setMode } = makeSession();
    session.ask('delete');
    setMode('auto');
    const result = await fake.callTool({ op: 'run', id: 'edit.delete' });
    expect(result.ok).toBe(true);
  });

  test('dispose unregisters the tool handler', () => {
    const { session, fake } = makeSession();
    expect(fake.hasHandler()).toBe(true);
    session.dispose();
    expect(fake.hasHandler()).toBe(false);
  });

  test('with no prompt on screen a changing action is refused at once, saying what to do', async () => {
    const { session, fake, ran } = makeSession({ ui: false });
    session.ask('delete');
    const result = await fake.callTool({ op: 'run', id: 'edit.delete' });
    expect(result).toMatchObject({ ok: false, code: 'rejected' });
    expect(result.ok ? '' : result.message).toContain('open the palette');
    expect(ran).toEqual([]);
    expect(session.approval.get()).toBeNull();
  });

  test('read-only actions and auto mode do not need a prompt', async () => {
    const quiet = makeSession({ ui: false });
    expect((await quiet.fake.callTool({ op: 'run', id: 'view.fit' })).ok).toBe(true);
    const auto = makeSession({ ui: false, mode: 'auto' });
    expect((await auto.fake.callTool({ op: 'run', id: 'edit.delete' })).ok).toBe(true);
  });

  test('a tool call while the palette is closed leaves no plan behind', async () => {
    const { session, fake } = makeSession({ ui: false });
    await fake.callTool({ op: 'run', id: 'edit.delete' });
    expect(session.answer.get().plans).toEqual([]);
    expect(session.answer.get().status).toBe('idle');
  });

  test('plans of a reset conversation are not announced into the next one', async () => {
    const { session, fake } = makeSession();
    session.ask('first');
    session.reset();
    await fake.callTool({ op: 'run', id: 'view.fit' });
    expect(session.answer.get().plans).toEqual([]);
  });

  test('closing the last prompt settles what was waiting', async () => {
    const { session, fake, detachUi } = makeSession();
    session.ask('delete');
    const pending = fake.callTool({ op: 'run', id: 'edit.delete' });
    await Promise.resolve();
    detachUi();
    expect(await pending).toMatchObject({ ok: false, code: 'rejected' });
    expect(session.approval.get()).toBeNull();
  });
});
