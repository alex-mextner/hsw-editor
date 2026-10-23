/**
 * Pure reducer from omp frames to what the transcript renders. The server sends text/thinking/tool-call
 * *deltas* (`set_event_filter messageUpdates: "delta"`); this module assembles them, so every rule here
 * has a counterpart in `InflightTracker` (what the server replays to a late-attaching page).
 *
 * Invariant relied on by `applySnapshot`: `messages` + the replayed in-flight frames + all later frames
 * produce exactly the same conversation as having watched every frame from the start.
 */
import type {
  AssistantContent,
  AssistantMessage,
  SessionEntry,
  TextContent,
  ToolCallContent,
} from '@oh-my-pi/pi-wire';
import {
  isWireMessage,
  type OmpAssistantStreamEvent,
  type OmpFrame,
  type OmpMessage,
  type OmpOtherMessage,
  type OmpQueuedMessages,
  type OmpSnapshot,
  type OmpWireMessage,
} from '@hsw-editor/omp-protocol';
import { unwrapPalettePrompt } from './paletteMode.ts';
import type { ActiveTool } from './render-types.ts';

export interface RetryInfo {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  /** Epoch ms when the retry starts (computed when the frame arrived). */
  readonly until: number;
  readonly errorMessage: string;
}

export interface Notice {
  readonly id: number;
  readonly level: 'info' | 'warning' | 'error';
  readonly text: string;
  readonly source?: string;
}

export interface Conversation {
  readonly entries: readonly SessionEntry[];
  /** The assistant message being streamed, assembled from deltas. */
  readonly stream: AssistantMessage | null;
  readonly streamId: string | null;
  readonly activeTools: ReadonlyMap<string, ActiveTool>;
  readonly working: boolean;
  readonly queue: OmpQueuedMessages;
  readonly retry: RetryInfo | null;
  readonly compacting: boolean;
  readonly notices: readonly Notice[];
  /** Set when a frame could not be applied faithfully; the store re-reads the transcript. */
  readonly needsResync: boolean;
  readonly nextEntryId: number;
  readonly nextNoticeId: number;
}

const MAX_NOTICES = 30;
const EMPTY_QUEUE: OmpQueuedMessages = { steering: [], followUp: [] };

export function emptyConversation(): Conversation {
  return {
    entries: [],
    stream: null,
    streamId: null,
    activeTools: new Map(),
    working: false,
    queue: EMPTY_QUEUE,
    retry: null,
    compacting: false,
    notices: [],
    needsResync: false,
    nextEntryId: 1,
    nextNoticeId: 1,
  };
}

// ---- Messages -> entries ---------------------------------------------------------------------------

function isoTime(timestamp: number | undefined): string {
  return new Date(timestamp ?? Date.now()).toISOString();
}

function textContent(message: OmpOtherMessage): string {
  if (typeof message.content === 'string') return message.content;
  return (message.content ?? [])
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** Marks a question that came from the command palette; the instruction block is not shown. */
const PALETTE_MARK = '⌘K · ';

/** `text` as shown in the transcript: a palette-mode prompt becomes the question alone, marked; else null. */
function paletteQuestion(text: string): string | null {
  const question = unwrapPalettePrompt(text);
  return question === null ? null : `${PALETTE_MARK}${question}`;
}

function showPaletteQuestion(message: OmpWireMessage): OmpWireMessage {
  if (message.role !== 'user') return message;
  const { content } = message;
  if (typeof content === 'string') {
    const shown = paletteQuestion(content);
    return shown === null ? message : { ...message, content: shown };
  }
  let changed = false;
  const blocks = content.map((block) => {
    const shown = block.type === 'text' ? paletteQuestion(block.text) : null;
    if (shown === null) return block;
    changed = true;
    return { ...block, text: shown };
  });
  return changed ? { ...message, content: blocks } : message;
}

/** Entry for a completed message, or null when the transcript has nothing to show for it. */
function entryFor(message: OmpMessage, id: string, parentId: string | null): SessionEntry | null {
  const base = { id, parentId, timestamp: isoTime(message.timestamp) };
  if (isWireMessage(message))
    return { ...base, type: 'message', message: showPaletteQuestion(message) };
  switch (message.role) {
    case 'custom':
      return message.display === false || message.content === undefined
        ? null
        : {
            ...base,
            type: 'custom_message',
            customType: message.customType ?? 'custom',
            content: message.content,
            display: true,
          };
    case 'bashExecution': {
      const output = message.output ?? '';
      return {
        ...base,
        type: 'custom_message',
        customType: 'bash',
        content: `$ ${message.command ?? ''}\n${output}`.trimEnd(),
        display: true,
      };
    }
    case 'compactionSummary':
      return {
        ...base,
        type: 'compaction',
        summary: message.summary ?? '',
        firstKeptEntryId: id,
        tokensBefore: 0,
      };
    case 'branchSummary':
      return { ...base, type: 'branch_summary', fromId: id, summary: message.summary ?? '' };
    default: {
      const text = textContent(message);
      return text.length === 0
        ? null
        : {
            ...base,
            type: 'custom_message',
            customType: message.role,
            content: text,
            display: true,
          };
    }
  }
}

function appendMessage(conversation: Conversation, message: OmpMessage): Conversation {
  const parentId = conversation.entries.at(-1)?.id ?? null;
  const entry = entryFor(message, `e${conversation.nextEntryId}`, parentId);
  if (entry === null) return { ...conversation, nextEntryId: conversation.nextEntryId + 1 };
  return {
    ...conversation,
    entries: [...conversation.entries, entry],
    nextEntryId: conversation.nextEntryId + 1,
  };
}

// ---- Streaming assembly ------------------------------------------------------------------------------

function blockAt(
  content: readonly AssistantContent[],
  index: number,
): AssistantContent | undefined {
  return content[index];
}

function withBlock(
  message: AssistantMessage,
  index: number,
  block: AssistantContent,
): AssistantMessage {
  const content = [...message.content];
  while (content.length < index) content.push({ type: 'text', text: '' });
  content[index] = block;
  return { ...message, content };
}

function emptyAssistant(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function placeholderToolCall(index: number): ToolCallContent {
  return { type: 'toolCall', id: `pending-${index}`, name: '…', arguments: {} };
}

function applyStreamEvent(
  stream: AssistantMessage,
  event: OmpAssistantStreamEvent,
): AssistantMessage {
  switch (event.type) {
    // A `*_start` (re)creates its block empty: `message_start` already carries the first delta's text.
    case 'text_start':
      return withBlock(stream, event.contentIndex, { type: 'text', text: '' });
    case 'thinking_start':
      return withBlock(stream, event.contentIndex, { type: 'thinking', thinking: '' });
    case 'toolcall_start':
      return withBlock(stream, event.contentIndex, placeholderToolCall(event.contentIndex));
    case 'text_delta': {
      const block = blockAt(stream.content, event.contentIndex);
      const text = block?.type === 'text' ? block.text : '';
      return withBlock(stream, event.contentIndex, { type: 'text', text: text + event.delta });
    }
    case 'thinking_delta': {
      const block = blockAt(stream.content, event.contentIndex);
      const thinking = block?.type === 'thinking' ? block.thinking : '';
      return withBlock(stream, event.contentIndex, {
        type: 'thinking',
        thinking: thinking + event.delta,
      });
    }
    case 'text_end':
      return withBlock(stream, event.contentIndex, { type: 'text', text: event.content });
    case 'thinking_end':
      return withBlock(stream, event.contentIndex, { type: 'thinking', thinking: event.content });
    case 'toolcall_end':
      return withBlock(stream, event.contentIndex, event.toolCall);
    default:
      return stream;
  }
}

// ---- Frame reducer -----------------------------------------------------------------------------------

function pushNotice(conversation: Conversation, notice: Omit<Notice, 'id'>): Conversation {
  const last = conversation.notices.at(-1);
  if (last !== undefined && last.text === notice.text && last.level === notice.level)
    return conversation;
  const next = [...conversation.notices, { ...notice, id: conversation.nextNoticeId }];
  return {
    ...conversation,
    notices: next.slice(-MAX_NOTICES),
    nextNoticeId: conversation.nextNoticeId + 1,
  };
}

export function reduceFrame(conversation: Conversation, frame: OmpFrame): Conversation {
  switch (frame.type) {
    case 'agent_start':
      return { ...conversation, working: true, retry: null };
    case 'session_settled':
      // A non-terminal agent_end whose follow-up run was cancelled is only closed by this frame.
      return {
        ...conversation,
        working: false,
        stream: null,
        streamId: null,
        activeTools: new Map(),
        retry: null,
      };
    case 'agent_end': {
      if (frame.isTerminal === false) return conversation;
      return {
        ...conversation,
        working: false,
        stream: null,
        streamId: null,
        activeTools: new Map(),
        retry: null,
      };
    }
    case 'message_start': {
      if (
        frame.message.role !== 'assistant' ||
        !isWireMessage(frame.message) ||
        frame.message.role !== 'assistant'
      ) {
        return conversation;
      }
      return { ...conversation, stream: frame.message, streamId: frame.messageId ?? null };
    }
    case 'message_update': {
      const sameMessage = conversation.streamId === (frame.messageId ?? null);
      const base =
        sameMessage && conversation.stream !== null ? conversation.stream : emptyAssistant();
      return {
        ...conversation,
        stream: applyStreamEvent(base, frame.assistantMessageEvent),
        streamId: frame.messageId ?? conversation.streamId,
      };
    }
    case 'message_end': {
      const appended = appendMessage(conversation, frame.message);
      if (frame.message.role !== 'assistant') return appended;
      return { ...appended, stream: null, streamId: null };
    }
    case 'tool_execution_start': {
      const activeTools = new Map(conversation.activeTools);
      activeTools.set(frame.toolCallId, {
        toolCallId: frame.toolCallId,
        toolName: frame.toolName,
        args: frame.args,
        ...(frame.intent !== undefined ? { intent: frame.intent } : {}),
        startedAt: Date.now(),
      });
      return { ...conversation, activeTools };
    }
    case 'tool_execution_update': {
      const current = conversation.activeTools.get(frame.toolCallId);
      if (current === undefined) return conversation;
      const activeTools = new Map(conversation.activeTools);
      activeTools.set(frame.toolCallId, {
        ...current,
        ...(frame.args !== undefined ? { args: frame.args } : {}),
        ...(frame.partialResult !== undefined ? { partialResult: frame.partialResult } : {}),
      });
      return { ...conversation, activeTools };
    }
    case 'tool_execution_end': {
      if (!conversation.activeTools.has(frame.toolCallId)) return conversation;
      const activeTools = new Map(conversation.activeTools);
      activeTools.delete(frame.toolCallId);
      return { ...conversation, activeTools };
    }
    case 'queue_update':
      return { ...conversation, queue: { steering: frame.steering, followUp: frame.followUp } };
    case 'auto_retry_start':
      return {
        ...conversation,
        retry: {
          attempt: frame.attempt,
          maxAttempts: frame.maxAttempts,
          delayMs: frame.delayMs,
          until: Date.now() + frame.delayMs,
          errorMessage: frame.errorMessage,
        },
      };
    case 'auto_retry_end':
      return { ...conversation, retry: null };
    case 'auto_compaction_start':
      return { ...conversation, compacting: true };
    case 'auto_compaction_end':
      return { ...conversation, compacting: false };
    case 'notice': {
      if (frame.level === 'info' && frame.message.startsWith('xd://')) return conversation;
      return pushNotice(conversation, {
        level: frame.level,
        text: frame.message,
        ...(frame.source !== undefined ? { source: frame.source } : {}),
      });
    }
    case 'extension_error':
      return pushNotice(conversation, {
        level: 'error',
        text: frame.error,
        source: frame.extensionPath ?? 'extension',
      });
    case 'prompt_result':
      return frame.status === 'error' && frame.error !== undefined
        ? pushNotice(conversation, { level: 'error', text: frame.error, source: 'prompt' })
        : conversation;
    case 'command_output':
      // Output of a builtin slash command (e.g. /help): shown inline like a custom message.
      return appendMessage(conversation, {
        role: 'custom',
        customType: 'command',
        content: frame.text,
        display: true,
      });
    case 'rpc_frame_error':
      return { ...conversation, needsResync: true };
    default:
      return conversation;
  }
}

// ---- Snapshot ----------------------------------------------------------------------------------------

export function applySnapshot(snapshot: OmpSnapshot): Conversation {
  let conversation: Conversation = {
    ...emptyConversation(),
    queue: snapshot.state?.queuedMessages ?? EMPTY_QUEUE,
    working: snapshot.state?.isStreaming ?? false,
  };
  for (const message of snapshot.messages) conversation = appendMessage(conversation, message);
  for (const frame of snapshot.inflight) conversation = reduceFrame(conversation, frame);
  return conversation;
}

/** Replace the committed transcript with a fresh `get_messages` result, keeping live-only state. */
export function replaceMessages(
  conversation: Conversation,
  messages: readonly OmpMessage[],
): Conversation {
  let next: Conversation = { ...conversation, entries: [], nextEntryId: 1, needsResync: false };
  for (const message of messages) next = appendMessage(next, message);
  return next;
}
