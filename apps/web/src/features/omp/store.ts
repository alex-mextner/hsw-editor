/**
 * State of the omp panel: one controller owns the WebSocket connection of the open wall and publishes an
 * immutable `OmpView` snapshot (batched to animation frames while the agent streams).
 */
import { createValueStore } from '#state-backend';
import {
  isDialogRequest,
  isJsonObject,
  responseData,
  type HswPromptAnswer,
  type HswPromptRequest,
  type ImageContent,
  type OmpDialogRequest,
  type OmpFrame,
  type OmpModel,
  type OmpPublicConfig,
  type OmpServerMessage,
  type OmpSessionFile,
  type OmpSessionStats,
  type OmpSessionStatus,
  type OmpSlashCommand,
  type OmpState,
  type OmpThinkingLevel,
  type OmpUiResponse,
} from '@hsw-editor/omp-protocol';
import type { ValueStore } from '@/state/types.ts';
import { OmpConnection, type RpcCommandInput } from './connection.ts';
import {
  applySnapshot,
  emptyConversation,
  reduceFrame,
  replaceMessages,
  type Conversation,
} from './conversation.ts';
import type { ConnectionPhase } from './render-types.ts';
import { runViewportCall } from './viewport-bridge.ts';

/** The newest successful wall edit by the agent, kept so the panel can offer a one-click undo. */
export interface AgentEdit {
  readonly rev: number;
  readonly opCount: number;
}

export interface OmpView {
  readonly phase: ConnectionPhase;
  readonly wallId: string | null;
  readonly server: OmpSessionStatus | null;
  readonly config: OmpPublicConfig | null;
  /** True once the server delivered the conversation snapshot for the current child. */
  readonly loaded: boolean;
  readonly conversation: Conversation;
  readonly dialogs: readonly OmpDialogRequest[];
  readonly prompts: readonly HswPromptRequest[];
  readonly state: OmpState | null;
  readonly models: readonly OmpModel[];
  readonly thinkingLevels: readonly OmpThinkingLevel[];
  readonly stats: OmpSessionStats | null;
  readonly commands: readonly OmpSlashCommand[];
  readonly sessions: readonly OmpSessionFile[];
  readonly statusTexts: ReadonlyMap<string, string>;
  readonly widgets: ReadonlyMap<string, readonly string[]>;
  /** Text omp wants placed in the composer (`set_editor_text`, restored queue); `nonce` makes repeats observable. */
  readonly composerFill: { readonly text: string; readonly nonce: number } | null;
  readonly lastEdit: AgentEdit | null;
}

const INITIAL: OmpView = {
  phase: 'closed',
  wallId: null,
  server: null,
  config: null,
  loaded: false,
  conversation: emptyConversation(),
  dialogs: [],
  prompts: [],
  state: null,
  models: [],
  thinkingLevels: [],
  stats: null,
  commands: [],
  sessions: [],
  statusTexts: new Map(),
  widgets: new Map(),
  composerFill: null,
  lastEdit: null,
};

export const ompView: ValueStore<OmpView> = createValueStore<OmpView>(INITIAL);

type SubmitMode = 'steer' | 'followUp';

class OmpController {
  #connection: OmpConnection | null = null;
  #view: OmpView = INITIAL;
  #flushScheduled = false;
  #nonce = 0;
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Open (or switch) the connection for `wallId`; `null` closes it. Idempotent. */
  connect(wallId: string | null): void {
    if (this.#view.wallId === wallId) return;
    this.#connection?.close();
    this.#connection = null;
    this.#view = { ...INITIAL, wallId };
    this.#flush();
    if (wallId === null) return;
    const connection = new OmpConnection(wallId, {
      onPhase: (phase) => this.#update({ phase, ...(phase === 'live' ? {} : { loaded: false }) }),
      onMessage: (message) => this.#onMessage(message),
    });
    this.#connection = connection;
    connection.open();
  }

  // ---- Commands from the panel ------------------------------------------------------------------------

  async submit(
    text: string,
    images: readonly ImageContent[] = [],
    mode: SubmitMode = 'steer',
  ): Promise<string | null> {
    const message = text.trim();
    if (message.length === 0 && images.length === 0) return null;
    const imageField = images.length > 0 ? { images } : {};
    const working = this.#view.conversation.working;
    const command: RpcCommandInput = !working
      ? { type: 'prompt', message, ...imageField }
      : mode === 'steer'
        ? { type: 'steer', message, ...imageField }
        : { type: 'follow_up', message, ...imageField };
    return this.#run(command);
  }

  /** Esc in the TUI: stop and take queued input back into the composer. */
  async stop(): Promise<void> {
    const response = await this.#request({ type: 'abort_and_restore_queue' });
    if (response === null || !response.success) return;
    const data = response.data;
    if (data === undefined || !isJsonObject(data)) return;
    const restored: string[] = [];
    for (const key of ['steering', 'followUp'] as const) {
      const list = data[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (isJsonObject(item) && typeof item['text'] === 'string') restored.push(item['text']);
      }
    }
    if (restored.length > 0)
      this.#update({ composerFill: { text: restored.join('\n\n'), nonce: (this.#nonce += 1) } });
  }

  removeQueued(message: string, queue: 'steering' | 'followUp'): Promise<string | null> {
    return this.#run({ type: 'remove_queued_message', message, queue });
  }

  promoteQueued(message: string): Promise<string | null> {
    return this.#run({ type: 'promote_queued_message', message });
  }

  async setModel(model: OmpModel): Promise<string | null> {
    const error = await this.#run({
      type: 'set_model',
      provider: model.provider,
      modelId: model.id,
    });
    if (error === null) await this.#refreshState();
    return error;
  }

  async setThinkingLevel(level: OmpThinkingLevel): Promise<string | null> {
    const error = await this.#run({ type: 'set_thinking_level', level });
    if (error === null) await this.#refreshState();
    return error;
  }

  async newSession(): Promise<string | null> {
    return this.#run({ type: 'new_session' });
  }

  async switchSession(sessionPath: string): Promise<string | null> {
    return this.#run({ type: 'switch_session', sessionPath });
  }

  async fork(entryId?: string): Promise<string | null> {
    return this.#run(entryId === undefined ? { type: 'fork' } : { type: 'fork', entryId });
  }

  compact(): Promise<string | null> {
    return this.#run({ type: 'compact' });
  }

  async renameSession(name: string): Promise<string | null> {
    const error = await this.#run({ type: 'set_session_name', name });
    if (error === null) await this.refreshSessions();
    return error;
  }

  restartChild(): void {
    this.#connection?.send({ t: 'restart' });
  }

  answerDialog(response: OmpUiResponse): void {
    this.#connection?.send({ t: 'ui_response', response });
    this.#update({ dialogs: this.#view.dialogs.filter((dialog) => dialog.id !== response.id) });
  }

  answerPrompt(id: string, answer: HswPromptAnswer): void {
    this.#connection?.send({ t: 'prompt_response', id, answer });
    this.#update({ prompts: this.#view.prompts.filter((prompt) => prompt.id !== id) });
  }

  async refreshSessions(): Promise<void> {
    const { wallId } = this.#view;
    if (wallId === null) return;
    try {
      const response = await fetch(`/api/omp/sessions?wall=${encodeURIComponent(wallId)}`);
      if (!response.ok) return;
      const body = (await response.json()) as { sessions: OmpSessionFile[] };
      if (this.#view.wallId === wallId) this.#update({ sessions: body.sessions });
    } catch {
      // The list is a convenience; the panel works without it.
    }
  }

  /** Undo the agent's newest edit if (and only if) nothing was applied after it. */
  async undoLastAgentEdit(): Promise<'undone' | 'stale' | 'failed'> {
    const { wallId, lastEdit } = this.#view;
    if (wallId === null || lastEdit === null) return 'failed';
    try {
      const response = await fetch(`/api/walls/${encodeURIComponent(wallId)}/undo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRev: lastEdit.rev, actor: { kind: 'human' } }),
      });
      if (response.ok) {
        this.#update({ lastEdit: null });
        return 'undone';
      }
      if (response.status === 409) {
        this.#update({ lastEdit: null });
        return 'stale';
      }
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  // ---- Internals --------------------------------------------------------------------------------------

  async #request(command: RpcCommandInput) {
    const connection = this.#connection;
    if (connection === null) return null;
    try {
      return await connection.request(command);
    } catch {
      return null;
    }
  }

  /** Run a command; resolves with an error message, or null on success. */
  async #run(command: RpcCommandInput): Promise<string | null> {
    const response = await this.#request(command);
    if (response === null) return 'not connected';
    return response.success ? null : response.error;
  }

  #update(patch: Partial<OmpView>): void {
    this.#view = { ...this.#view, ...patch };
    this.#schedule();
  }

  #schedule(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const run = (): void => {
      this.#flushScheduled = false;
      this.#flush();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  #flush(): void {
    ompView.set(this.#view);
  }

  #reduce(frame: OmpFrame): void {
    this.#update({ conversation: reduceFrame(this.#view.conversation, frame) });
  }

  #onMessage(message: OmpServerMessage): void {
    switch (message.t) {
      case 'hello':
        this.#update({ config: message.config });
        break;
      case 'status':
        this.#update({
          server: message.status,
          ...(message.status.phase === 'ready' ? {} : { loaded: false }),
        });
        break;
      case 'snapshot': {
        const { snapshot } = message;
        this.#update({
          conversation: applySnapshot(snapshot),
          dialogs: snapshot.pendingDialogs,
          prompts: snapshot.pendingPrompts,
          state: snapshot.state,
          loaded: true,
        });
        void this.#loadCatalogues();
        void this.refreshSessions();
        break;
      }
      case 'frame':
        this.#onFrame(message.frame as OmpFrame);
        break;
      case 'prompt':
        this.#update({
          prompts: [
            ...this.#view.prompts.filter((p) => p.id !== message.request.id),
            message.request,
          ],
        });
        break;
      case 'prompt_done':
        this.#update({ prompts: this.#view.prompts.filter((prompt) => prompt.id !== message.id) });
        break;
      case 'ui_call':
        void this.#answerViewportCall(message.id, message.call);
        break;
      case 'error':
        this.#reduce({
          type: 'notice',
          level: 'error',
          message: message.message,
          source: 'server',
        });
        break;
    }
  }

  async #answerViewportCall(
    id: string,
    call: Parameters<typeof runViewportCall>[0],
  ): Promise<void> {
    try {
      const result = await runViewportCall(call);
      this.#connection?.send({ t: 'ui_result', id, ok: true, result });
    } catch (error) {
      this.#connection?.send({
        t: 'ui_result',
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #onFrame(frame: OmpFrame): void {
    switch (frame.type) {
      case 'extension_ui_request':
        this.#onUiRequest(frame);
        return;
      case 'available_commands_update':
        this.#update({ commands: frame.commands });
        return;
      case 'model_changed':
        if (frame.model !== undefined && this.#view.state !== null) {
          this.#update({ state: { ...this.#view.state, model: frame.model } });
        }
        return;
      case 'thinking_level_changed':
        if (frame.thinkingLevel !== undefined && this.#view.state !== null) {
          this.#update({ state: { ...this.#view.state, thinkingLevel: frame.thinkingLevel } });
        }
        return;
      case 'tool_execution_end': {
        this.#reduce(frame);
        const edit = agentEditOf(frame);
        if (edit !== null) this.#update({ lastEdit: edit });
        if (/todo/i.test(frame.toolName)) this.#scheduleRefresh();
        return;
      }
      case 'agent_end':
        this.#reduce(frame);
        if (frame.isTerminal !== false) {
          this.#scheduleRefresh();
          void this.refreshSessions();
        }
        if (frame.messageCount !== undefined) void this.#resync();
        return;
      default:
        this.#reduce(frame);
        if (this.#view.conversation.needsResync) void this.#resync();
    }
  }

  #onUiRequest(frame: Extract<OmpFrame, { type: 'extension_ui_request' }>): void {
    if (frame.method === 'cancel') {
      this.#update({
        dialogs: this.#view.dialogs.filter((dialog) => dialog.id !== frame.targetId),
      });
      return;
    }
    if (isDialogRequest(frame)) {
      this.#update({
        dialogs: [...this.#view.dialogs.filter((dialog) => dialog.id !== frame.id), frame],
      });
      return;
    }
    switch (frame.method) {
      case 'notify':
        this.#reduce({
          type: 'notice',
          level: frame.notifyType ?? 'info',
          message: frame.message,
          source: 'extension',
        });
        break;
      case 'setStatus': {
        const statusTexts = new Map(this.#view.statusTexts);
        if (frame.statusText === undefined || frame.statusText === '')
          statusTexts.delete(frame.statusKey);
        else statusTexts.set(frame.statusKey, frame.statusText);
        this.#update({ statusTexts });
        break;
      }
      case 'setWidget': {
        const widgets = new Map(this.#view.widgets);
        if (frame.widgetLines === undefined || frame.widgetLines.length === 0)
          widgets.delete(frame.widgetKey);
        else widgets.set(frame.widgetKey, frame.widgetLines);
        this.#update({ widgets });
        break;
      }
      case 'set_editor_text':
        this.#update({ composerFill: { text: frame.text, nonce: (this.#nonce += 1) } });
        break;
      case 'open_url':
        this.#reduce({ type: 'notice', level: 'info', message: frame.url, source: 'link' });
        break;
      default:
        break;
    }
  }

  async #resync(): Promise<void> {
    const response = await this.#request({ type: 'get_messages' });
    if (response === null) return;
    const data = responseData(response, 'get_messages');
    // While a turn runs the stream frames own the tail; only a quiescent transcript is replaced.
    if (data !== null && !this.#view.conversation.working) {
      this.#update({ conversation: replaceMessages(this.#view.conversation, data.messages) });
    }
  }

  #scheduleRefresh(): void {
    clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      void this.#refreshState();
      void this.#refreshStats();
    }, 250);
  }

  async #refreshState(): Promise<void> {
    const response = await this.#request({ type: 'get_state' });
    const state = response === null ? null : responseData(response, 'get_state');
    if (state !== null) this.#update({ state });
  }

  async #refreshStats(): Promise<void> {
    const response = await this.#request({ type: 'get_session_stats' });
    const stats = response === null ? null : responseData(response, 'get_session_stats');
    if (stats !== null) this.#update({ stats });
  }

  async #loadCatalogues(): Promise<void> {
    const [models, levels, commands] = await Promise.all([
      this.#request({ type: 'get_available_models' }),
      this.#request({ type: 'get_available_thinking_levels' }),
      this.#request({ type: 'get_available_commands' }),
    ]);
    const modelData = models === null ? null : responseData(models, 'get_available_models');
    const levelData =
      levels === null ? null : responseData(levels, 'get_available_thinking_levels');
    const commandData = commands === null ? null : responseData(commands, 'get_available_commands');
    this.#update({
      ...(modelData ? { models: modelData.models } : {}),
      ...(levelData ? { thinkingLevels: levelData.levels } : {}),
      ...(commandData ? { commands: commandData.commands } : {}),
    });
    void this.#refreshStats();
  }
}

function agentEditOf(frame: Extract<OmpFrame, { type: 'tool_execution_end' }>): AgentEdit | null {
  if (frame.toolName !== 'wall_apply' || frame.isError === true || frame.result.isError === true)
    return null;
  const details = frame.result.details;
  if (details === undefined || !isJsonObject(details)) return null;
  const { rev, changed, opCount } = details;
  if (typeof rev !== 'number' || changed !== true) return null;
  return { rev, opCount: typeof opCount === 'number' ? opCount : 1 };
}

export const omp = new OmpController();
