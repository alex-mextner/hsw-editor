import { useCallback, useEffect, useRef, useState } from 'react';
import type { Draft } from '@hsw-editor/tools/contract';
import {
  createDraft,
  fetchDraft,
  fetchJob,
  fetchVisionStatus,
  jobErrorText,
  startAnalyzeJob,
  type CalibrationInput,
  type DraftMode,
  type VisionStatus,
} from '../api.ts';
import { isVisionUnavailable } from './wizardModel.ts';

const POLL_MS = 600;

export type AnalysisState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'uploading' }
  | {
      readonly phase: 'analysing';
      readonly draftId: string;
      readonly done: number | null;
      readonly total: number | null;
      readonly message: string | null;
    }
  | { readonly phase: 'ready'; readonly draft: Draft }
  /** The vision service did not answer: the draft is kept, "retry" analyses it again. */
  | { readonly phase: 'unavailable'; readonly draftId: string | null; readonly message: string }
  | { readonly phase: 'failed'; readonly draftId: string | null; readonly message: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Vision status of the daemon, checked on mount and on demand. */
export function useVisionStatus(): {
  readonly status: VisionStatus | null;
  readonly recheck: () => void;
} {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetchVisionStatus(controller.signal).then(setStatus, () => undefined);
    return () => controller.abort();
  }, [round]);
  return {
    status,
    recheck: () => {
      setStatus(null);
      setRound((value) => value + 1);
    },
  };
}

/**
 * Upload photos as a draft, run the `tools.analyze` job and follow it to the review state. Never fabricates a
 * result: a vision service that is down ends in `unavailable`, any other failure in `failed`.
 */
export function useAnalysis(): {
  readonly state: AnalysisState;
  readonly start: (input: {
    readonly files: readonly File[];
    readonly mode: DraftMode;
    readonly calibration: CalibrationInput | null;
  }) => void;
  readonly retry: () => void;
  readonly setDraft: (draft: Draft) => void;
  readonly reset: () => void;
} {
  const [state, setState] = useState<AnalysisState>({ phase: 'idle' });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const analyse = useCallback(async (draftId: string, signal: AbortSignal): Promise<void> => {
    setState({ phase: 'analysing', draftId, done: null, total: null, message: null });
    try {
      const jobId = await startAnalyzeJob(draftId);
      while (!signal.aborted) {
        const job = await fetchJob(jobId);
        if (job.state === 'succeeded') {
          setState({ phase: 'ready', draft: await fetchDraft(draftId) });
          return;
        }
        if (job.state === 'failed' || job.state === 'cancelled') {
          const text = jobErrorText(job) ?? job.state;
          setState(
            isVisionUnavailable(text)
              ? { phase: 'unavailable', draftId, message: text }
              : { phase: 'failed', draftId, message: text },
          );
          return;
        }
        setState({
          phase: 'analysing',
          draftId,
          done: job.progress?.done ?? null,
          total: job.progress?.total ?? null,
          message: job.progress?.message ?? null,
        });
        await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      }
    } catch (error) {
      if (signal.aborted) return;
      const message = messageOf(error);
      setState(
        isVisionUnavailable(message)
          ? { phase: 'unavailable', draftId, message }
          : { phase: 'failed', draftId, message },
      );
    }
  }, []);

  const start = useCallback(
    (input: {
      readonly files: readonly File[];
      readonly mode: DraftMode;
      readonly calibration: CalibrationInput | null;
    }): void => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState({ phase: 'uploading' });
      createDraft({ ...input, signal: controller.signal }).then(
        (draft) => analyse(draft.id, controller.signal),
        (error: unknown) => {
          if (!controller.signal.aborted) {
            setState({ phase: 'failed', draftId: null, message: messageOf(error) });
          }
        },
      );
    },
    [analyse],
  );

  const retry = useCallback((): void => {
    if (state.phase !== 'unavailable' && state.phase !== 'failed') return;
    if (state.draftId === null) {
      setState({ phase: 'idle' });
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    void analyse(state.draftId, controller.signal);
  }, [analyse, state]);

  return {
    state,
    start,
    retry,
    setDraft: (draft) => setState({ phase: 'ready', draft }),
    reset: () => {
      abort.current?.abort();
      setState({ phase: 'idle' });
    },
  };
}
