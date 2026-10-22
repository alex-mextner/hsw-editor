import { useCallback, useEffect, useRef, useState } from 'react';
import type { Calibration } from '@hsw-editor/core';
import { ApiError } from '@/api/http.ts';
import {
  cancelJob,
  fetchJob,
  gridCalibration,
  jobErrorText,
  startGridJob,
  type GridResult,
  type JobProgress,
} from './calibrationJob.ts';

const POLL_MS = 700;

export type DetectState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly progress: JobProgress | null }
  /** The server has no `calibrate-grid` handler (the vision service is optional). */
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'review'; readonly result: GridResult; readonly calibration: Calibration }
  | { readonly phase: 'failed'; readonly message: string | null };

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Runs the grid detector for a photo and follows the job by polling. Leaving the widget stops the
 * polling; `cancel` additionally asks the server to abort the job.
 */
export function useGridDetection(wallId: string, photoId: string) {
  const [state, setState] = useState<DetectState>({ phase: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const jobId = useRef<string | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(async () => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState({ phase: 'running', progress: null });
    try {
      let job = await startGridJob(wallId, photoId);
      jobId.current = job.id;
      // Cancelled while the start request was in flight: nothing else will stop the server job.
      if (abort.signal.aborted) {
        cancelJob(job.id).catch(() => undefined);
        return;
      }
      while (job.state === 'queued' || job.state === 'running') {
        if (abort.signal.aborted) return;
        setState({ phase: 'running', progress: job.progress ?? null });
        await sleep(POLL_MS, abort.signal);
        if (abort.signal.aborted) return;
        job = await fetchJob(job.id);
      }
      if (abort.signal.aborted) return;
      const mapped = job.state === 'succeeded' ? gridCalibration(job.result) : null;
      setState(
        mapped
          ? { phase: 'review', result: mapped.result, calibration: mapped.calibration }
          : { phase: 'failed', message: jobErrorText(job) },
      );
    } catch (error) {
      if (abort.signal.aborted) return;
      if (error instanceof ApiError && error.code === 'unknown_job_kind') {
        setState({ phase: 'unavailable' });
      } else {
        setState({ phase: 'failed', message: error instanceof Error ? error.message : null });
      }
    }
  }, [wallId, photoId]);

  const reset = useCallback(() => {
    controller.current?.abort();
    setState({ phase: 'idle' });
  }, []);

  const cancel = useCallback(() => {
    const id = jobId.current;
    reset();
    if (id !== null) cancelJob(id).catch(() => undefined);
  }, [reset]);

  return { state, start, cancel, reset } as const;
}
