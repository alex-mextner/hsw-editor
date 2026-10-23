/**
 * One omp session per wall: supervises a single `omp --mode rpc-ui` child, relays its frames to the
 * attached pages, serves the wall host tools, and brokers dialogs, approvals and viewport calls.
 *
 * Invariants:
 * - at most one live child per session (`#child`); a replaced child's late callbacks are ignored;
 * - an unanswered dialog is remembered and re-sent to every (re)attaching page: omp never times it out;
 * - a page attaching mid-turn gets `get_messages` + the in-flight frames captured atomically with that
 *   response (see `InflightTracker`), then every later frame, so no message is lost or doubled.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import {
  HSW_TOOL_NAMES,
  InflightTracker,
  isDialogRequest,
  isKnownFrame,
  isJsonObject,
  responseData,
  type HswPromptAnswer,
  type HswPromptRequest,
  type JsonValue,
  type OmpClientMessage,
  type OmpDialogRequest,
  type OmpMessage,
  type OmpPhase,
  type OmpResponseFrame,
  type OmpRpcCommand,
  type OmpServerMessage,
  type OmpSessionStatus,
  type OmpSnapshot,
  type OmpState,
  type OmpUiResponse,
  type ViewportCall,
  type ViewportResult,
} from '@hsw-editor/omp-protocol';
import { OmpChild, type ChildFrame } from './child.ts';
import { childEnv, publicConfig, type OmpConfig } from './config.ts';
import { WALL_AGENT_GUIDE } from './prompt.ts';
import type { HostTool, PromptDraft, ToolFactory } from './tool-types.ts';

export interface OmpClientPort {
  readonly id: string;
  send(message: OmpServerMessage): void;
}

interface ClientRecord {
  readonly port: OmpClientPort;
  /** While true, live frames are buffered until the snapshot has been delivered. */
  syncing: boolean;
  buffer: ChildFrame[];
  lastActive: number;
}

interface PendingViewportCall {
  readonly resolve: (result: ViewportResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly clientId: string;
}

interface PendingPrompt {
  readonly request: HswPromptRequest;
  readonly resolve: (answer: HswPromptAnswer) => void;
}

export interface SessionTimings {
  readonly backoffMs: readonly number[];
  readonly maxRestarts: number;
  readonly stableAfterMs: number;
  readonly viewportTimeoutMs: number;
}

export const DEFAULT_TIMINGS: SessionTimings = {
  backoffMs: [1000, 2000, 4000, 8000, 16000],
  maxRestarts: 5,
  stableAfterMs: 60_000,
  viewportTimeoutMs: 20_000,
};

export interface SessionDeps {
  readonly wallId: string;
  readonly config: OmpConfig;
  readonly createTools: ToolFactory;
  readonly timings?: SessionTimings;
  /** Called when the session wants to be removed from the host (stopped for good). */
  readonly onDispose?: (wallId: string) => void;
  readonly ompVersion: () => Promise<string | undefined>;
  readonly log?: (message: string) => void;
}

/** Commands whose success replaces the whole transcript: every attached page needs a fresh snapshot. */
const TRANSCRIPT_RESETTING: readonly string[] = ['new_session', 'switch_session', 'fork', 'branch'];

const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OmpSession {
  readonly wallId: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly #deps: SessionDeps;
  readonly #timings: SessionTimings;
  readonly #clients = new Map<string, ClientRecord>();
  readonly #inflight = new InflightTracker();
  readonly #dialogs = new Map<string, OmpDialogRequest>();
  readonly #prompts = new Map<string, PendingPrompt>();
  readonly #viewportCalls = new Map<string, PendingViewportCall>();
  readonly #hostCalls = new Map<string, AbortController>();
  readonly #rpcOrigin = new Map<string, string>();
  #tools = new Map<string, HostTool>();
  #child: OmpChild | null = null;
  #phase: OmpPhase = 'idle';
  #error: string | undefined;
  #ompVersion: string | undefined;
  #restartAttempt = 0;
  #restartAt: number | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #stableTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #stopping = false;
  #state: OmpState | null = null;
  #uiSeq = 0;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#timings = deps.timings ?? DEFAULT_TIMINGS;
    this.wallId = deps.wallId;
    const wallDir = join(deps.config.dataDir, 'walls', deps.wallId);
    this.cwd = existsSync(wallDir) ? wallDir : deps.config.fallbackCwd;
    this.sessionDir = join(deps.config.dataDir, 'omp', deps.wallId);
  }

  get phase(): OmpPhase {
    return this.#phase;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get busy(): boolean {
    return this.#inflight.agentRunning;
  }

  get hasChild(): boolean {
    return this.#child !== null;
  }

  status(): OmpSessionStatus {
    const child = this.#child;
    return {
      phase: this.#phase,
      wallId: this.wallId,
      ...(this.#ompVersion ? { ompVersion: this.#ompVersion } : {}),
      ...(child ? { pid: child.pid } : {}),
      cwd: this.cwd,
      sessionDir: this.sessionDir,
      restartAttempt: this.#restartAttempt,
      ...(this.#restartAt !== undefined ? { restartAt: this.#restartAt } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      ...(this.#error && child ? { stderrTail: child.stderrTail } : {}),
    };
  }

  // ---- Clients ----------------------------------------------------------------------------------

  attach(port: OmpClientPort): void {
    this.#clearIdleTimer();
    const record: ClientRecord = { port, syncing: true, buffer: [], lastActive: Date.now() };
    this.#clients.set(port.id, record);
    port.send({ t: 'hello', protocol: 1, config: publicConfig(this.#deps.config) });
    port.send({ t: 'status', status: this.status() });
    if (this.#phase === 'idle' || this.#phase === 'stopped') {
      void this.#start();
    } else if (this.#phase === 'ready') {
      void this.#sendSnapshot(record);
    }
    // 'starting' / 'restarting': the snapshot goes out when the child becomes ready.
  }

  detach(clientId: string): void {
    this.#clients.delete(clientId);
    for (const [id, call] of this.#viewportCalls) {
      if (call.clientId === clientId) {
        clearTimeout(call.timer);
        this.#viewportCalls.delete(id);
        call.reject(new Error('the editor window that was asked disconnected'));
      }
    }
    for (const [id, origin] of this.#rpcOrigin) {
      if (origin === clientId) this.#rpcOrigin.delete(id);
    }
    if (this.#clients.size === 0) this.#armIdleTimer();
  }

  handleClientMessage(clientId: string, message: OmpClientMessage): void {
    const record = this.#clients.get(clientId);
    if (!record) return;
    record.lastActive = Date.now();
    switch (message.t) {
      case 'rpc':
        this.#forwardRpc(record, message.command);
        break;
      case 'ui_response':
        this.#answerDialog(message.response);
        break;
      case 'prompt_response':
        this.#answerPrompt(message.id, message.answer);
        break;
      case 'ui_result':
        this.#finishViewportCall(clientId, message);
        break;
      case 'restart':
        void this.restart();
        break;
      case 'ping':
        break;
    }
  }

  // ---- Lifecycle --------------------------------------------------------------------------------

  /** Stop the child for good (daemon shutdown or idle eviction). Pending work is cancelled. */
  async stop(reason: 'shutdown' | 'idle' | 'evicted' = 'shutdown'): Promise<void> {
    this.#stopping = true;
    this.#clearTimers();
    const child = this.#child;
    this.#cancelPending(
      reason === 'shutdown' ? 'the editor is shutting down' : 'the omp session was stopped',
    );
    this.#child = null;
    if (child) await child.close();
    this.#inflight.reset();
    this.#setPhase('stopped');
    this.#deps.onDispose?.(this.wallId);
  }

  /** Synchronous kill for process-exit hooks. */
  killNow(): void {
    this.#stopping = true;
    this.#child?.killNow();
  }

  async restart(): Promise<void> {
    this.#clearTimers();
    this.#restartAttempt = 0;
    this.#error = undefined;
    const child = this.#child;
    this.#child = null;
    this.#cancelPending('omp is restarting');
    this.#inflight.reset();
    if (child) await child.close(1500);
    this.#stopping = false;
    await this.#start();
  }

  async #start(): Promise<void> {
    if (this.#child !== null) return;
    this.#stopping = false;
    this.#restartAt = undefined;
    this.#setPhase('starting');
    this.#ompVersion ??= await this.#deps.ompVersion();
    if (this.#child !== null || this.#stopping) return;
    try {
      mkdirSync(this.sessionDir, { recursive: true });
      mkdirSync(this.cwd, { recursive: true });
    } catch (error) {
      this.#fail(`cannot create session directories: ${errorMessage(error)}`);
      return;
    }
    const config = this.#deps.config;
    const args = [
      '--mode',
      'rpc-ui',
      '--approval-mode',
      config.approvalMode,
      '--no-title',
      '--no-extensions',
      '--no-skills',
      '--no-rules',
      '--no-lsp',
      '--session-dir',
      this.sessionDir,
      '--continue',
      '--append-system-prompt',
      WALL_AGENT_GUIDE,
      ...(config.model ? ['--model', config.model] : []),
      ...(config.thinking ? ['--thinking', config.thinking] : []),
      ...config.extraArgs,
    ];
    const [bin, ...prefix] = config.command;
    if (bin === undefined) {
      this.#fail('no omp command configured');
      return;
    }
    let child: OmpChild;
    try {
      child = OmpChild.spawn(
        { command: [bin, ...prefix, ...args], cwd: this.cwd, env: childEnv(config) },
        {
          onFrame: (frame) => this.#onFrame(child, frame),
          onProtocolError: (message) => this.#deps.log?.(`omp protocol error: ${message}`),
          onExit: (exit) => this.#onExit(child, exit),
        },
      );
    } catch (error) {
      this.#fail(
        `cannot start \`${config.command.join(' ')}\`: ${errorMessage(error)}. Install omp or set omp.command in ~/.config/hsw-editor/config.json.`,
      );
      return;
    }
    this.#child = child;
  }

  #onExit(child: OmpChild, exit: { code: number | null; signal: string | null }): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#clearStableTimer();
    this.#cancelPending('omp exited');
    this.#inflight.reset();
    this.#state = null;
    if (this.#stopping) return;
    const tail = child.stderrTail.at(-1);
    const how = exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? '?'}`;
    this.#error = `omp stopped unexpectedly (${how})${tail ? `: ${tail}` : ''}`;
    this.#restartAttempt += 1;
    if (this.#restartAttempt > this.#timings.maxRestarts) {
      this.#setPhase('failed');
      return;
    }
    const delay =
      this.#timings.backoffMs[
        Math.min(this.#restartAttempt - 1, this.#timings.backoffMs.length - 1)
      ] ?? 1000;
    this.#restartAt = Date.now() + delay;
    this.#setPhase('restarting');
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void this.#start();
    }, delay);
  }

  #fail(message: string): void {
    this.#error = message;
    this.#setPhase('failed');
  }

  #setPhase(phase: OmpPhase): void {
    this.#phase = phase;
    this.#broadcast({ t: 'status', status: this.status() });
  }

  #clearStableTimer(): void {
    clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
  }

  #clearIdleTimer(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearStableTimer();
    this.#clearIdleTimer();
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
  }

  #armIdleTimer(): void {
    const idleMs = this.#deps.config.idleStopMs;
    if (idleMs <= 0 || this.#child === null) return;
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#clients.size > 0) return;
      // A turn running with nobody watching must finish (omp may be applying wall edits).
      if (this.#inflight.agentRunning || this.#prompts.size > 0 || this.#dialogs.size > 0) {
        this.#armIdleTimer();
        return;
      }
      void this.stop('idle');
    }, idleMs);
  }

  // ---- Bootstrap & snapshot ---------------------------------------------------------------------

  async #bootstrap(
    child: OmpChild,
    supportsV2: boolean,
    maxReassembledBytes: number,
  ): Promise<void> {
    try {
      if (supportsV2) {
        const negotiated = await child.request(
          { type: 'negotiate_protocol', protocolVersion: 2 },
          {
            timeoutMs: 10_000,
            sync: (frame) => frame.success && child.enableChunks(maxReassembledBytes),
          },
        );
        if (!negotiated.success) this.#deps.log?.(`omp refused protocol v2: ${negotiated.error}`);
      }
      const askDialog = await child.request(
        { type: 'set_ask_dialog', enabled: true },
        { timeoutMs: 10_000 },
      );
      if (!askDialog.success)
        this.#deps.log?.('omp does not support set_ask_dialog; ask falls back to select');
      await child.request(
        { type: 'set_event_filter', events: null, messageUpdates: 'delta' },
        { timeoutMs: 10_000 },
      );
      this.#tools = new Map(
        this.#deps
          .createTools({
            wallId: this.wallId,
            config: this.#deps.config,
            viewport: { call: (call, signal) => this.#callViewport(call, signal) },
            prompts: { ask: (toolName, draft, signal) => this.#askPrompt(toolName, draft, signal) },
          })
          .map((tool) => [tool.definition.name, tool]),
      );
      const registered = await child.request(
        {
          type: 'set_host_tools',
          tools: [...this.#tools.values()].map(({ definition }) => ({
            name: definition.name,
            label: definition.label,
            description: definition.description,
            parameters: definition.parameters,
            loadMode: 'essential',
          })),
        },
        { timeoutMs: 10_000 },
      );
      if (!registered.success) throw new Error(`set_host_tools failed: ${registered.error}`);
      const state = await child.request({ type: 'get_state' }, { timeoutMs: 15_000 });
      if (this.#child !== child) return;
      this.#state = stripState(responseData(state, 'get_state'));
      this.#error = undefined;
      this.#setPhase('ready');
      this.#stableTimer = setTimeout(() => {
        this.#restartAttempt = 0;
      }, this.#timings.stableAfterMs);
      for (const record of this.#clients.values()) {
        record.syncing = true;
        record.buffer = [];
        void this.#sendSnapshot(record);
      }
      if (this.#clients.size === 0) this.#armIdleTimer();
    } catch (error) {
      if (this.#child !== child) return;
      this.#error = `omp bootstrap failed: ${errorMessage(error)}`;
      this.#child = null;
      void child.close(1000);
      this.#restartAttempt += 1;
      this.#setPhase(this.#restartAttempt > this.#timings.maxRestarts ? 'failed' : 'restarting');
      if (this.#phase === 'restarting') {
        const retryDelay = this.#timings.backoffMs[0] ?? 1000;
        this.#restartAt = Date.now() + retryDelay;
        this.#restartTimer = setTimeout(() => {
          this.#restartTimer = undefined;
          void this.#start();
        }, retryDelay);
      }
    }
  }

  async #sendSnapshot(record: ClientRecord): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    let inflight: OmpSnapshot['inflight'] = [];
    try {
      const messagesResponse = await child.request(
        { type: 'get_messages' },
        {
          timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS,
          sync: () => {
            // Everything stdout delivered before this response is reflected in `messages` or the in-flight
            // set; everything after it must reach the page live.
            inflight = this.#inflight.replay().filter(isKnownFrame);
            record.buffer = [];
          },
        },
      );
      const stateResponse = await child.request(
        { type: 'get_state' },
        { timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS },
      );
      if (this.#child !== child || !this.#clients.has(record.port.id)) return;
      const messages: readonly OmpMessage[] =
        responseData(messagesResponse, 'get_messages')?.messages ?? [];
      const state = stripState(responseData(stateResponse, 'get_state'));
      if (state) this.#state = state;
      record.port.send({
        t: 'snapshot',
        snapshot: {
          messages,
          state: this.#state,
          inflight,
          pendingDialogs: [...this.#dialogs.values()],
          pendingPrompts: [...this.#prompts.values()].map(({ request }) => request),
        },
      });
      record.syncing = false;
      const buffered = record.buffer;
      record.buffer = [];
      for (const frame of buffered) record.port.send({ t: 'frame', frame });
    } catch (error) {
      record.syncing = false;
      record.port.send({
        t: 'error',
        message: `could not load the conversation: ${errorMessage(error)}`,
      });
    }
  }

  // ---- Frames from the child ----------------------------------------------------------------------

  #onFrame(child: OmpChild, frame: ChildFrame): void {
    if (this.#child !== child) return;
    if (!isKnownFrame(frame)) {
      this.#broadcastFrame(frame);
      return;
    }
    switch (frame.type) {
      case 'ready': {
        const versions = frame.supportedProtocolVersions ?? [frame.protocolVersion];
        void this.#bootstrap(
          child,
          versions.includes(2),
          frame.maxReassembledFrameBytes ?? 64 * 1024 * 1024,
        );
        return;
      }
      case 'response':
        this.#routeResponse(frame);
        return;
      case 'host_tool_call':
        void this.#runHostTool(child, frame.id, frame.toolName, frame.arguments);
        return;
      case 'host_tool_cancel':
        this.#hostCalls.get(frame.targetId)?.abort();
        return;
      case 'extension_ui_request':
        this.#onUiRequest(child, frame);
        return;
      default:
        break;
    }
    this.#inflight.observe(frame);
    this.#broadcastFrame(frame);
  }

  #routeResponse(frame: OmpResponseFrame): void {
    const id = frame.id;
    if (id === undefined) return;
    const originId = this.#rpcOrigin.get(id);
    if (originId === undefined) return;
    this.#rpcOrigin.delete(id);
    const record = this.#clients.get(originId);
    if (!record) return;
    const cleaned = frame.success && frame.command === 'get_state' ? withoutBulk(frame) : frame;
    record.port.send({ t: 'frame', frame: cleaned });
    if (frame.success && TRANSCRIPT_RESETTING.includes(frame.command)) {
      this.#inflight.reset();
      for (const other of this.#clients.values()) {
        other.syncing = true;
        other.buffer = [];
        void this.#sendSnapshot(other);
      }
    }
  }

  #onUiRequest(
    child: OmpChild,
    request: Extract<ChildFrame, { type: 'extension_ui_request' }>,
  ): void {
    if (request.method === 'cancel') {
      this.#dialogs.delete(request.targetId);
      this.#broadcastFrame(request);
      return;
    }
    if (!isDialogRequest(request)) {
      this.#broadcastFrame(request);
      return;
    }
    if (
      this.#deps.config.autoApproveWallTools &&
      request.method === 'select' &&
      request.options.includes('Approve') &&
      this.#isOwnToolPrompt(request.title)
    ) {
      child.send({ type: 'extension_ui_response', id: request.id, value: 'Approve' });
      return;
    }
    this.#dialogs.set(request.id, request);
    this.#broadcastFrame(request);
  }

  /** omp asks `Allow tool: <name>` before running a tool in write mode; ours are gated by our own policy. */
  #isOwnToolPrompt(title: string): boolean {
    const match = /^Allow tool: ([A-Za-z0-9_]+)$/.exec(title);
    return (
      match !== null &&
      (HSW_TOOL_NAMES as readonly string[]).includes(match[1] ?? '') &&
      this.#tools.has(match[1] ?? '')
    );
  }

  #answerDialog(response: OmpUiResponse): void {
    if (!this.#dialogs.has(response.id)) return;
    this.#dialogs.delete(response.id);
    this.#child?.send(response);
  }

  #broadcastFrame(frame: ChildFrame): void {
    for (const record of this.#clients.values()) {
      if (record.syncing) record.buffer.push(frame);
      else record.port.send({ t: 'frame', frame });
    }
  }

  #broadcast(message: OmpServerMessage): void {
    for (const record of this.#clients.values()) record.port.send(message);
  }

  // ---- RPC from pages ---------------------------------------------------------------------------

  #forwardRpc(record: ClientRecord, command: OmpRpcCommand): void {
    const child = this.#child;
    const reject = (error: string): void =>
      record.port.send({
        t: 'frame',
        frame: { type: 'response', id: command.id, command: command.type, success: false, error },
      });
    if (child === null || this.#phase !== 'ready') {
      reject(`omp is not ready (${this.#phase})`);
      return;
    }
    if (command.type === 'switch_session' && !this.#isInsideSessionDir(command.sessionPath)) {
      reject('session path is outside this wall’s session directory');
      return;
    }
    this.#rpcOrigin.set(command.id, record.port.id);
    child.send(command);
  }

  #isInsideSessionDir(path: string): boolean {
    if (!isAbsolute(path) || !existsSync(path)) return false;
    try {
      const rel = relative(realpathSync(this.sessionDir), realpathSync(resolve(path)));
      return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && dirname(rel) === '.';
    } catch {
      return false;
    }
  }

  // ---- Host tools -------------------------------------------------------------------------------

  async #runHostTool(
    child: OmpChild,
    callId: string,
    toolName: string,
    args: JsonValue,
  ): Promise<void> {
    const tool = this.#tools.get(toolName);
    const reply = (text: string, isError: boolean, extra: object = {}): void => {
      if (this.#child !== child) return;
      child.send({
        type: 'host_tool_result',
        id: callId,
        ...(isError ? { isError: true } : {}),
        result: { content: [{ type: 'text', text }], ...extra },
      });
    };
    if (!tool) {
      reply(`Unknown tool ${toolName}`, true);
      return;
    }
    const controller = new AbortController();
    this.#hostCalls.set(callId, controller);
    try {
      const result = await tool.execute(args, { wallId: this.wallId, signal: controller.signal });
      if (this.#child !== child) return;
      const failed = result.isError === true;
      child.send({
        type: 'host_tool_result',
        id: callId,
        ...(failed ? { isError: true } : {}),
        result: {
          content: result.content,
          ...(result.details !== undefined ? { details: result.details } : {}),
        },
      });
    } catch (error) {
      reply(controller.signal.aborted ? 'Cancelled' : errorMessage(error), true);
    } finally {
      this.#hostCalls.delete(callId);
    }
  }

  // ---- Prompts and viewport calls (tool -> page) ------------------------------------------------------

  #askPrompt(toolName: string, draft: PromptDraft, signal: AbortSignal): Promise<HswPromptAnswer> {
    if (this.#clients.size === 0) return Promise.resolve({ cancelled: true });
    this.#uiSeq += 1;
    const request: HswPromptRequest = {
      ...draft,
      id: `hp-${Date.now().toString(36)}-${this.#uiSeq}`,
      wallId: this.wallId,
      toolName,
    };
    return new Promise<HswPromptAnswer>((resolvePrompt) => {
      const finish = (answer: HswPromptAnswer): void => {
        if (!this.#prompts.delete(request.id)) return;
        signal.removeEventListener('abort', onAbort);
        this.#broadcast({ t: 'prompt_done', id: request.id });
        resolvePrompt(answer);
      };
      const onAbort = (): void => finish({ cancelled: true });
      signal.addEventListener('abort', onAbort, { once: true });
      this.#prompts.set(request.id, { request, resolve: finish });
      this.#broadcast({ t: 'prompt', request });
    });
  }

  #answerPrompt(id: string, answer: HswPromptAnswer): void {
    this.#prompts.get(id)?.resolve(answer);
  }

  #callViewport(call: ViewportCall, signal: AbortSignal): Promise<ViewportResult> {
    const target = [...this.#clients.values()].sort((a, b) => b.lastActive - a.lastActive)[0];
    if (!target) {
      return Promise.reject(
        new Error('no editor window is open for this wall; ask the user to open it'),
      );
    }
    this.#uiSeq += 1;
    const id = `vp-${Date.now().toString(36)}-${this.#uiSeq}`;
    return new Promise<ViewportResult>((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.#viewportCalls.delete(id);
        rejectCall(
          new Error(
            `the editor window did not answer ${call.method} in time (is the tab in the background?)`,
          ),
        );
      }, this.#timings.viewportTimeoutMs);
      signal.addEventListener(
        'abort',
        () => {
          if (this.#viewportCalls.delete(id)) {
            clearTimeout(timer);
            rejectCall(new Error('cancelled'));
          }
        },
        { once: true },
      );
      this.#viewportCalls.set(id, {
        resolve: resolveCall,
        reject: rejectCall,
        timer,
        clientId: target.port.id,
      });
      target.port.send({ t: 'ui_call', id, call });
    });
  }

  #finishViewportCall(
    clientId: string,
    message: Extract<OmpClientMessage, { t: 'ui_result' }>,
  ): void {
    const call = this.#viewportCalls.get(message.id);
    if (!call || call.clientId !== clientId) return;
    this.#viewportCalls.delete(message.id);
    clearTimeout(call.timer);
    if (message.ok) call.resolve(message.result);
    else call.reject(new Error(message.error));
  }

  #cancelPending(reason: string): void {
    this.#dialogs.clear();
    for (const [id, pending] of [...this.#prompts]) {
      pending.resolve({ cancelled: true });
      this.#prompts.delete(id);
    }
    for (const controller of this.#hostCalls.values()) controller.abort();
    this.#hostCalls.clear();
    for (const [id, call] of this.#viewportCalls) {
      clearTimeout(call.timer);
      call.reject(new Error(reason));
      this.#viewportCalls.delete(id);
    }
    this.#rpcOrigin.clear();
  }
}

/** Drop the bulky fields of `get_state` (system prompt, tool dump) before they reach pages. */
function stripState(state: OmpState | null): OmpState | null {
  if (state === null) return null;
  const {
    systemPrompt: _systemPrompt,
    dumpTools: _dumpTools,
    ...rest
  } = state as OmpState & {
    systemPrompt?: unknown;
    dumpTools?: unknown;
  };
  return rest;
}

function withoutBulk(frame: Extract<OmpResponseFrame, { success: true }>): OmpResponseFrame {
  const data = frame.data;
  if (data === undefined || !isJsonObject(data)) return frame;
  const { systemPrompt: _systemPrompt, dumpTools: _dumpTools, ...rest } = data;
  return { ...frame, data: rest };
}
