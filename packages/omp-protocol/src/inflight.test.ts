import { describe, expect, test } from 'bun:test';
import { InflightTracker } from './inflight.ts';
import type { AssistantMessage, OmpFrame } from './rpc.ts';

const assistant: AssistantMessage = {
  role: 'assistant',
  content: [],
  model: 'm',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
  stopReason: 'stop',
  timestamp: 1,
};
const start = (messageId: string): OmpFrame => ({
  type: 'message_start',
  message: assistant,
  messageId,
});
const delta = (messageId: string, text: string): OmpFrame => ({
  type: 'message_update',
  messageId,
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
});
const end = (messageId: string): OmpFrame => ({
  type: 'message_end',
  message: assistant,
  messageId,
});

function label(frame: OmpFrame): string {
  if (frame.type === 'tool_execution_start' || frame.type === 'tool_execution_update') {
    return `${frame.type}:${frame.toolCallId}`;
  }
  if (frame.type === 'message_start' || frame.type === 'message_update') {
    return `${frame.type}:${frame.messageId ?? ''}`;
  }
  return frame.type;
}

describe('InflightTracker', () => {
  test('replays the streaming message and running tools, but not finished ones', () => {
    const tracker = new InflightTracker();
    tracker.observe({ type: 'agent_start' });
    tracker.observe(start('m1'));
    tracker.observe(delta('m1', 'a'));
    tracker.observe(end('m1'));
    tracker.observe({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} });
    tracker.observe({
      type: 'tool_execution_start',
      toolCallId: 't2',
      toolName: 'wall_get',
      args: {},
    });
    tracker.observe({
      type: 'tool_execution_update',
      toolCallId: 't1',
      toolName: 'bash',
      partialResult: 'x',
    });
    tracker.observe({
      type: 'tool_execution_end',
      toolCallId: 't2',
      toolName: 'wall_get',
      result: { content: [] },
    });
    tracker.observe(start('m2'));
    tracker.observe(delta('m2', 'b'));
    tracker.observe(delta('m2', 'c'));

    expect(tracker.replay().map(label)).toEqual([
      'agent_start',
      'message_start:m2',
      'message_update:m2',
      'message_update:m2',
      'tool_execution_start:t1',
      'tool_execution_update:t1',
    ]);
  });

  test('a terminal agent_end clears everything but a non-terminal one keeps the turn alive', () => {
    const tracker = new InflightTracker();
    tracker.observe({ type: 'agent_start' });
    tracker.observe(start('m1'));
    tracker.observe({ type: 'agent_end', isTerminal: false });
    expect(tracker.agentRunning).toBe(true);
    expect(tracker.replay()).toHaveLength(2);
    tracker.observe({ type: 'agent_end', isTerminal: true });
    expect(tracker.agentRunning).toBe(false);
    expect(tracker.replay()).toEqual([]);
  });

  test('a message_end of another message does not drop the streaming one', () => {
    const tracker = new InflightTracker();
    tracker.observe(start('m1'));
    tracker.observe(end('m0'));
    expect(tracker.replay()).toHaveLength(1);
  });
});
