/**
 * State machine of one "ask the AI" conversation in the palette: the streamed answer, the actions
 * the AI planned through `app_command`, and the approval prompt that holds changing actions back.
 * Pure of React and of the app's globals: everything it needs is injected.
 */
import { createValueStore } from '#state-backend';
import {
  type AiAnswerState,
  type AiRun,
  type ApprovalGate,
  type ApprovalMode,
  type AppCommandResult,
  type Disposer,
  IDLE_AI_ANSWER,
  type Locale,
  type PaletteAiBridge,
  type PlannedAction,
  type PlanStatus,
  reduceAiAnswer,
} from '@hsw-editor/commands';
import type { ValueStore } from '@/state/types.ts';

export interface PendingApproval {
  readonly plan: PlannedAction;
}

export interface AiSessionDeps {
  readonly bridge: () => PaletteAiBridge;
  readonly approvalMode: () => ApprovalMode;
  readonly locale: () => Locale;
  /** `executeAppCommand` bound to the app's registry, context and this session's gate. */
  readonly executeAppCommand: (
    gate: ApprovalGate,
    request: unknown,
    signal: AbortSignal | undefined,
  ) => Promise<AppCommandResult>;
}

interface Waiting {
  readonly plan: PlannedAction;
  readonly settle: (approved: boolean) => void;
}

const UNATTENDED_MESSAGE =
  'the user is not looking at the command palette, so this action cannot be approved; ask them to open the palette (Ctrl/Cmd+K), ask again there and approve it';

export class AiSession {
  readonly answer: ValueStore<AiAnswerState> = createValueStore<AiAnswerState>(IDLE_AI_ANSWER);
  /** The prompt the user must answer now (the oldest waiting one), or null. */
  readonly approval: ValueStore<PendingApproval | null> = createValueStore<PendingApproval | null>(
    null,
  );
  private runId = 0;
  private run: AiRun | null = null;
  private live: object | null = null;
  private waiting: Waiting[] = [];
  private detach: Disposer | null = null;

  /** Mounted approval prompts (the palette's answer pane). Without one nobody can say yes. */
  private approvalUis = 0;

  constructor(private readonly deps: AiSessionDeps) {}

  /** Registers `app_command` with the current bridge; call again whenever the bridge changes. */
  attach(): void {
    this.detach?.();
    this.detach = this.deps.bridge().setAppCommandHandler((request, signal) => {
      let unattended = false;
      const gate: ApprovalGate = {
        mode: () => this.deps.approvalMode(),
        announce: (plan, status) => this.announce(plan, status),
        request: (plan, signal) => {
          if (this.approvalUis > 0) return this.requestApproval(plan, signal);
          unattended = true;
          return Promise.resolve(false);
        },
      };
      return this.deps.executeAppCommand(gate, request, signal).then((result) =>
        // The generic "not approved" would send the AI away with no hint of what to do next.
        unattended && !result.ok && result.code === 'rejected'
          ? { ...result, message: UNATTENDED_MESSAGE }
          : result,
      );
    });
  }

  /**
   * Declares that the user can see and answer approval prompts (the answer pane is on screen).
   * Without a prompt on screen a changing action is refused at once instead of waiting forever.
   */
  attachApprovalUi(): Disposer {
    this.approvalUis += 1;
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.approvalUis -= 1;
      if (this.approvalUis === 0) this.settleAll(false);
    };
  }

  dispose(): void {
    this.cancel();
    this.detach?.();
    this.detach = null;
  }

  /** Sends a question; a running one is cancelled first. Does nothing when no bridge is ready. */
  ask(text: string): void {
    const bridge = this.deps.bridge();
    if (bridge.status() === 'unavailable') return;
    this.cancel();
    this.runId += 1;
    const runId = this.runId;
    this.answer.set(reduceAiAnswer(this.answer.get(), { t: 'ask', runId }));
    // A stopped run may still deliver events; they belong to nobody once `live` moved on.
    const token = {};
    this.live = token;
    this.run = bridge.ask({ text, locale: this.deps.locale() }, (event) => {
      if (this.live !== token) return;
      this.answer.set(reduceAiAnswer(this.answer.get(), { t: 'event', runId, event }));
    });
  }

  /** Stops the answer and refuses whatever was waiting for approval. */
  cancel(): void {
    const run = this.run;
    this.run = null;
    this.live = null;
    if (run !== null) {
      run.cancel();
      if (this.answer.get().status === 'streaming') {
        this.answer.set(
          reduceAiAnswer(this.answer.get(), {
            t: 'event',
            runId: this.runId,
            event: { t: 'done' },
          }),
        );
      }
    }
    this.settleAll(false);
  }

  reset(): void {
    this.cancel();
    this.answer.set(reduceAiAnswer(this.answer.get(), { t: 'reset' }));
  }

  /** The user's answer to the prompt on screen. */
  respond(approved: boolean): void {
    this.waiting[0]?.settle(approved);
  }

  private announce(plan: PlannedAction, status: PlanStatus): void {
    // Nothing is on screen to list the action in: an idle answer has no run to attach it to.
    if (this.answer.get().status === 'idle') return;
    this.answer.set(
      reduceAiAnswer(this.answer.get(), { t: 'plan', runId: this.runId, plan, status }),
    );
  }

  private requestApproval(plan: PlannedAction, signal: AbortSignal | undefined): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const waiting: Waiting = {
        plan,
        settle: (approved) => {
          this.waiting = this.waiting.filter((entry) => entry !== waiting);
          signal?.removeEventListener('abort', onAbort);
          this.showNext();
          resolve(approved);
        },
      };
      const onAbort = (): void => waiting.settle(false);
      if (signal?.aborted === true) {
        resolve(false);
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiting);
      this.showNext();
    });
  }

  private settleAll(approved: boolean): void {
    for (const entry of [...this.waiting]) entry.settle(approved);
  }

  private showNext(): void {
    const next = this.waiting[0];
    this.approval.set(next === undefined ? null : { plan: next.plan });
  }
}
