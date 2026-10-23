import { describe, expect, test } from 'bun:test';
import {
  InflightTracker,
  type AssistantMessage,
  type OmpFrame,
  type OmpMessage,
  type OmpSnapshot,
  type ToolResultMessage,
  type UserMessage,
} from '@hsw-editor/omp-protocol';
import {
  applySnapshot,
  emptyConversation,
  reduceFrame,
  type Conversation,
} from './conversation.ts';

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { total: 0 },
};
const assistant = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
): AssistantMessage => ({
  role: 'assistant',
  content,
  model: 'm',
  usage,
  stopReason,
  timestamp: 10,
});
const user: UserMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'add a holder' }],
  timestamp: 1,
};
const toolCall = {
  type: 'toolCall',
  id: 'call-1',
  name: 'wall_apply',
  arguments: { ops: [] },
} as const;
const toolResult: ToolResultMessage = {
  role: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'wall_apply',
  content: [{ type: 'text', text: '{"ok":true}' }],
  isError: false,
  timestamp: 12,
};

const update = (
  messageId: string,
  assistantMessageEvent: Extract<OmpFrame, { type: 'message_update' }>['assistantMessageEvent'],
): OmpFrame => ({
  type: 'message_update',
  messageId,
  assistantMessageEvent,
});

/** One realistic turn: thinking -> tool call -> tool result -> final text. */
const TURN: readonly OmpFrame[] = [
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: user, messageId: 'm1' },
  { type: 'message_end', message: user, messageId: 'm1' },
  // message_start of the assistant already contains the first thinking delta, as real omp does.
  {
    type: 'message_start',
    message: assistant([{ type: 'thinking', thinking: 'I should' }]),
    messageId: 'm2',
  },
  update('m2', { type: 'thinking_start', contentIndex: 0 }),
  update('m2', { type: 'thinking_delta', contentIndex: 0, delta: 'I should' }),
  update('m2', { type: 'thinking_delta', contentIndex: 0, delta: ' call it' }),
  update('m2', { type: 'thinking_end', contentIndex: 0, content: 'I should call it' }),
  update('m2', { type: 'toolcall_start', contentIndex: 1 }),
  update('m2', { type: 'toolcall_delta', contentIndex: 1, delta: '{"ops":' }),
  update('m2', { type: 'toolcall_end', contentIndex: 1, toolCall: toolCall }),
  {
    type: 'message_end',
    message: assistant([{ type: 'thinking', thinking: 'I should call it' }, toolCall], 'toolUse'),
    messageId: 'm2',
  },
  {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'wall_apply',
    args: { ops: [] },
    intent: 'adding',
  },
  {
    type: 'tool_execution_update',
    toolCallId: 'call-1',
    toolName: 'wall_apply',
    partialResult: 'working',
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'wall_apply',
    result: { content: [] },
  },
  { type: 'message_start', message: toolResult, messageId: 'm3' },
  { type: 'message_end', message: toolResult, messageId: 'm3' },
  { type: 'message_start', message: assistant([{ type: 'text', text: 'D' }]), messageId: 'm4' },
  update('m4', { type: 'text_start', contentIndex: 0 }),
  update('m4', { type: 'text_delta', contentIndex: 0, delta: 'Do' }),
  update('m4', { type: 'text_delta', contentIndex: 0, delta: 'ne.' }),
  update('m4', { type: 'text_end', contentIndex: 0, content: 'Done.' }),
  { type: 'message_end', message: assistant([{ type: 'text', text: 'Done.' }]), messageId: 'm4' },
  { type: 'turn_end' },
  { type: 'agent_end', isTerminal: true },
];

function run(frames: readonly OmpFrame[], from: Conversation = emptyConversation()): Conversation {
  return frames.reduce(reduceFrame, from);
}

function messagesOf(conversation: Conversation): OmpMessage[] {
  return conversation.entries.flatMap((entry) => (entry.type === 'message' ? [entry.message] : []));
}

describe('reduceFrame', () => {
  test('assembles streamed deltas without duplicating the first delta carried by message_start', () => {
    const midThinking = run(TURN.slice(0, 8));
    expect(midThinking.working).toBe(true);
    expect(midThinking.stream?.content).toEqual([
      { type: 'thinking', thinking: 'I should call it' },
    ]);
    const midText = run(TURN.slice(0, 21));
    expect(midText.stream?.content).toEqual([{ type: 'text', text: 'Do' }]);
  });

  test('a finished turn commits the final messages, pairs the tool result and clears live state', () => {
    const done = run(TURN);
    expect(done.working).toBe(false);
    expect(done.stream).toBeNull();
    expect(done.activeTools.size).toBe(0);
    expect(messagesOf(done).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    const finalText = messagesOf(done).at(-1);
    expect(finalText?.role === 'assistant' && finalText.content).toEqual([
      { type: 'text', text: 'Done.' },
    ]);
  });

  test('a tool call placeholder is replaced by the real call once its arguments are complete', () => {
    const streaming = run(TURN.slice(0, 10));
    const placeholder = streaming.stream?.content[1];
    expect(placeholder?.type === 'toolCall' && placeholder.name).toBe('…');
    const complete = run(TURN.slice(0, 12));
    expect(complete.stream?.content[1]).toEqual(toolCall);
  });

  test('running tools are tracked with their intent and partial output until they end', () => {
    const running = run(TURN.slice(0, 15));
    expect(running.activeTools.get('call-1')).toMatchObject({
      toolName: 'wall_apply',
      intent: 'adding',
      partialResult: 'working',
    });
    expect(run(TURN.slice(0, 16)).activeTools.size).toBe(0);
  });

  test('a non-terminal agent_end keeps working; a terminal one drops dangling live state', () => {
    const retrying = run([
      { type: 'agent_start' },
      { type: 'message_start', message: assistant([]), messageId: 'x' },
      { type: 'agent_end', isTerminal: false },
    ]);
    expect(retrying.working).toBe(true);
    expect(retrying.stream).not.toBeNull();
    const aborted = reduceFrame(retrying, { type: 'agent_end', isTerminal: true });
    expect(aborted.working).toBe(false);
    expect(aborted.stream).toBeNull();
  });

  test('an oversized-frame notification asks for a resync', () => {
    expect(reduceFrame(emptyConversation(), { type: 'rpc_frame_error' }).needsResync).toBe(true);
  });

  test('housekeeping notices are not shown but real warnings are, once', () => {
    let conversation = reduceFrame(emptyConversation(), {
      type: 'notice',
      level: 'info',
      message: 'xd://: mounted a, b, c',
    });
    expect(conversation.notices).toHaveLength(0);
    conversation = reduceFrame(conversation, {
      type: 'notice',
      level: 'warning',
      message: 'low disk',
    });
    conversation = reduceFrame(conversation, {
      type: 'notice',
      level: 'warning',
      message: 'low disk',
    });
    expect(conversation.notices.map((notice) => notice.text)).toEqual(['low disk']);
  });
});

describe('applySnapshot equals having watched the whole stream', () => {
  const reference = run(TURN);

  test('for every point at which a page may attach', () => {
    for (let cut = 0; cut <= TURN.length; cut += 1) {
      const before = run(TURN.slice(0, cut));
      const tracker = new InflightTracker();
      for (const frame of TURN.slice(0, cut)) tracker.observe(frame);
      const snapshot: OmpSnapshot = {
        messages: messagesOf(before),
        state: null,
        inflight: tracker.replay(),
        pendingDialogs: [],
        pendingPrompts: [],
      };
      const resumed = run(TURN.slice(cut), applySnapshot(snapshot));
      expect({ cut, messages: messagesOf(resumed) }).toEqual({
        cut,
        messages: messagesOf(reference),
      });
      expect({
        cut,
        working: resumed.working,
        stream: resumed.stream,
        tools: resumed.activeTools.size,
      }).toEqual({
        cut,
        working: reference.working,
        stream: reference.stream,
        tools: reference.activeTools.size,
      });
    }
  });
});
