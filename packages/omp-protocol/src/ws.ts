/**
 * Envelope protocol on `/api/omp/ws?wall=<id>` between the page and the hsw-editor server.
 *
 * The server owns the omp child. It relays omp frames verbatim inside `frame` envelopes, adds
 * supervision state (`status`), resync (`snapshot`), server-originated approvals for destructive
 * agent edits, and request/response calls into the page (`ui_call` -> `ui_result`) so the agent can
 * look at the 3D viewport.
 */
import type { AppCommandResult, AppCommandToolArgs } from '@hsw-editor/commands';
import {
  BLOCKED_RPC_COMMANDS,
  THINKING_LEVELS,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type OmpDialogRequest,
  type OmpFrame,
  type OmpMessage,
  type OmpRpcCommand,
  type OmpState,
  type OmpUiResponse,
  type OmpUnknownFrame,
} from './rpc.ts';

export const OMP_PROTOCOL_VERSION = 1 as const;

// ---- Supervision status -------------------------------------------------------------------------

export type OmpPhase = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';

export interface OmpSessionStatus {
  readonly phase: OmpPhase;
  readonly wallId: string;
  readonly ompVersion?: string;
  readonly pid?: number;
  readonly cwd: string;
  readonly sessionDir: string;
  /** Crashes since the child last stayed up for the stability window. */
  readonly restartAttempt: number;
  /** Epoch ms (daemon and page share a machine) at which the next start attempt happens. */
  readonly restartAt?: number;
  /** Last crash / spawn error, human readable (never contains credentials). */
  readonly error?: string;
  /** Tail of the child's stderr for diagnostics. */
  readonly stderrTail?: readonly string[];
}

/** Settings the page may see (no filesystem secrets). */
export interface OmpPublicConfig {
  readonly model?: string;
  readonly thinking?: string;
  readonly approvalMode: 'always-ask' | 'write' | 'yolo';
  readonly destructiveOps: DestructiveOpsPolicy;
  readonly destructiveThreshold: number;
}

export type DestructiveOpsPolicy = 'ask' | 'allow' | 'deny';

/** One stored omp session of a wall, as listed by `GET /api/omp/sessions?wall=<id>`. */
export interface OmpSessionFile {
  readonly path: string;
  readonly id: string;
  readonly title: string | null;
  /** First user message, shortened, as a fallback label. */
  readonly preview: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string;
  readonly sizeBytes: number;
}

// ---- Server -> page -----------------------------------------------------------------------------

/** Prompt the *server* shows to the user (not an omp dialog): a destructive wall edit proposed by the agent. */
export interface HswPromptRequest {
  readonly id: string;
  readonly wallId: string;
  readonly toolName: string;
  readonly kind: 'destructive_ops';
  readonly title: string;
  readonly summary: string;
  readonly removeCount: number;
  readonly opCount: number;
}

export type HswPromptAnswer = { readonly approved: boolean } | { readonly cancelled: true };

export type ViewportCall =
  | {
      readonly method: 'capture';
      readonly params: { readonly view: 'current' | 'front' | 'iso'; readonly maxSidePx: number };
    }
  | { readonly method: 'select'; readonly params: { readonly ids: readonly string[] } }
  | { readonly method: 'get_selection' }
  /**
   * The `app_command` host tool: the page runs a command-registry request (list, search, run). A run of a
   * changing command may wait for the user's approval, so this call has a far longer timeout than the others.
   */
  | { readonly method: 'app_command'; readonly params: AppCommandToolArgs };

export interface ViewportCapture {
  readonly mimeType: 'image/png' | 'image/jpeg';
  readonly dataBase64: string;
  readonly width: number;
  readonly height: number;
}

export type ViewportResult =
  | ViewportCapture
  | { readonly selected: readonly string[] }
  | AppCommandResult;

export interface OmpSnapshot {
  readonly messages: readonly OmpMessage[];
  readonly state: OmpState | null;
  /** Frames of the message / tool executions still running; replay them through the reducer. */
  readonly inflight: readonly OmpFrame[];
  readonly pendingDialogs: readonly OmpDialogRequest[];
  readonly pendingPrompts: readonly HswPromptRequest[];
}

export type OmpServerMessage =
  | {
      readonly t: 'hello';
      readonly protocol: typeof OMP_PROTOCOL_VERSION;
      readonly config: OmpPublicConfig;
    }
  | { readonly t: 'status'; readonly status: OmpSessionStatus }
  | { readonly t: 'snapshot'; readonly snapshot: OmpSnapshot }
  | { readonly t: 'frame'; readonly frame: OmpFrame | OmpUnknownFrame }
  | { readonly t: 'prompt'; readonly request: HswPromptRequest }
  | { readonly t: 'prompt_done'; readonly id: string }
  | { readonly t: 'ui_call'; readonly id: string; readonly call: ViewportCall }
  /** The server gave up on (or the agent cancelled) the `ui_call` with this id: stop working on it. */
  | { readonly t: 'ui_cancel'; readonly id: string }
  | { readonly t: 'error'; readonly message: string };

// ---- Page -> server -----------------------------------------------------------------------------

export type OmpClientMessage =
  | { readonly t: 'rpc'; readonly command: OmpRpcCommand }
  | { readonly t: 'ui_response'; readonly response: OmpUiResponse }
  | { readonly t: 'prompt_response'; readonly id: string; readonly answer: HswPromptAnswer }
  | {
      readonly t: 'ui_result';
      readonly id: string;
      readonly ok: true;
      readonly result: ViewportResult;
    }
  | { readonly t: 'ui_result'; readonly id: string; readonly ok: false; readonly error: string }
  | { readonly t: 'restart' }
  | { readonly t: 'ping' };

export const MAX_CLIENT_MESSAGE_BYTES = 24 * 1024 * 1024;
export const MAX_PROMPT_IMAGES = 8;

export type ClientParseResult =
  | { readonly ok: true; readonly message: OmpClientMessage }
  | { readonly ok: false; readonly error: string };

/** Commands that carry no payload besides `id`. */
const BARE_COMMANDS: readonly string[] = [
  'abort',
  'abort_and_restore_queue',
  'new_session',
  'get_state',
  'get_messages',
  'get_tree',
  'get_available_commands',
  'get_available_models',
  'cycle_model',
  'get_available_thinking_levels',
  'cycle_thinking_level',
  'abort_retry',
  'get_session_stats',
  'get_last_assistant_text',
  'get_btw_history',
  'get_subagents',
];

const TEXT_COMMANDS: readonly string[] = ['prompt', 'steer', 'follow_up', 'abort_and_prompt'];
const ENABLED_COMMANDS: readonly string[] = [
  'set_auto_compaction',
  'set_auto_retry',
  'set_fast_mode',
];

function str(object: JsonObject, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

function optionalStr(object: JsonObject, key: string): string | undefined | null {
  const value = object[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function validImages(value: JsonValue | undefined): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > MAX_PROMPT_IMAGES) return false;
  return value.every(
    (image) =>
      isJsonObject(image) &&
      image['type'] === 'image' &&
      typeof image['data'] === 'string' &&
      typeof image['mimeType'] === 'string' &&
      /^image\/(png|jpeg|webp|gif)$/.test(image['mimeType']),
  );
}

function fail(error: string): ClientParseResult {
  return { ok: false, error };
}

function parseRpc(command: JsonValue | undefined): ClientParseResult {
  if (!isJsonObject(command)) return fail('rpc.command must be an object');
  const type = str(command, 'type');
  const id = str(command, 'id');
  if (type === null || id === null || id.length === 0 || id.length > 128) {
    return fail('rpc.command needs string type and id');
  }
  if (BLOCKED_RPC_COMMANDS.includes(type))
    return fail(`command ${type} is not available from the page`);
  const ok = (): ClientParseResult => ({
    ok: true,
    // JSON boundary: `type` is in the allow-list and the payload fields are checked per command below.
    message: { t: 'rpc', command: command as unknown as OmpRpcCommand },
  });
  if (BARE_COMMANDS.includes(type)) return ok();
  if (TEXT_COMMANDS.includes(type)) {
    if (str(command, 'message') === null) return fail(`${type} needs message`);
    if (!validImages(command['images']))
      return fail('images must be at most 8 base64 image blocks');
    if (type === 'prompt') {
      const behavior = command['streamingBehavior'];
      if (behavior !== undefined && behavior !== 'steer' && behavior !== 'followUp') {
        return fail('bad streamingBehavior');
      }
    }
    return ok();
  }
  if (ENABLED_COMMANDS.includes(type)) {
    return typeof command['enabled'] === 'boolean' ? ok() : fail(`${type} needs boolean enabled`);
  }
  switch (type) {
    case 'remove_queued_message': {
      const queue = command['queue'];
      return str(command, 'message') !== null && (queue === 'steering' || queue === 'followUp')
        ? ok()
        : fail('remove_queued_message needs message and queue');
    }
    case 'promote_queued_message':
      return str(command, 'message') !== null ? ok() : fail('promote_queued_message needs message');
    case 'switch_session':
      return str(command, 'sessionPath') !== null ? ok() : fail('switch_session needs sessionPath');
    case 'fork':
      return optionalStr(command, 'entryId') !== null
        ? ok()
        : fail('fork entryId must be a string');
    case 'branch':
      return str(command, 'entryId') !== null ? ok() : fail('branch needs entryId');
    case 'get_entries':
      return optionalStr(command, 'since') !== null
        ? ok()
        : fail('get_entries since must be a string');
    case 'set_model':
      return str(command, 'provider') !== null && str(command, 'modelId') !== null
        ? ok()
        : fail('set_model needs provider and modelId');
    case 'set_thinking_level': {
      const level = str(command, 'level');
      return level !== null && (THINKING_LEVELS as readonly string[]).includes(level)
        ? ok()
        : fail('bad thinking level');
    }
    case 'set_steering_mode':
    case 'set_follow_up_mode': {
      const mode = command['mode'];
      return mode === 'all' || mode === 'one-at-a-time' ? ok() : fail(`${type} needs mode`);
    }
    case 'set_interrupt_mode': {
      const mode = command['mode'];
      return mode === 'immediate' || mode === 'wait' ? ok() : fail('set_interrupt_mode needs mode');
    }
    case 'compact':
    case 'handoff':
      return optionalStr(command, 'customInstructions') !== null
        ? ok()
        : fail(`${type} instructions must be a string`);
    case 'set_session_name':
      return str(command, 'name') !== null ? ok() : fail('set_session_name needs name');
    case 'btw':
      return str(command, 'question') !== null && optionalStr(command, 'recordId') !== null
        ? ok()
        : fail('btw needs question');
    case 'btw_cancel':
      return optionalStr(command, 'recordId') !== null
        ? ok()
        : fail('btw_cancel recordId must be a string');
    case 'cancel_subagent':
      return str(command, 'subagentId') !== null ? ok() : fail('cancel_subagent needs subagentId');
    case 'steer_subagent':
      return str(command, 'subagentId') !== null && str(command, 'message') !== null
        ? ok()
        : fail('steer_subagent needs subagentId and message');
    default:
      return fail(`unknown command ${type}`);
  }
}

function parseUiResponse(response: JsonValue | undefined): ClientParseResult {
  if (!isJsonObject(response) || response['type'] !== 'extension_ui_response') {
    return fail('ui_response.response must be an extension_ui_response');
  }
  const id = str(response, 'id');
  if (id === null) return fail('ui_response needs id');
  const shapes =
    Number(typeof response['value'] === 'string') +
    Number(typeof response['confirmed'] === 'boolean') +
    Number(response['cancelled'] === true) +
    Number(Array.isArray(response['answers']));
  if (shapes !== 1)
    return fail('ui_response needs exactly one of value/confirmed/cancelled/answers');
  const answers = response['answers'];
  if (
    Array.isArray(answers) &&
    !answers.every(
      (answer) =>
        isJsonObject(answer) &&
        typeof answer['id'] === 'string' &&
        Array.isArray(answer['selectedOptions']) &&
        answer['selectedOptions'].every((option) => typeof option === 'string'),
    )
  ) {
    return fail('malformed answers');
  }
  // JSON boundary: one of the four response shapes was verified above.
  return {
    ok: true,
    message: { t: 'ui_response', response: response as unknown as OmpUiResponse },
  };
}

/** Validate one text frame from the page. Never throws. */
export function parseClientMessage(text: string): ClientParseResult {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    return fail('invalid JSON');
  }
  if (!isJsonObject(value)) return fail('message must be an object');
  switch (value['t']) {
    case 'rpc':
      return parseRpc(value['command']);
    case 'ui_response':
      return parseUiResponse(value['response']);
    case 'prompt_response': {
      const id = str(value, 'id');
      const answer = value['answer'];
      if (id === null || !isJsonObject(answer)) return fail('prompt_response needs id and answer');
      if (typeof answer['approved'] === 'boolean') {
        return {
          ok: true,
          message: { t: 'prompt_response', id, answer: { approved: answer['approved'] } },
        };
      }
      return answer['cancelled'] === true
        ? { ok: true, message: { t: 'prompt_response', id, answer: { cancelled: true } } }
        : fail('malformed prompt answer');
    }
    case 'ui_result': {
      const id = str(value, 'id');
      if (id === null) return fail('ui_result needs id');
      if (value['ok'] === false) {
        const error = str(value, 'error');
        return error === null
          ? fail('ui_result needs error')
          : { ok: true, message: { t: 'ui_result', id, ok: false, error } };
      }
      const result = value['result'];
      if (value['ok'] !== true || !isJsonObject(result))
        return fail('ui_result needs ok and result');
      // JSON boundary: the viewport bridge on the page builds this object; the consumer re-checks fields.
      return {
        ok: true,
        message: { t: 'ui_result', id, ok: true, result: result as unknown as ViewportResult },
      };
    }
    case 'restart':
      return { ok: true, message: { t: 'restart' } };
    case 'ping':
      return { ok: true, message: { t: 'ping' } };
    default:
      return fail('unknown message type');
  }
}

export function parseServerMessage(text: string): OmpServerMessage | null {
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(value) || typeof value['t'] !== 'string') return null;
  // JSON boundary: the server is our own code and emits only OmpServerMessage variants.
  return value as unknown as OmpServerMessage;
}

/** Names of the host tools the server registers with omp (stable: used by the panel to style cards). */
export const HSW_TOOL_NAMES = [
  'wall_get',
  'wall_apply',
  'wall_undo',
  'wall_bank_search',
  'wall_tools_search',
  'wall_add_tool',
  'wall_seat_tools',
  'wall_select',
  'wall_view',
  'wall_request_input',
  'wall_clean_background',
  'wall_analyse_hang',
  'app_command',
] as const;
export type HswToolName = (typeof HSW_TOOL_NAMES)[number];
