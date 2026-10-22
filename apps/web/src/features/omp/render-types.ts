/** Types the vendored omp transcript renderer imports in place of upstream's `lib/client`. */

export interface ActiveTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  intent?: string;
  partialResult?: unknown;
  startedAt: number;
}

export type ConnectionPhase = 'connecting' | 'live' | 'reconnecting' | 'closed';
