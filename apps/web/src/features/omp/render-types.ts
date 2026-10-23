/** Types the vendored transcript renderers import from the host app (see vendor/VENDORED.md). */
export interface ActiveTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  intent?: string;
  partialResult?: unknown;
  startedAt: number;
}

export type ConnectionPhase = 'connecting' | 'live' | 'reconnecting' | 'closed';
