/** Contracts between the omp session supervisor and the wall tools it registers as host tools. */
import type {
  HswPromptAnswer,
  HswPromptRequest,
  JsonObject,
  JsonValue,
  OmpToolResult,
  ViewportCall,
  ViewportResult,
} from '@hsw-editor/omp-protocol';
import type { OmpConfig } from './config.ts';

export interface HostToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** JSON Schema of the tool arguments (generated from `packages/core` zod schemas where they exist). */
  readonly parameters: JsonObject;
}

export interface HostToolContext {
  readonly wallId: string;
  /** Aborted when omp cancels the call (`host_tool_cancel`) or the session stops. */
  readonly signal: AbortSignal;
}

export interface HostTool {
  readonly definition: HostToolDefinition;
  execute(args: JsonValue, context: HostToolContext): Promise<OmpToolResult>;
}

/** What a tool may ask of the attached page. */
export interface ViewportPort {
  call(call: ViewportCall, signal: AbortSignal): Promise<ViewportResult>;
}

/** What a tool may ask of the user: the fields of a prompt the session completes with ids. */
export type PromptDraft = Omit<HswPromptRequest, 'id' | 'wallId' | 'toolName'>;

/** Resolves when a client answers, or with `{ cancelled: true }` (no client, tool cancelled). */
export interface PromptPort {
  ask(toolName: string, draft: PromptDraft, signal: AbortSignal): Promise<HswPromptAnswer>;
}

export interface ToolEnv {
  readonly wallId: string;
  readonly config: OmpConfig;
  readonly viewport: ViewportPort;
  readonly prompts: PromptPort;
}

export type ToolFactory = (env: ToolEnv) => readonly HostTool[];
