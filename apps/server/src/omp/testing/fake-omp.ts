/**
 * Scripted stand-in for `omp --mode rpc-ui`, driven by the prompt text. It speaks the real framing
 * (ready frame, protocol v2 negotiation, rpc_chunk for oversized responses), keeps its transcript in
 * `<session-dir>/fake-session.json` so `--continue` resumes it, and implements just enough commands for
 * the bridge tests. Scenarios (the whole prompt text):
 *
 *   "say hi"                    one assistant text answer
 *   "wall:<json ops array>"     assistant calls the host tool wall_apply with those ops, then reports the result
 *   "tool:<name>:<json args>"   assistant calls the named host tool and reports the result
 *   "toolcrash:<json args>"     calls app_command, then exits with code 3 while the call is pending
 *   "ask"                       raises a select dialog (Approve/Deny) and waits for the answer
 *   "gate:<tool>"               raises omp's own "Allow tool: <tool>" approval select and reports the answer
 *   "crash"                     exits with code 3 in the middle of the turn
 *   "slow"                      streams text deltas for ~600 ms (lets tests attach mid-turn)
 *   "big"                       get_messages afterwards returns a >1 MiB response (chunked under v2)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Json {
  [key: string]: unknown;
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  // The host probes `omp --version`; answer and exit before touching any session state.
  console.log('18.8.1');
  process.exit(0);
}
const sessionDirIndex = args.indexOf('--session-dir');
const sessionDir = sessionDirIndex >= 0 ? (args[sessionDirIndex + 1] ?? '.') : '.';
const stateFile = join(sessionDir, 'fake-session.json');
const resume = args.includes('--continue');

let messages: Json[] =
  resume && existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as Json[]) : [];
let chunked = false;
let streaming = false;
let big = false;
let messageSeq = 0;
const hostTools: string[] = [];
/** Id of the host tool call omp is waiting on (an `abort` cancels it). */
let activeHostCall: string | null = null;
const waiting = new Map<string, (frame: Json) => void>();

function write(frame: Json): void {
  const line = JSON.stringify(frame);
  if (chunked && Buffer.byteLength(line) > 512 * 1024) {
    const bytes = Buffer.from(line, 'utf8');
    const size = 256 * 1024;
    const count = Math.ceil(bytes.length / size);
    for (let index = 0; index < count; index += 1) {
      const slice = bytes.subarray(index * size, (index + 1) * size);
      process.stdout.write(
        `${JSON.stringify({ type: 'rpc_chunk', chunkId: `c${messageSeq}`, index, count, byteLength: bytes.length, data: slice.toString('base64') })}\n`,
      );
    }
    messageSeq += 1;
    return;
  }
  process.stdout.write(`${line}\n`);
}

function save(): void {
  writeFileSync(stateFile, JSON.stringify(messages));
}

const model = {
  id: 'fake-1',
  name: 'Fake model',
  provider: 'fake',
  reasoning: false,
  contextWindow: 100_000,
};

function state(): Json {
  return {
    model,
    thinkingLevel: 'off',
    isStreaming: streaming,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    interruptMode: 'immediate',
    sessionFile: stateFile,
    sessionId: 'fake-session',
    autoCompactionEnabled: true,
    messageCount: messages.length,
    queuedMessageCount: 0,
    todoPhases: [],
    systemPrompt: ['SECRET-LOOKING SYSTEM PROMPT'],
    dumpTools: [{ name: 'read', description: 'x', parameters: {} }],
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function userMessage(text: string): Json {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    attribution: 'user',
    timestamp: Date.now(),
  };
}

function assistantMessage(content: Json[], stopReason = 'stop'): Json {
  return {
    role: 'assistant',
    content,
    api: 'fake',
    provider: 'fake',
    model: 'fake-1',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { total: 0.0001 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function nextMessageId(): string {
  messageSeq += 1;
  return `msg-${messageSeq}`;
}

function waitFor(id: string): Promise<Json> {
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function streamText(text: string, delayMs: number): Promise<Json> {
  const messageId = nextMessageId();
  const start = assistantMessage([{ type: 'text', text: '' }]);
  write({ type: 'message_start', message: start, messageId });
  write({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    message: { role: 'assistant' },
    messageId,
  });
  for (const piece of text.match(/.{1,6}/gs) ?? []) {
    write({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: piece },
      message: { role: 'assistant' },
      messageId,
    });
    if (delayMs > 0) await sleep(delayMs);
  }
  write({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: text },
    message: { role: 'assistant' },
    messageId,
  });
  const final = assistantMessage([{ type: 'text', text }]);
  write({ type: 'message_end', message: final, messageId });
  return final;
}

async function callTool(name: string, toolArgs: Json): Promise<string> {
  const toolCallId = `toolu_${messageSeq}_${name}`;
  const messageId = nextMessageId();
  const call = {
    type: 'toolCall',
    id: toolCallId,
    name,
    arguments: { i: `calling ${name}`, ...toolArgs },
  };
  const message = assistantMessage([call], 'toolUse');
  write({ type: 'message_start', message: assistantMessage([]), messageId });
  write({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
    message: { role: 'assistant' },
    messageId,
  });
  write({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: call },
    message: { role: 'assistant' },
    messageId,
  });
  write({ type: 'message_end', message, messageId });
  messages.push(message);
  write({
    type: 'tool_execution_start',
    toolCallId,
    toolName: name,
    args: toolArgs,
    intent: `calling ${name}`,
  });
  const hostId = `host-${toolCallId}`;
  const pending = waitFor(hostId);
  write({ type: 'host_tool_call', id: hostId, toolCallId, toolName: name, arguments: toolArgs });
  activeHostCall = hostId;
  const reply = await pending;
  activeHostCall = null;
  const result = reply['result'] as Json;
  const isError = reply['isError'] === true;
  write({ type: 'tool_execution_end', toolCallId, toolName: name, result, isError });
  const toolResult = {
    role: 'toolResult',
    toolCallId,
    toolName: name,
    content: result['content'],
    isError,
    timestamp: Date.now(),
  };
  messages.push(toolResult);
  write({ type: 'message_start', message: toolResult, messageId: nextMessageId() });
  write({ type: 'message_end', message: toolResult, messageId: `msg-${messageSeq}` });
  const content = result['content'] as Json[];
  return String(content.find((block) => block['type'] === 'text')?.['text'] ?? '');
}

/** The page wraps palette questions in this tag pair (apps/web/src/features/omp/paletteMode.ts). */
const PALETTE_PREFIX = /^<hsw-palette-mode>[\s\S]*?<\/hsw-palette-mode>\n/;

async function runPrompt(rawText: string): Promise<void> {
  streaming = true;
  write({ type: 'agent_start' });
  write({ type: 'turn_start' });
  const paletteMode = PALETTE_PREFIX.test(rawText);
  const text = rawText.replace(PALETTE_PREFIX, '');
  const user = userMessage(rawText);
  messages.push(user);
  write({ type: 'message_start', message: user, messageId: nextMessageId() });
  write({ type: 'message_end', message: user, messageId: `msg-${messageSeq}` });
  let answer = 'hi';
  if (text === 'crash') {
    await streamText('about to crash', 5);
    process.exit(3);
  } else if (text === 'slow') {
    answer = 'a deliberately slow answer that takes a while';
    messages.push(await streamText(answer, 60));
  } else if (text === 'ask') {
    const id = `ui-${messageSeq}`;
    const pending = waitFor(id);
    write({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: 'Run the risky thing?',
      options: ['Approve', 'Deny'],
    });
    const reply = await pending;
    messages.push(
      await streamText(`dialog answered: ${String(reply['value'] ?? reply['cancelled'])}`, 0),
    );
  } else if (text.startsWith('gate:')) {
    const id = `ui-${messageSeq}`;
    const pending = waitFor(id);
    write({
      type: 'extension_ui_request',
      id,
      method: 'select',
      title: `Allow tool: ${text.slice(5)}`,
      options: ['Approve', 'Deny'],
    });
    const reply = await pending;
    messages.push(
      await streamText(`gate answered: ${String(reply['value'] ?? reply['cancelled'])}`, 0),
    );
  } else if (text === 'big') {
    big = true;
    messages.push(await streamText('big transcript prepared', 0));
  } else if (text.startsWith('toolcrash:')) {
    setTimeout(() => process.exit(3), 150);
    await callTool('app_command', JSON.parse(text.slice(10)) as Json);
  } else if (text.startsWith('wall:') || text.startsWith('tool:')) {
    const wallCall = text.startsWith('wall:');
    const name = wallCall ? 'wall_apply' : (text.split(':')[1] ?? '');
    const payload = wallCall ? text.slice(5) : text.slice(text.indexOf(':', 5) + 1);
    const toolArgs: Json = wallCall
      ? { ops: JSON.parse(payload) as unknown }
      : (JSON.parse(payload) as Json);
    const outcome = await callTool(name, toolArgs);
    messages.push(await streamText(`tool said: ${outcome.slice(0, 200)}`, 0));
  } else if (paletteMode) {
    // A canned, slowly streamed answer: lets a browser run watch the text arrive in the palette.
    answer = `Fake omp here. You asked: ${text}. I can run editor commands through app_command.`;
    messages.push(await streamText(answer, 40));
  } else {
    messages.push(await streamText(answer, 0));
  }
  write({ type: 'turn_end' });
  streaming = false;
  write({ type: 'agent_end', messages: [], isTerminal: true, yielded: true });
  save();
}

function respond(id: string | undefined, command: string, data?: unknown): void {
  write({
    ...(id !== undefined ? { id } : {}),
    type: 'response',
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
}

function handle(frame: Json): void {
  const type = String(frame['type']);
  const id = typeof frame['id'] === 'string' ? frame['id'] : undefined;
  if (type === 'extension_ui_response' || type === 'host_tool_result') {
    const key = String(frame['id']);
    waiting.get(key)?.(frame);
    waiting.delete(key);
    return;
  }
  switch (type) {
    case 'negotiate_protocol':
      respond(id, type, { protocolVersion: 2 });
      chunked = true;
      return;
    case 'set_ask_dialog':
      respond(id, type, { enabled: true });
      return;
    case 'set_event_filter':
      respond(id, type, { events: null, messageUpdates: frame['messageUpdates'] });
      return;
    case 'set_host_tools': {
      const tools = frame['tools'] as Json[];
      hostTools.splice(0, hostTools.length, ...tools.map((tool) => String(tool['name'])));
      respond(id, type, { toolNames: hostTools });
      return;
    }
    case 'get_state':
      respond(id, type, state());
      return;
    case 'get_messages': {
      const extra = big
        ? [
            {
              role: 'custom',
              customType: 'blob',
              content: 'x'.repeat(1_400_000),
              display: true,
              timestamp: 1,
            },
          ]
        : [];
      respond(id, type, { messages: [...messages, ...extra] });
      return;
    }
    case 'prompt':
      respond(id, type);
      void runPrompt(String(frame['message']));
      return;
    case 'abort': {
      respond(id, type);
      // Like omp: a running host tool is cancelled and its call ends with an error result.
      const running = activeHostCall;
      if (running !== null) {
        write({ type: 'host_tool_cancel', id: `cancel-${running}`, targetId: running });
        waiting.get(running)?.({
          type: 'host_tool_result',
          id: running,
          isError: true,
          result: { content: [{ type: 'text', text: 'Cancelled' }] },
        });
        waiting.delete(running);
      }
      return;
    }
    case 'new_session':
      messages = [];
      save();
      respond(id, type, { cancelled: false });
      return;
    default:
      write({
        ...(id !== undefined ? { id } : {}),
        type: 'response',
        command: type,
        success: false,
        error: `fake omp: unsupported ${type}`,
      });
  }
}

write({
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
});

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Json);
    newline = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  save();
  process.exit(0);
});
