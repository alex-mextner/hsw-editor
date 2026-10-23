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
  type OmpFrame,
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
import { childEnv, publicConfig, sessionDirFor, type OmpConfig } from './config.ts';
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
  /** Bumped per snapshot attempt so an overtaken snapshot discards itself. */
  epoch: number;
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
  /** How long a spawned child may take to send `ready` before it is killed and restarted. */
  readonly readyTimeoutMs: number;
}

export const DEFAULT_TIMINGS: SessionTimings = {
  backoffMs: [1000, 2000, 4000, 8000, 16000],
  maxRestarts: 5,
  stableAfterMs: 60_000,
  viewportTimeoutMs: 20_000,
  readyTimeoutMs: 60_000,
};

export interface SessionDeps {
  readonly wallId: string;
  readonly config: OmpConfig;
  readonly createTools: ToolFactory;
  readonly timings?: SessionTimings;
  /**
   * Called synchronously when the session is stopped for good, before its child has exited, so the host
   * stops handing it out; `closed` settles when the child is gone.
   */
  readonly onDispose?: (session: OmpSession, closed: Promise<void>) => void;
  readonly ompVersion: () => Promise<string | undefined>;
  readonly log?: (message: string) => void;
}

/** Commands whose success replaces the whole transcript: every attached page needs a fresh snapshot. */
const TRANSCRIPT_RESETTING: readonly string[] = ['new_session', 'switch_session', 'fork', 'branch'];

const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;

/** Commands whose success is followed by a `prompt_result` with the same id. */
const PROMPT_COMMANDS: readonly string[] = ['prompt', 'abort_and_prompt'];

/**
 * A prompt is followed by a `prompt_result` with the same id (also after a late error response), except
 * builtin slash commands (`agentInvoked: false`), which never get one.
 */
function awaitsPromptResult(frame: OmpResponseFrame): boolean {
  if (!PROMPT_COMMANDS.includes(frame.command)) return false;
  if (!frame.success) return true;
  const data = frame.data;
  return !(data !== undefined && isJsonObject(data) && data['agentInvoked'] === false);
}

/** An extension may veto a session change: omp then answers success with `data.cancelled: true`. */
function wasVetoed(frame: Extract<OmpResponseFrame, { success: true }>): boolean {
  const data = frame.data;
  return data !== undefined && isJsonObject(data) && data['cancelled'] === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OmpSession {
  readonly wallId: string;
  readonly sessionDir: string;
  readonly #phaseWaiters = new Set<() => void>();
  readonly #deps: SessionDeps;
  readonly #timings: SessionTimings;
  readonly #clients = new Map<string, ClientRecord>();
  readonly #inflight = new InflightTracker();
  readonly #dialogs = new Map<string, OmpDialogRequest>();
  readonly #prompts = new Map<string, PendingPrompt>();
  readonly #viewportCalls = new Map<string, PendingViewportCall>();
  readonly #hostCalls = new Map<string, AbortController>();
  /** Wire id sent to omp -> the page that issued the command and the id it used. */
  readonly #rpcOrigin = new Map<string, { readonly clientId: string; readonly id: string }>();
  #tools = new Map<string, HostTool>();
  #child: OmpChild | null = null;
  #phase: OmpPhase = 'idle';
  #error: string | undefined;
  #ompVersion: string | undefined;
  #restartAttempt = 0;
  #restartAt: number | undefined;
  #restartTimer: NodeJS.Timeout | undefined;
  #stableTimer: NodeJS.Timeout | undefined;
  #readyTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #stopping = false;
  #restarting = false;
  /** Children told to exit that have not yet: `killNow` and a later `stop` must still reach them. */
  readonly #closingChildren = new Set<OmpChild>();
  #closed: Promise<void> | null = null;
  #crashStderr: readonly string[] | undefined;
  #state: OmpState | null = null;
  #uiSeq = 0;

  constructor(deps: SessionDeps) {
    this.#deps = deps;
    this.#timings = deps.timings ?? DEFAULT_TIMINGS;
    this.wallId = deps.wallId;
    this.sessionDir = sessionDirFor(deps.config, deps.wallId);
  }

  /** The wall's own directory while it exists (a deleted wall must not be recreated), else the shared fallback. */
  get cwd(): string {
    const wallDir = join(this.#deps.config.dataDir, 'walls', this.wallId);
    return existsSync(wallDir) ? wallDir : this.#deps.config.fallbackCwd;
  }

  /** Resolves true once the child is ready; false if the session fails or stops, or `timeoutMs` passes. */
  whenReady(timeoutMs = 30_000): Promise<boolean> {
    return new Promise<boolean>((done) => {
      const settle = (ready: boolean): void => {
        clearTimeout(timer);
        this.#phaseWaiters.delete(check);
        done(ready);
      };
      const check = (): void => {
        if (this.#phase === 'ready') settle(true);
        else if (this.#phase === 'failed' || this.#phase === 'stopped') settle(false);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      this.#phaseWaiters.add(check);
      check();
    });
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

  /** Counts against the host's child cap: a child exists or is about to (starting / waiting / restarting). */
  get occupiesSlot(): boolean {
    return (
      this.#child !== null ||
      this.#restarting ||
      this.#phase === 'starting' ||
      this.#phase === 'restarting'
    );
  }

  hasClient(clientId: string): boolean {
    return this.#clients.has(clientId);
  }

  /** Settles when the child of a stopped session has exited; null while the session is live. */
  get closed(): Promise<void> | null {
    return this.#closed;
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
      ...(this.#error ? { stderrTail: this.#crashStderr ?? child?.stderrTail ?? [] } : {}),
    };
  }

  // ---- Clients ----------------------------------------------------------------------------------

  attach(port: OmpClientPort): void {
    if (this.#closed !== null) throw new Error('the omp session was stopped');
    this.#clearIdleTimer();
    const record: ClientRecord = {
      port,
      syncing: true,
      buffer: [],
      lastActive: Date.now(),
      epoch: 0,
    };
    this.#clients.set(port.id, record);
    port.send({ t: 'hello', protocol: 1, config: publicConfig(this.#deps.config) });
    port.send({ t: 'status', status: this.status() });
    if (this.#phase === 'idle') {
      void this.#start();
    } else if (this.#phase === 'ready') {
      this.#resync(record);
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
      if (origin.clientId === clientId) this.#rpcOrigin.delete(id);
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
        // Routed through `OmpHost.restart` by the socket layer so the child cap applies.
        break;
      case 'ping':
        break;
    }
  }

  // ---- Lifecycle --------------------------------------------------------------------------------

  /**
   * Stop the session for good (daemon shutdown, idle eviction or the user's stop button). The session leaves
   * the host immediately, so a page attaching meanwhile gets a fresh one; the returned promise settles when
   * the child has exited. Pending work is cancelled.
   */
  stop(reason: 'shutdown' | 'idle' | 'evicted' | 'user' = 'shutdown'): Promise<void> {
    if (this.#closed !== null) return this.#closed;
    this.#stopping = true;
    this.#clearTimers();
    const toClose = [...(this.#child ? [this.#child] : []), ...this.#closingChildren];
    this.#cancelPending(
      reason === 'shutdown' ? 'the editor is shutting down' : 'the omp session was stopped',
    );
    this.#child = null;
    this.#setPhase('stopped');
    this.#closed = (async () => {
      await Promise.all(toClose.map((child) => this.#closeChild(child)));
      this.#inflight.reset();
    })();
    this.#deps.onDispose?.(this, this.#closed);
    return this.#closed;
  }

  /** Synchronous kill for process-exit hooks. */
  killNow(): void {
    this.#stopping = true;
    this.#child?.killNow();
    for (const child of this.#closingChildren) child.killNow();
  }

  async restart(): Promise<void> {
    if (this.#closed !== null || this.#restarting) return;
    this.#restarting = true;
    try {
      this.#clearTimers();
      this.#restartAttempt = 0;
      this.#error = undefined;
      this.#crashStderr = undefined;
      this.#setPhase('restarting');
      const child = this.#child;
      this.#child = null;
      this.#cancelPending('omp is restarting');
      this.#inflight.reset();
      if (child) await this.#closeChild(child, 1500);
      if (this.#closed !== null) return;
      this.#stopping = false;
      await this.#start();
    } finally {
      this.#restarting = false;
    }
  }

  #closeChild(child: OmpChild, graceMs?: number): Promise<void> {
    this.#closingChildren.add(child);
    return child.close(graceMs).finally(() => this.#closingChildren.delete(child));
  }

  async #start(): Promise<void> {
    if (this.#child !== null || this.#closed !== null) return;
    this.#stopping = false;
    this.#restartAt = undefined;
    this.#setPhase('starting');
    this.#ompVersion ??= await this.#deps.ompVersion();
    if (this.#child !== null || this.#stopping) return;
    try {
      mkdirSync(this.sessionDir, { recursive: true });
      mkdirSync(this.#deps.config.fallbackCwd, { recursive: true });
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
    this.#readyTimer = setTimeout(() => {
      if (this.#child !== child) return;
      this.#error = `omp did not become ready within ${this.#timings.readyTimeoutMs} ms`;
      this.#crashStderr = child.stderrTail;
      this.#child = null;
      void this.#closeChild(child, 1000);
      this.#restartAttempt += 1;
      this.#scheduleRestart();
    }, this.#timings.readyTimeoutMs);
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
    this.#crashStderr = child.stderrTail;
    this.#restartAttempt += 1;
    this.#scheduleRestart();
  }

  /** Back off and start again, or give up (`failed`) once `maxRestarts` consecutive attempts failed. */
  #scheduleRestart(): void {
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
    for (const waiter of [...this.#phaseWaiters]) waiter();
  }

  #clearStableTimer(): void {
    clearTimeout(this.#stableTimer);
    this.#stableTimer = undefined;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
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
      this.#crashStderr = undefined;
      this.#setPhase('ready');
      this.#stableTimer = setTimeout(() => {
        this.#restartAttempt = 0;
      }, this.#timings.stableAfterMs);
      for (const record of this.#clients.values()) this.#resync(record);
      if (this.#clients.size === 0) this.#armIdleTimer();
    } catch (error) {
      if (this.#child !== child) return;
      this.#error = `omp bootstrap failed: ${errorMessage(error)}`;
      this.#crashStderr = child.stderrTail;
      this.#child = null;
      void this.#closeChild(child, 1000);
      this.#restartAttempt += 1;
      this.#scheduleRestart();
    }
  }

  /** Hold live frames back and send `record` a fresh snapshot (an older in-flight snapshot is discarded). */
  #resync(record: ClientRecord): void {
    record.syncing = true;
    record.buffer = [];
    void this.#sendSnapshot(record);
  }

  async #sendSnapshot(record: ClientRecord): Promise<void> {
    const child = this.#child;
    if (child === null) return;
    record.epoch += 1;
    const epoch = record.epoch;
    let inflight: OmpSnapshot['inflight'] = [];
    let pendingDialogs: OmpDialogRequest[] = [];
    try {
      const messagesResponse = await child.request(
        { type: 'get_messages' },
        {
          timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS,
          sync: () => {
            if (record.epoch !== epoch) return;
            // Everything stdout delivered before this response is reflected in `messages` or the in-flight
            // set; everything after it must reach the page live.
            inflight = this.#inflight.replay().filter(isKnownFrame);
            // Taken at the same instant: a dialog arriving later is buffered as a frame instead.
            pendingDialogs = [...this.#dialogs.values()];
            record.buffer = [];
          },
        },
      );
      const stateResponse = await child.request(
        { type: 'get_state' },
        { timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS },
      );
      if (record.epoch !== epoch) return;
      if (this.#child !== child || !this.#clients.has(record.port.id)) return;
      if (!messagesResponse.success) {
        throw new Error(`omp refused get_messages: ${messagesResponse.error}`);
      }
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
          pendingDialogs,
          pendingPrompts: [...this.#prompts.values()].map(({ request }) => request),
        },
      });
      record.syncing = false;
      const buffered = record.buffer;
      record.buffer = [];
      for (const frame of buffered) record.port.send({ t: 'frame', frame });
    } catch (error) {
      if (record.epoch !== epoch) return;
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
        clearTimeout(this.#readyTimer);
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
      case 'prompt_result':
        this.#routePromptResult(frame);
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
    // A transcript-replacing command resets every page, even if the page that sent it has since left.
    if (frame.success && TRANSCRIPT_RESETTING.includes(frame.command) && !wasVetoed(frame)) {
      this.#inflight.reset();
      for (const other of this.#clients.values()) this.#resync(other);
    }
    const id = frame.id;
    if (id === undefined) return;
    const origin = this.#rpcOrigin.get(id);
    if (origin === undefined) return;
    // An accepted prompt is followed by a `prompt_result` carrying the same id: keep the mapping for it.
    if (!awaitsPromptResult(frame)) this.#rpcOrigin.delete(id);
    const record = this.#clients.get(origin.clientId);
    if (!record) return;
    const restored = { ...frame, id: origin.id };
    const cleaned =
      restored.success && restored.command === 'get_state' ? withoutBulk(restored) : restored;
    record.port.send({ t: 'frame', frame: cleaned });
  }

  /** `prompt_result` goes to the page that sent the prompt under its own id; other pages get it without an id. */
  #routePromptResult(frame: Extract<OmpFrame, { type: 'prompt_result' }>): void {
    const origin = frame.id === undefined ? undefined : this.#rpcOrigin.get(frame.id);
    if (frame.id !== undefined) this.#rpcOrigin.delete(frame.id);
    const { id: _wireId, ...anonymous } = frame;
    for (const record of this.#clients.values()) {
      const own = origin !== undefined && origin.clientId === record.port.id;
      const outgoing = own ? { ...anonymous, id: origin.id } : anonymous;
      if (record.syncing) record.buffer.push(outgoing);
      else record.port.send({ t: 'frame', frame: outgoing });
    }
    this.#inflight.observe(frame);
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
    const name = /^Allow tool: ([A-Za-z0-9_]+)$/.exec(title)?.[1];
    return (
      name !== undefined &&
      (HSW_TOOL_NAMES as readonly string[]).includes(name) &&
      this.#tools.has(name)
    );
  }

  #answerDialog(response: OmpUiResponse): void {
    if (!this.#dialogs.has(response.id)) return;
    this.#dialogs.delete(response.id);
    this.#child?.send(response);
    // Other attached pages still show the dialog: tell them it is settled.
    this.#broadcastFrame({
      type: 'extension_ui_request',
      id: `settled-${response.id}`,
      method: 'cancel',
      targetId: response.id,
    });
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
    const wireId = `${record.port.id}:${command.id}`;
    this.#rpcOrigin.set(wireId, { clientId: record.port.id, id: command.id });
    child.send({ ...command, id: wireId });
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
    const reply = (text: string, isError: boolean): void => {
      if (this.#child !== child) return;
      child.send({
        type: 'host_tool_result',
        id: callId,
        ...(isError ? { isError: true } : {}),
        result: { content: [{ type: 'text', text }] },
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
  #nextUiId(prefix: 'hp' | 'vp'): string {
    this.#uiSeq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.#uiSeq}`;
  }

  #askPrompt(toolName: string, draft: PromptDraft, signal: AbortSignal): Promise<HswPromptAnswer> {
    if (this.#clients.size === 0 || signal.aborted) return Promise.resolve({ cancelled: true });
    const request: HswPromptRequest = {
      ...draft,
      id: this.#nextUiId('hp'),
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
    let target: ClientRecord | undefined;
    for (const record of this.#clients.values()) {
      if (target === undefined || record.lastActive > target.lastActive) target = record;
    }
    if (!target) {
      return Promise.reject(
        new Error('no editor window is open for this wall; ask the user to open it'),
      );
    }
    const id = this.#nextUiId('vp');
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
    for (const pending of [...this.#prompts.values()]) pending.resolve({ cancelled: true });
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
