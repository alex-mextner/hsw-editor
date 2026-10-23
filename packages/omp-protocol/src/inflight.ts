/**
 * Tracks the part of a turn that `get_messages` cannot reconstruct: the assistant message that is
 * still streaming and tool executions that have started but not finished. A client that attaches
 * mid-turn gets these frames replayed through its normal reducer after the message snapshot.
 */
import { isKnownFrame, type OmpFrame, type OmpUnknownFrame } from './rpc.ts';

/** Per-message frame cap: a runaway stream is truncated to a fresh `message_start`-less tail. */
const MAX_FRAMES_PER_MESSAGE = 20_000;

export class InflightTracker {
  #agentRunning = false;
  #messageId: string | null = null;
  #messageFrames: OmpFrame[] = [];
  readonly #tools = new Map<string, { start: OmpFrame; update: OmpFrame | null }>();

  /** True between `agent_start` and the terminal `agent_end`. */
  get agentRunning(): boolean {
    return this.#agentRunning;
  }

  observe(unmodelled: OmpFrame | OmpUnknownFrame): void {
    if (!isKnownFrame(unmodelled)) return;
    const frame = unmodelled;
    switch (frame.type) {
      case 'agent_start':
        this.#agentRunning = true;
        break;
      case 'agent_end':
        // Non-terminal ends (retry, compaction continuation) keep the turn alive.
        if (frame.isTerminal !== false) this.reset();
        break;
      case 'message_start':
        this.#messageId = frame.messageId ?? null;
        this.#messageFrames = [frame];
        break;
      case 'message_update':
        if (this.#messageFrames.length > 0 && this.#messageFrames.length < MAX_FRAMES_PER_MESSAGE) {
          this.#messageFrames.push(frame);
        }
        break;
      case 'message_end':
        if ((frame.messageId ?? null) === this.#messageId) {
          this.#messageId = null;
          this.#messageFrames = [];
        }
        break;
      case 'tool_execution_start':
        this.#tools.set(frame.toolCallId, { start: frame, update: null });
        break;
      case 'tool_execution_update': {
        const entry = this.#tools.get(frame.toolCallId);
        if (entry) entry.update = frame;
        break;
      }
      case 'tool_execution_end':
        this.#tools.delete(frame.toolCallId);
        break;
      default:
        break;
    }
  }

  /** Drop everything: the child restarted or the session was replaced. */
  reset(): void {
    this.#agentRunning = false;
    this.#messageId = null;
    this.#messageFrames = [];
    this.#tools.clear();
  }

  /** Frames to replay after the message snapshot, in an order the reducer accepts. */
  replay(): OmpFrame[] {
    const frames: OmpFrame[] = [];
    if (this.#agentRunning) frames.push({ type: 'agent_start' });
    frames.push(...this.#messageFrames);
    for (const { start, update } of this.#tools.values()) {
      frames.push(start);
      if (update !== null) frames.push(update);
    }
    return frames;
  }
}
