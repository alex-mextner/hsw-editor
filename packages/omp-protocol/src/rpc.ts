/**
 * Typed subset of the `omp --mode rpc-ui` JSONL protocol (omp 18.x, see `omp://rpc.md`).
 *
 * Only the frames and commands the hsw-editor panel and bridge understand are modelled; every other
 * frame type is passed through untouched by the server and ignored by the panel reducer. Child frames
 * are parsed from JSON at one boundary (`parseOmpFrame`) and narrowed by their `type` field afterwards.
 */
import type {
  AssistantMessage,
  DeveloperMessage,
  ImageContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
} from '@oh-my-pi/pi-wire';

export type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  UserMessage,
};

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- Messages ---------------------------------------------------------------------------------

export type OmpWireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

/** Messages the transcript has no dedicated renderer for (custom, bash execution, summaries, ...). */
export interface OmpOtherMessage {
  readonly role: string;
  readonly timestamp?: number;
  readonly content?: string | (TextContent | ImageContent)[];
  readonly customType?: string;
  readonly display?: boolean;
  readonly details?: JsonValue;
  readonly command?: string;
  readonly output?: string;
  readonly exitCode?: number;
  readonly summary?: string;
}

export type OmpMessage = OmpWireMessage | OmpOtherMessage;

const WIRE_ROLES: ReadonlySet<string> = new Set(['user', 'developer', 'assistant', 'toolResult']);

export function isWireMessage(message: OmpMessage): message is OmpWireMessage {
  return WIRE_ROLES.has(message.role);
}

// ---- State ------------------------------------------------------------------------------------

export const THINKING_LEVELS = [
  'inherit',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;
export type OmpThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface OmpModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly api?: string;
  readonly reasoning?: boolean;
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

export type OmpTodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked';

export interface OmpTodoTask {
  readonly content: string;
  readonly status: OmpTodoStatus;
  readonly blocker?: string;
}

export interface OmpTodoPhase {
  readonly name: string;
  readonly tasks: readonly OmpTodoTask[];
}

export interface OmpContextUsage {
  readonly tokens: number | null;
  readonly contextWindow: number | null;
  readonly percent: number | null;
}

export interface OmpQueuedMessages {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}

export interface OmpUsageLimit {
  readonly stage: 'wrap_up' | 'low_priority';
  readonly resetsAtSec: number;
  readonly allowanceLeftPercent?: number;
}

/** `get_state` payload, minus the bulky `systemPrompt` / `dumpTools` which the server strips. */
export interface OmpState {
  readonly model?: OmpModel;
  readonly thinkingLevel?: OmpThinkingLevel;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly steeringMode: 'all' | 'one-at-a-time';
  readonly followUpMode: 'all' | 'one-at-a-time';
  readonly interruptMode: 'immediate' | 'wait';
  readonly sessionFile?: string;
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled: boolean;
  readonly fastModeEnabled?: boolean;
  readonly fastModeActive?: boolean;
  readonly messageCount: number;
  readonly queuedMessageCount: number;
  readonly hasPendingAsyncWork?: boolean;
  readonly isSettled?: boolean;
  readonly queuedMessages?: OmpQueuedMessages;
  readonly todoPhases?: readonly OmpTodoPhase[];
  readonly contextUsage?: OmpContextUsage;
  readonly usageLimit?: OmpUsageLimit;
}

export interface OmpSessionStats {
  readonly sessionFile?: string;
  readonly sessionId: string;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly totalMessages: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning?: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly premiumRequests?: number;
  readonly cost: number;
  readonly contextUsage?: OmpContextUsage;
}

export interface OmpSlashCommand {
  readonly name: string;
  readonly source?: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly input?: { readonly hint?: string };
  readonly subcommands?: readonly { readonly name: string; readonly description?: string }[];
}

// ---- Commands (page -> omp), the allow-list the server forwards ----------------------------------

interface WithId {
  /** Required by the bridge: responses are matched to commands by id. */
  readonly id: string;
}

export type OmpRpcCommand = WithId &
  (
    | {
        readonly type: 'prompt';
        readonly message: string;
        readonly images?: readonly ImageContent[];
        readonly streamingBehavior?: 'steer' | 'followUp';
      }
    | {
        readonly type: 'steer';
        readonly message: string;
        readonly images?: readonly ImageContent[];
      }
    | {
        readonly type: 'follow_up';
        readonly message: string;
        readonly images?: readonly ImageContent[];
      }
    | {
        readonly type: 'abort_and_prompt';
        readonly message: string;
        readonly images?: readonly ImageContent[];
      }
    | {
        readonly type: 'remove_queued_message';
        readonly message: string;
        readonly queue: 'steering' | 'followUp';
      }
    | { readonly type: 'promote_queued_message'; readonly message: string }
    | { readonly type: 'abort' }
    | { readonly type: 'abort_and_restore_queue' }
    | { readonly type: 'new_session' }
    | { readonly type: 'switch_session'; readonly sessionPath: string }
    | { readonly type: 'fork'; readonly entryId?: string }
    | { readonly type: 'branch'; readonly entryId: string }
    | { readonly type: 'get_state' }
    | { readonly type: 'get_messages' }
    | { readonly type: 'get_entries'; readonly since?: string }
    | { readonly type: 'get_tree' }
    | { readonly type: 'get_available_commands' }
    | { readonly type: 'get_available_models' }
    | { readonly type: 'set_model'; readonly provider: string; readonly modelId: string }
    | { readonly type: 'cycle_model' }
    | { readonly type: 'get_available_thinking_levels' }
    | { readonly type: 'set_thinking_level'; readonly level: OmpThinkingLevel }
    | { readonly type: 'cycle_thinking_level' }
    | { readonly type: 'set_steering_mode'; readonly mode: 'all' | 'one-at-a-time' }
    | { readonly type: 'set_follow_up_mode'; readonly mode: 'all' | 'one-at-a-time' }
    | { readonly type: 'set_interrupt_mode'; readonly mode: 'immediate' | 'wait' }
    | { readonly type: 'compact'; readonly customInstructions?: string }
    | { readonly type: 'set_auto_compaction'; readonly enabled: boolean }
    | { readonly type: 'set_auto_retry'; readonly enabled: boolean }
    | { readonly type: 'abort_retry' }
    | { readonly type: 'set_fast_mode'; readonly enabled: boolean }
    | { readonly type: 'get_session_stats' }
    | { readonly type: 'set_session_name'; readonly name: string }
    | { readonly type: 'get_last_assistant_text' }
    | { readonly type: 'handoff'; readonly customInstructions?: string }
    | { readonly type: 'btw'; readonly question: string; readonly recordId?: string }
    | { readonly type: 'btw_cancel'; readonly recordId?: string }
    | { readonly type: 'get_btw_history' }
    | { readonly type: 'get_subagents' }
    | { readonly type: 'cancel_subagent'; readonly subagentId: string }
    | { readonly type: 'steer_subagent'; readonly subagentId: string; readonly message: string }
  );

export type OmpRpcCommandType = OmpRpcCommand['type'];

/** Commands the page must never send: shell access, credentials, host registration, filesystem writes. */
export const BLOCKED_RPC_COMMANDS: readonly string[] = [
  'bash',
  'abort_bash',
  'login',
  'logout',
  'get_login_providers',
  'get_logout_accounts',
  'export_html',
  'open_session',
  'set_host_tools',
  'set_host_uri_schemes',
  'set_event_filter',
  'set_subagent_subscription',
  'negotiate_protocol',
  'set_ask_dialog',
  'set_todos',
  'set_cache_warming',
  'live_start',
  'live_stop',
  'live_mute',
  'predict_word',
  'predict_word_feedback',
];

// ---- Frames (omp -> page) -----------------------------------------------------------------------

export interface OmpReadyFrame {
  readonly type: 'ready';
  readonly protocolVersion: number;
  readonly supportedProtocolVersions?: readonly number[];
  readonly maxFrameBytes?: number;
  readonly maxReassembledFrameBytes?: number;
}

export type OmpResponseFrame =
  | {
      readonly type: 'response';
      readonly id?: string;
      readonly command: string;
      readonly success: true;
      readonly data?: JsonValue;
    }
  | {
      readonly type: 'response';
      readonly id?: string;
      readonly command: string;
      readonly success: false;
      readonly error: string;
      readonly code?: string;
    };

export type OmpAssistantStreamEvent =
  | { readonly type: 'start' }
  | {
      readonly type: 'text_start' | 'thinking_start' | 'toolcall_start';
      readonly contentIndex: number;
    }
  | {
      readonly type: 'text_delta' | 'thinking_delta' | 'toolcall_delta';
      readonly contentIndex: number;
      readonly delta: string;
    }
  | {
      readonly type: 'text_end' | 'thinking_end';
      readonly contentIndex: number;
      readonly content: string;
    }
  | {
      readonly type: 'toolcall_end';
      readonly contentIndex: number;
      readonly toolCall: ToolCallContent;
    }
  | { readonly type: 'done'; readonly reason?: string }
  | { readonly type: 'error'; readonly reason?: string };

export interface OmpToolResult {
  readonly content: readonly (TextContent | ImageContent)[];
  readonly details?: JsonValue;
  readonly isError?: boolean;
}

export type OmpUiOptionDetail = { readonly description?: string };

export interface OmpAskOption {
  readonly label: string;
  readonly description?: string;
  readonly preview?: string;
}

export interface OmpAskQuestion {
  readonly id: string;
  readonly question: string;
  readonly header?: string;
  readonly options: readonly OmpAskOption[];
  readonly multi?: boolean;
  readonly recommended?: number;
}

/** Dialogs the page has to answer: they block the agent until answered (or cancelled/timed out). */
export type OmpDialogRequest =
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'select';
      readonly title: string;
      readonly options: readonly string[];
      readonly optionDetails?: readonly OmpUiOptionDetail[];
      readonly timeout?: number;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'confirm';
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'input';
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'editor';
      readonly title: string;
      readonly prefill?: string;
      readonly promptStyle?: boolean;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'ask';
      readonly questions: readonly OmpAskQuestion[];
      readonly timeout?: number;
    };

export type OmpUiRequest =
  | OmpDialogRequest
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'cancel';
      readonly targetId: string;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'notify';
      readonly message: string;
      readonly notifyType?: 'info' | 'warning' | 'error';
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'setStatus';
      readonly statusKey: string;
      readonly statusText?: string;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'setWidget';
      readonly widgetKey: string;
      readonly widgetLines?: readonly string[];
      readonly widgetPlacement?: 'aboveEditor' | 'belowEditor';
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'setTitle';
      readonly title: string;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'set_editor_text';
      readonly text: string;
    }
  | {
      readonly type: 'extension_ui_request';
      readonly id: string;
      readonly method: 'open_url';
      readonly url: string;
    };

export function isDialogRequest(request: OmpUiRequest): request is OmpDialogRequest {
  return (
    request.method === 'select' ||
    request.method === 'confirm' ||
    request.method === 'input' ||
    request.method === 'editor' ||
    request.method === 'ask'
  );
}

export type OmpUiResponse =
  | { readonly type: 'extension_ui_response'; readonly id: string; readonly value: string }
  | { readonly type: 'extension_ui_response'; readonly id: string; readonly confirmed: boolean }
  | {
      readonly type: 'extension_ui_response';
      readonly id: string;
      readonly cancelled: true;
      readonly timedOut?: boolean;
    }
  | {
      readonly type: 'extension_ui_response';
      readonly id: string;
      readonly answers: readonly {
        readonly id: string;
        readonly selectedOptions: readonly string[];
        readonly customInput?: string;
      }[];
    };

export type OmpEventFrame =
  | { readonly type: 'agent_start' }
  | {
      readonly type: 'agent_end';
      readonly messages?: readonly OmpMessage[];
      readonly messageCount?: number;
      readonly isTerminal?: boolean;
      readonly yielded?: boolean;
      readonly awaitingAsyncWork?: boolean;
    }
  | { readonly type: 'turn_start' }
  | { readonly type: 'turn_end'; readonly message?: OmpMessage }
  | { readonly type: 'message_start'; readonly message: OmpMessage; readonly messageId?: string }
  | { readonly type: 'message_end'; readonly message: OmpMessage; readonly messageId?: string }
  | {
      readonly type: 'message_update';
      readonly messageId?: string;
      readonly assistantMessageEvent: OmpAssistantStreamEvent;
    }
  | {
      readonly type: 'tool_execution_start';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: JsonValue;
      readonly intent?: string;
    }
  | {
      readonly type: 'tool_execution_update';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: JsonValue;
      readonly partialResult?: JsonValue;
    }
  | {
      readonly type: 'tool_execution_end';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result: OmpToolResult;
      readonly isError?: boolean;
    }
  | {
      readonly type: 'queue_update';
      readonly steering: readonly string[];
      readonly followUp: readonly string[];
    }
  | {
      readonly type: 'notice';
      readonly level: 'info' | 'warning' | 'error';
      readonly message: string;
      readonly source?: string;
    }
  | { readonly type: 'auto_compaction_start'; readonly reason?: string; readonly action?: string }
  | {
      readonly type: 'auto_compaction_end';
      readonly aborted?: boolean;
      readonly willRetry?: boolean;
      readonly errorMessage?: string;
      readonly skipped?: boolean;
    }
  | {
      readonly type: 'auto_retry_start';
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorMessage: string;
    }
  | {
      readonly type: 'auto_retry_end';
      readonly success: boolean;
      readonly attempt: number;
      readonly finalError?: string;
    }
  | { readonly type: 'model_changed'; readonly model?: OmpModel }
  | {
      readonly type: 'thinking_level_changed';
      readonly thinkingLevel?: OmpThinkingLevel;
      readonly resolved?: string;
    }
  | {
      readonly type: 'extension_error';
      readonly extensionPath?: string;
      readonly event?: string;
      readonly error: string;
    }
  | { readonly type: 'available_commands_update'; readonly commands: readonly OmpSlashCommand[] }
  | {
      readonly type: 'prompt_result';
      readonly id?: string;
      readonly agentInvoked: boolean;
      readonly status: string;
      readonly error?: string;
      readonly sessionSettled?: boolean;
    }
  | { readonly type: 'session_settled' }
  | { readonly type: 'todo_auto_clear' }
  | { readonly type: 'command_output'; readonly text: string }
  | { readonly type: 'rpc_frame_error'; readonly message?: string }
  | {
      readonly type: 'btw_delta';
      readonly recordId: string;
      readonly delta: string;
    };

/** Requests for the tools the server registered with `set_host_tools`. Never forwarded to the page. */
export type OmpHostFrame =
  | {
      readonly type: 'host_tool_call';
      readonly id: string;
      readonly toolCallId: string;
      readonly toolName: string;
      readonly arguments: JsonValue;
    }
  | { readonly type: 'host_tool_cancel'; readonly id: string; readonly targetId: string };

export type OmpFrame =
  | OmpReadyFrame
  | OmpResponseFrame
  | OmpUiRequest
  | OmpEventFrame
  | OmpHostFrame;

/** A frame whose `type` this client does not model; carried so the server can still relay it. */
export interface OmpUnknownFrame {
  readonly type: string;
}

/** Parse one JSONL line from the child. Returns null for non-objects / frames without a string `type`. */
export function parseOmpFrame(line: string): (OmpFrame | OmpUnknownFrame) | null {
  let value: JsonValue;
  try {
    value = JSON.parse(line) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(value) || typeof value['type'] !== 'string') return null;
  // JSON boundary: the discriminant is verified above; consumers narrow by `type` and ignore the rest.
  return value as unknown as OmpFrame | OmpUnknownFrame;
}

export function isKnownFrame(frame: OmpFrame | OmpUnknownFrame): frame is OmpFrame {
  return KNOWN_FRAME_TYPES.has(frame.type);
}

const KNOWN_FRAME_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'response',
  'extension_ui_request',
  'host_tool_call',
  'host_tool_cancel',
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_start',
  'message_end',
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'queue_update',
  'notice',
  'auto_compaction_start',
  'auto_compaction_end',
  'auto_retry_start',
  'auto_retry_end',
  'model_changed',
  'thinking_level_changed',
  'extension_error',
  'available_commands_update',
  'prompt_result',
  'session_settled',
  'todo_auto_clear',
  'command_output',
  'rpc_frame_error',
  'btw_delta',
]);

// ---- Response payloads --------------------------------------------------------------------------

export interface OmpResponseDataMap {
  readonly get_state: OmpState;
  readonly get_messages: { readonly messages: readonly OmpMessage[] };
  readonly get_available_models: { readonly models: readonly OmpModel[] };
  readonly get_available_thinking_levels: { readonly levels: readonly OmpThinkingLevel[] };
  readonly get_session_stats: OmpSessionStats;
  readonly get_available_commands: { readonly commands: readonly OmpSlashCommand[] };
  readonly get_last_assistant_text: { readonly text: string | null };
  readonly set_model: OmpModel;
}

/** Typed accessor for a successful response of a command whose payload shape is modelled above. */
export function responseData<K extends keyof OmpResponseDataMap>(
  frame: OmpResponseFrame,
  command: K,
): OmpResponseDataMap[K] | null {
  if (!frame.success || frame.command !== command || frame.data === undefined) return null;
  // JSON boundary: the payload shape is fixed by omp's rpc-types for these commands.
  return frame.data as unknown as OmpResponseDataMap[K];
}
