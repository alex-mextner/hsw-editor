/**
 * The command palette's AI bridge on top of the omp panel's connection: a palette question becomes a
 * `prompt` in "palette mode" on the panel's session, the streamed assistant text becomes `AiEvent`s, and the
 * `app_command` tool calls of the agent are answered by the page-side handler the palette registers.
 *
 * The bridge never opens a socket: everything goes through {@link PaletteTransport}, which the omp store
 * implements over its single connection (and tests implement with a fake).
 */
import type {
  AiAskRequest,
  AiBridgeStatus,
  AiEvent,
  AiRun,
  AppCommandResult,
  Disposer,
  PaletteAiBridge,
} from '@hsw-editor/commands';
import { isWireMessage, type OmpFrame, type OmpPhase } from '@hsw-editor/omp-protocol';
import { buildPalettePrompt } from './paletteMode.ts';
import type { ConnectionPhase } from './render-types.ts';

/** What the bridge needs to know about the shared omp connection. */
export interface PaletteLink {
  readonly phase: ConnectionPhase;
  /** The supervised omp child of the wall; null before the server reported it. */
  readonly server: OmpPhase | null;
  /** The server delivered the conversation snapshot, so commands are accepted. */
  readonly loaded: boolean;
  /** The agent is answering something already (from the panel). */
  readonly working: boolean;
}

export type PromptAck =
  | { readonly ok: true; readonly agentInvoked: boolean }
  | { readonly ok: false; readonly error: string };

export type AppCommandHandler = (
  request: unknown,
  signal?: AbortSignal,
) => Promise<AppCommandResult>;

export interface PaletteTransport {
  link(): PaletteLink;
  onLink(listener: () => void): Disposer;
  /** Every omp frame of the session (the connection already consumed command responses). */
  onFrame(listener: (frame: OmpFrame) => void): Disposer;
  /** Sends a `prompt` command; resolves when omp accepted or refused it. */
  prompt(message: string): Promise<PromptAck>;
  abort(): void;
  /** Handles `ui_call`s with method `app_command`; replaces an earlier handler until disposed. */
  setAppCommandHandler(handler: AppCommandHandler): Disposer;
}

export function statusOf(link: PaletteLink): AiBridgeStatus {
  if (link.phase === 'closed') return 'unavailable';
  if (link.phase !== 'live') return 'connecting';
  switch (link.server) {
    case 'failed':
      return 'unavailable';
    case 'ready':
      return link.loaded ? 'ready' : 'connecting';
    // The next command brings up a fresh omp after the user stopped it.
    case 'stopped':
      return 'ready';
    default:
      return 'connecting';
  }
}

const BUSY_MESSAGE = 'the agent is busy with another request; try again when it has finished';
const LOST_MESSAGE = 'the connection to the agent was lost';
const STOPPED_MESSAGE = 'the agent was stopped';
const FAILED_MESSAGE = 'the agent failed to answer';

/** How long a new question waits for the turn of a cancelled one to end before asking omp anyway. */
const DRAIN_TIMEOUT_MS = 8000;

/** Why a run in progress can no longer finish, given how the link changed; null while it can. */
function lostReason(before: PaletteLink, now: PaletteLink): string | null {
  if (now.phase !== 'live' || now.server === 'failed' || now.server === 'restarting') {
    return LOST_MESSAGE;
  }
  // omp drops the frames of a stopped child, so no `agent_end` would ever arrive.
  if (now.server === 'stopped' && before.server !== 'stopped') return STOPPED_MESSAGE;
  return null;
}

/** The last frame of an omp turn. */
function endsTurn(frame: OmpFrame): boolean {
  return (
    (frame.type === 'agent_end' && frame.isTerminal !== false) || frame.type === 'session_settled'
  );
}

const blockKey = (messageId: string | undefined, contentIndex: number): string =>
  `${messageId ?? ''}:${contentIndex}`;

/** Turns the text blocks of the assistant messages of one turn into the palette answer. */
function createAnswerStream(emit: (event: AiEvent) => void) {
  const seen = new Map<string, number>();
  let emitted = 0;

  /** `text` is the part of the block not yet shown. */
  const push = (key: string, text: string): void => {
    if (text.length === 0) return;
    const shown = seen.get(key);
    // A later block (after a tool call) starts a new paragraph.
    const separator = shown === undefined && emitted > 0 ? '\n\n' : '';
    seen.set(key, (shown ?? 0) + text.length);
    emitted += text.length;
    emit({ t: 'delta', text: `${separator}${text}` });
  };

  return {
    delta: (messageId: string | undefined, contentIndex: number, text: string): void =>
      push(blockKey(messageId, contentIndex), text),
    /** The finished block: shows whatever the deltas did not carry. */
    end: (messageId: string | undefined, contentIndex: number, content: string): void => {
      const key = blockKey(messageId, contentIndex);
      const shown = seen.get(key) ?? 0;
      if (content.length > shown) push(key, content.slice(shown));
    },
  };
}

export function createOmpPaletteBridge(transport: PaletteTransport): PaletteAiBridge {
  /**
   * Set while the omp turn of a cancelled palette run is still ending. A new question waits for it instead of
   * being refused as "busy" because of the very run it replaces.
   */
  let draining: Promise<void> | null = null;

  const drainCancelledTurn = (prompt: Promise<PromptAck>): void => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const stops: Disposer[] = [];
    const done = (): void => {
      clearTimeout(timer);
      for (const stop of stops.splice(0)) stop();
      if (draining === promise) draining = null;
      resolve();
    };
    const timer = setTimeout(done, DRAIN_TIMEOUT_MS);
    let before = transport.link();
    stops.push(
      transport.onFrame((frame) => {
        if (endsTurn(frame)) done();
      }),
      transport.onLink(() => {
        const now = transport.link();
        if (lostReason(before, now) !== null) done();
        before = now;
      }),
    );
    // A prompt omp refused (or handled itself) starts no turn, so there is nothing to wait for.
    void prompt.then((ack) => {
      if (!ack.ok || !ack.agentInvoked) done();
    });
    draining = promise;
  };

  const status = (): AiBridgeStatus => statusOf(transport.link());

  const onStatus = (listener: (status: AiBridgeStatus) => void): Disposer => {
    let last = status();
    return transport.onLink(() => {
      const next = status();
      if (next === last) return;
      last = next;
      listener(next);
    });
  };

  const ask = (request: AiAskRequest, onEvent: (event: AiEvent) => void): AiRun => {
    let finished = false;
    let sent: Promise<PromptAck> | null = null;
    const disposers: Disposer[] = [];
    const finish = (): void => {
      finished = true;
      for (const dispose of disposers.splice(0)) dispose();
    };
    /** Delivers an event; the first one that is not a `delta` ends the run. */
    const deliver = (event: AiEvent): void => {
      if (finished) return;
      if (event.t !== 'delta') finish();
      onEvent(event);
    };

    const run = (): void => {
      if (finished) return;
      if (transport.link().working) {
        deliver({ t: 'error', message: BUSY_MESSAGE });
        return;
      }
      const answer = createAnswerStream(deliver);
      // A model failure that omp retried successfully must not turn the answer into an error.
      let failure: string | null = null;
      const finishTurn = (): void =>
        deliver(failure === null ? { t: 'done' } : { t: 'error', message: failure });
      // A `prompt_result` that arrives before omp answered our prompt belongs to an earlier (cancelled) one.
      let accepted = false;
      let started = false;
      let before = transport.link();
      disposers.push(
        transport.onFrame((frame) => {
          switch (frame.type) {
            case 'agent_start':
              started = true;
              failure = null;
              return;
            case 'message_update': {
              const event = frame.assistantMessageEvent;
              if (event.type === 'text_delta') {
                answer.delta(frame.messageId, event.contentIndex, event.delta);
              } else if (event.type === 'text_end') {
                answer.end(frame.messageId, event.contentIndex, event.content);
              }
              return;
            }
            case 'message_end': {
              const { message } = frame;
              if (isWireMessage(message) && message.role === 'assistant') {
                failure =
                  message.stopReason === 'error' ? (message.errorMessage ?? FAILED_MESSAGE) : null;
              }
              return;
            }
            case 'prompt_result':
              // Only the page that sent the prompt gets the id back; other pages' results are not ours.
              if (
                accepted &&
                frame.id !== undefined &&
                (frame.status === 'error' || frame.error !== undefined)
              ) {
                deliver({ t: 'error', message: frame.error ?? 'the agent refused the request' });
              }
              return;
            default:
              // A trailing `session_settled` of an earlier turn must not end this one before it has started.
              if (endsTurn(frame) && (started || frame.type === 'agent_end')) finishTurn();
          }
        }),
        transport.onLink(() => {
          const now = transport.link();
          const prior = before;
          const lost = lostReason(prior, now);
          before = now;
          if (lost !== null) deliver({ t: 'error', message: lost });
          // A snapshot (another page started a new session) can carry the end of our turn without a frame.
          else if (started && prior.working && !now.working) finishTurn();
        }),
      );

      sent = transport.prompt(buildPalettePrompt(request.text, request.locale));
      void sent.then((ack) => {
        accepted = ack.ok;
        if (!ack.ok) deliver({ t: 'error', message: ack.error });
        // A prompt omp handled itself (a builtin command) never starts the agent: nothing will stream.
        else if (!ack.agentInvoked) deliver({ t: 'done' });
      });
    };

    if (draining === null && transport.link().working) {
      deliver({ t: 'error', message: BUSY_MESSAGE });
      return { cancel: () => undefined };
    }
    if (draining === null) run();
    else void draining.then(run);

    return {
      cancel: () => {
        if (finished) return;
        finish();
        // Cancelled while still waiting for the previous turn: nothing was sent, nothing to abort.
        if (sent === null) return;
        transport.abort();
        drainCancelledTurn(sent);
      },
    };
  };

  return {
    status,
    onStatus,
    ask,
    setAppCommandHandler: (handler) => transport.setAppCommandHandler(handler),
  };
}
