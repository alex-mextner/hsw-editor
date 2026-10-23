/**
 * Chord state machine and key dispatcher.
 *
 * {@link stepChord} is the pure transition: it takes the chord typed so far, the next stroke and the
 * active context, and says whether the key is not ours (`pass`), starts or continues a chord
 * (`pending`), completes a binding (`run`) or breaks a chord in progress (`abort`).
 * {@link KeyDispatcher} wraps it with timeout, IME and text-input rules for a real event stream.
 */
import type { Binding, Keymap } from './keymap.ts';
import { eventStrokeId, isImeEvent, type KeyEventLike } from './keys.ts';
import { type Context, matchesWhen } from './when.ts';

export const DEFAULT_CHORD_TIMEOUT_MS = 1500;

export interface ChordState {
  /** Stroke ids typed so far; empty when idle. */
  readonly typed: readonly string[];
  /** Epoch ms of the last accepted stroke of the pending chord. */
  readonly lastAt: number;
}

export const IDLE_CHORD: ChordState = { typed: [], lastAt: 0 };

export type StepResult =
  | { readonly kind: 'pass' }
  | { readonly kind: 'run'; readonly binding: Binding }
  | { readonly kind: 'pending'; readonly candidates: readonly Binding[] }
  | { readonly kind: 'abort'; readonly reason: 'escape' | 'mismatch' };

export interface Step {
  readonly state: ChordState;
  readonly result: StepResult;
}

export interface StepInput {
  readonly strokeId: string;
  /** The key is Escape: it cancels a chord in progress unless a binding continues with it. */
  readonly escape: boolean;
  /** A text field has focus. */
  readonly typing: boolean;
  readonly context: Context;
  readonly now: number;
  readonly timeoutMs: number;
}

/** A pending chord that has waited too long is forgotten. */
export function expireChord(state: ChordState, now: number, timeoutMs: number): ChordState {
  return state.typed.length > 0 && now - state.lastAt > timeoutMs ? IDLE_CHORD : state;
}

function prefixOf(binding: Binding, typed: readonly string[]): boolean {
  const ids = binding.chordId.split(' ');
  return typed.every((id, index) => ids[index] === id);
}

/** User bindings beat defaults, a narrower clause beats a wider one, later beats earlier. */
function pickWinner(candidates: readonly Binding[]): Binding | undefined {
  let best: Binding | undefined;
  let bestRank = -1;
  for (const binding of candidates) {
    const rank = (binding.source === 'user' ? 2 : 0) + (binding.when === undefined ? 0 : 1);
    if (rank >= bestRank) {
      best = binding;
      bestRank = rank;
    }
  }
  return best;
}

export function stepChord(keymap: Keymap, state: ChordState, input: StepInput): Step {
  const current = expireChord(state, input.now, input.timeoutMs);
  const pendingNow = current.typed.length > 0;
  const typed = [...current.typed, input.strokeId];
  const candidates = keymap.bindings.filter(
    (binding) =>
      // The input guard applies where a chord starts; a chord already in progress continues.
      (pendingNow || !input.typing || binding.allowInInput) &&
      prefixOf(binding, typed) &&
      matchesWhen(binding.when, input.context),
  );
  if (candidates.length === 0) {
    if (!pendingNow) return { state: IDLE_CHORD, result: { kind: 'pass' } };
    // Escape cancels a chord in progress, unless a binding actually continues with it (above).
    const reason = input.escape ? 'escape' : 'mismatch';
    return { state: IDLE_CHORD, result: { kind: 'abort', reason } };
  }
  const complete = candidates.filter((binding) => binding.chord.length === typed.length);
  const winner = pickWinner(complete);
  if (winner !== undefined) {
    return { state: IDLE_CHORD, result: { kind: 'run', binding: winner } };
  }
  return {
    state: { typed, lastAt: input.now },
    result: { kind: 'pending', candidates },
  };
}

// ---- Dispatcher ---------------------------------------------------------------------------------

export interface PendingChord {
  /** Stroke ids typed so far. */
  readonly typed: readonly string[];
  /** Bindings the chord can still complete into, for the "waiting for next key" hint. */
  readonly candidates: readonly Binding[];
}

export interface DispatcherOptions {
  readonly getKeymap: () => Keymap;
  readonly getContext: () => Context;
  /** Runs the binding's command; the dispatcher does not await it. */
  readonly onRun: (binding: Binding) => void;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** Schedules `callback` and returns a function that cancels it. */
  readonly setTimer?: (callback: () => void, ms: number) => () => void;
}

export interface KeyOutcome {
  /** The caller must `preventDefault` and `stopPropagation`: the key belongs to the keymap. */
  readonly consumed: boolean;
}

const NOT_CONSUMED: KeyOutcome = { consumed: false };
const CONSUMED: KeyOutcome = { consumed: true };

export class KeyDispatcher {
  private state: ChordState = IDLE_CHORD;
  private pending: PendingChord | null = null;
  /**
   * The stroke that ended a chord (completed it, broke it, or let it time out); its auto-repeats
   * are swallowed until another key arrives. `run` is the repeat:true binding that completed on it.
   */
  private settled: { readonly strokeId: string; readonly run: Binding | null } | null = null;
  private cancelTimer: (() => void) | undefined;
  private readonly listeners = new Set<(pending: PendingChord | null) => void>();
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;

  constructor(private readonly options: DispatcherOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CHORD_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.setTimer =
      options.setTimer ??
      ((callback, ms) => {
        const handle = setTimeout(callback, ms);
        return () => clearTimeout(handle);
      });
  }

  /** The chord in progress, or null. */
  get pendingChord(): PendingChord | null {
    return this.pending;
  }

  subscribe(listener: (pending: PendingChord | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Drops a chord in progress (palette opened, focus moved to a field). The key still held stays
   * swallowed: the dialog this reset belongs to may have been opened by that very chord, and a
   * repeat of its first key must not start the chord again. A held repeat:true command stops.
   */
  reset(): void {
    const held = this.pending?.typed.at(-1) ?? this.settled?.strokeId;
    this.state = IDLE_CHORD;
    this.settled = held === undefined ? null : { strokeId: held, run: null };
    this.setPending(null);
  }

  handleKeyDown(event: KeyEventLike, typing: boolean): KeyOutcome {
    // Composition keystrokes belong to the input method; never touch them or a chord in progress.
    if (isImeEvent(event)) return NOT_CONSUMED;
    // Holding the first key of a chord repeats it; that must neither extend nor break the chord.
    if (event.repeat === true && this.pending !== null) return CONSUMED;
    const keymap = this.options.getKeymap();
    const strokeId = eventStrokeId(event, keymap.platform);
    if (strokeId === null) return NOT_CONSUMED;
    // The key that just finished or broke a chord keeps repeating while held; the browser must not
    // get those repeats (Ctrl+S would open Save Page). A repeat:true command keeps firing, but only
    // while the same binding is still enabled: the context or focus may change during the hold.
    const { settled } = this;
    if (event.repeat === true && settled !== null && strokeId === settled.strokeId) {
      const { run } = settled;
      if (
        run !== null &&
        (!typing || run.allowInInput) &&
        matchesWhen(run.when, this.options.getContext())
      ) {
        this.options.onRun(run);
      }
      return CONSUMED;
    }
    this.settled = null;
    const step = stepChord(keymap, this.state, {
      strokeId,
      escape: event.key === 'Escape',
      typing,
      context: this.options.getContext(),
      now: this.now(),
      timeoutMs: this.timeoutMs,
    });
    this.state = step.state;
    const { result } = step;
    switch (result.kind) {
      case 'pass':
        this.setPending(null);
        return NOT_CONSUMED;
      case 'abort':
        this.setPending(null);
        this.settled = { strokeId, run: null };
        return CONSUMED;
      case 'pending':
        this.setPending({ typed: step.state.typed, candidates: result.candidates });
        return CONSUMED;
      case 'run':
        this.setPending(null);
        if (result.binding.chord.length > 1) {
          this.settled = { strokeId, run: result.binding.repeat ? result.binding : null };
        }
        if (event.repeat !== true || result.binding.repeat) this.options.onRun(result.binding);
        return CONSUMED;
    }
  }

  private setPending(next: PendingChord | null): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.pending = next;
    if (next !== null) {
      // The pending chord's last stroke may still be held; its auto-repeats must not restart it.
      const heldStroke = next.typed.at(-1);
      this.cancelTimer = this.setTimer(() => {
        this.cancelTimer = undefined;
        this.settled = heldStroke === undefined ? null : { strokeId: heldStroke, run: null };
        this.state = IDLE_CHORD;
        this.setPending(null);
      }, this.timeoutMs);
    }
    for (const listener of [...this.listeners]) listener(next);
  }
}
