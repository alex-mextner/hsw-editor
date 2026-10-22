/**
 * The palette's side of the AI: the narrow interface to the omp bridge, and the state of the
 * answer pane (streamed text plus the actions the AI planned or ran).
 */
import type { AppCommandResult, PlannedAction, PlanStatus } from './appCommand.ts';
import type { Disposer } from './registry.ts';
import type { Locale } from './text.ts';

export interface AiAskRequest {
  readonly text: string;
  readonly locale: Locale;
}

export type AiEvent =
  | { readonly t: 'delta'; readonly text: string }
  | { readonly t: 'done' }
  | { readonly t: 'error'; readonly message: string };

export interface AiRun {
  /** Stops the answer (omp `abort`). Safe to call after completion. */
  readonly cancel: () => void;
}

export type AiBridgeStatus = 'ready' | 'connecting' | 'unavailable';

/**
 * What the palette needs from the omp bridge: ask a question in "palette mode" (short answers,
 * actions through `app_command`) and receive the answer as a stream. The page registers
 * `executeAppCommand` as the handler of the `app_command` host tool via `setAppCommandHandler`;
 * the bridge passes an abort signal that fires when the run is cancelled.
 */
export interface PaletteAiBridge {
  readonly status: () => AiBridgeStatus;
  readonly onStatus: (listener: (status: AiBridgeStatus) => void) => Disposer;
  readonly ask: (request: AiAskRequest, onEvent: (event: AiEvent) => void) => AiRun;
  readonly setAppCommandHandler: (
    handler: (request: unknown, signal?: AbortSignal) => Promise<AppCommandResult>,
  ) => Disposer;
}

export interface PlanEntry {
  readonly plan: PlannedAction;
  readonly status: PlanStatus;
}

export interface AiAnswerState {
  /** The run the pane is showing; events of any other run are ignored. */
  readonly runId: number;
  readonly status: 'idle' | 'streaming' | 'done' | 'error';
  readonly text: string;
  readonly error: string | null;
  readonly plans: readonly PlanEntry[];
}

export const IDLE_AI_ANSWER: AiAnswerState = {
  runId: 0,
  status: 'idle',
  text: '',
  error: null,
  plans: [],
};

export type AiAnswerAction =
  | { readonly t: 'ask'; readonly runId: number }
  | { readonly t: 'event'; readonly runId: number; readonly event: AiEvent }
  | {
      readonly t: 'plan';
      readonly runId: number;
      readonly plan: PlannedAction;
      readonly status: PlanStatus;
    }
  | { readonly t: 'reset' };

export function reduceAiAnswer(state: AiAnswerState, action: AiAnswerAction): AiAnswerState {
  switch (action.t) {
    case 'reset':
      return IDLE_AI_ANSWER;
    case 'ask':
      return { ...IDLE_AI_ANSWER, runId: action.runId, status: 'streaming' };
    case 'event': {
      // A cancelled or replaced question can still deliver late events.
      if (action.runId !== state.runId) return state;
      const { event } = action;
      // After an error nothing more is accepted: the pane would show an error and live text at once.
      if (state.status === 'error') return state;
      if (event.t === 'delta')
        return { ...state, status: 'streaming', text: state.text + event.text };
      if (event.t === 'done') return { ...state, status: 'done' };
      return { ...state, status: 'error', error: event.message };
    }
    case 'plan': {
      if (action.runId !== state.runId) return state;
      const known = state.plans.some((entry) => entry.plan.id === action.plan.id);
      const entry: PlanEntry = { plan: action.plan, status: action.status };
      return {
        ...state,
        plans: known
          ? state.plans.map((existing) => (existing.plan.id === action.plan.id ? entry : existing))
          : [...state.plans, entry],
      };
    }
  }
}
