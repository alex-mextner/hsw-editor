/**
 * Cleaning the photographed wall under the board, automatically. As soon as the shown photo is calibrated the server
 * job `photo.clean` makes a cleaned variant (a basic local fill at once, the draw backend's edit when one is signed
 * in); when the board footprint moves materially it runs again, debounced. Switched by the persisted setting
 * `autoCleanBackground` (default on). The original photo is never replaced.
 */
import {
  boardExtent,
  boardFootprintPx,
  footprintDrift,
  footprintSignature,
  materialDrift,
  photoMapFromCalibration,
} from '@hsw-editor/overlay';
import { createValueStore } from '#state-backend';
import type { Wall } from '@hsw-editor/core';
import { ApiError } from '@/api/http.ts';
import { postJson } from '@/api/requests.ts';
import { createPersistedStore } from '@/state/persisted.ts';
import { fetchJob, jobErrorText } from '@/widgets/calibrationJob.ts';
import { z } from 'zod';

export const CLEAN_JOB_KIND = 'photo.clean';
const POLL_MS = 700;
/** Wait after the last footprint change before cleaning, so dragging the board does not start a job per frame. */
export const CLEAN_DEBOUNCE_MS = 1500;

/** Setting: clean the background under the board automatically. */
export const autoCleanStore = createPersistedStore<boolean>(
  'hsw.photo.autoClean',
  true,
  (raw) => (raw === 'true' ? true : raw === 'false' ? false : null),
  (value) => String(value),
);

/** What the AI step of the last run came to (`server: photo-clean/job.ts` AiState). */
export type AiState =
  | 'done'
  | 'not-asked'
  | 'login_required'
  | 'quota_exhausted'
  | 'unavailable'
  | 'rejected'
  | 'failed'
  | 'disabled';

export type CleanState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly photoId: string; readonly stage: string | null }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'failed'; readonly photoId: string; readonly message: string | null }
  | {
      readonly phase: 'done';
      readonly photoId: string;
      readonly method: 'basic' | 'ai' | null;
      readonly ai: AiState;
      readonly aiMessage: string | null;
    };

export const cleanStore = createValueStore<CleanState>({ phase: 'idle' });

/** The footprints the AI step has already been asked about on this browser: the AI is asked once per footprint. */
const askedStore = createPersistedStore<Readonly<Record<string, string>>>(
  'hsw.photo.cleanAsked',
  {},
  (raw) => {
    const parsed = z.record(z.string(), z.string()).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  },
  (value) => JSON.stringify(value),
);

const ResultSchema = z.object({
  status: z.string(),
  variantId: z.string().nullable(),
  method: z.enum(['basic', 'ai']).nullable(),
  ai: z.string(),
  aiMessage: z.string().optional(),
});

const AI_STATES: readonly AiState[] = [
  'done',
  'not-asked',
  'login_required',
  'quota_exhausted',
  'unavailable',
  'rejected',
  'failed',
  'disabled',
];

function aiStateOf(value: string): AiState {
  return AI_STATES.find((state) => state === value) ?? 'failed';
}

export interface CleanPlan {
  /** The footprint of the board on the photo as stored with the variant. */
  readonly signature: string;
  /** No variant yet, or the footprint moved materially: make one. */
  readonly needsClean: boolean;
  /** A basic variant is current and the AI was never asked about this footprint: upgrade it. */
  readonly needsUpgrade: boolean;
}

/** What the editor should do for `photoId` of `wall`; null when the photo cannot be cleaned (no calibration, off plane). */
export function planClean(wall: Wall, photoId: string): CleanPlan | null {
  const original = wall.photos.find((photo) => photo.id === photoId && photo.cleanOf === undefined);
  if (original?.calibration === undefined) return null;
  const image = { width: original.width, height: original.height };
  const extent = boardExtent(wall.board);
  const map = photoMapFromCalibration(original.calibration, image, extent);
  const polygon = map === null ? null : boardFootprintPx(map, extent);
  if (polygon === null) return null;
  const signature = footprintSignature(polygon, image);
  const variant = wall.photos.find((photo) => photo.cleanOf === original.id);
  const current =
    variant !== undefined &&
    footprintDrift(variant.cleanFootprint ?? '', polygon, image) <= materialDrift(image);
  // A footprint the editor has already acted on is not acted on again by itself: undoing the clean (or a failed
  // run) must not bring it straight back. A moved board is a new footprint; the command makes it again on request.
  const acted = askedStore.get()[original.id] === signature;
  return {
    signature,
    needsClean: !current && !acted,
    needsUpgrade: current && variant.backend === 'basic' && !acted,
  };
}

/** Marks the AI as asked about `signature` of the photo (the next automatic run does not ask again). */
function rememberAsked(photoId: string, signature: string): void {
  askedStore.set({ ...askedStore.get(), [photoId]: signature });
}

/** Forgets that the AI was asked: the next run asks again (after the user signed in). */
export function forgetAsked(photoId: string): void {
  const { [photoId]: _dropped, ...rest } = askedStore.get();
  askedStore.set(rest);
}

/** Runs the clean job and follows it. `refresh` makes the variant again even when the footprint has not moved. */
export async function runClean(
  wallId: string,
  photoId: string,
  signature: string,
  options: { readonly refresh?: boolean } = {},
): Promise<void> {
  if (cleanStore.get().phase === 'running') return;
  cleanStore.set({ phase: 'running', photoId, stage: null });
  // The model is asked at most once per footprint, whatever it answers: no loop of failing logins.
  rememberAsked(photoId, signature);
  try {
    const started = z.object({ job: z.object({ id: z.string().min(1) }).loose() }).parse(
      await postJson('/api/jobs', {
        kind: CLEAN_JOB_KIND,
        input: { wallId, photoId, method: 'auto', refresh: options.refresh === true },
        wallId,
      }),
    ).job;
    let job = await fetchJob(started.id);
    while (job.state === 'queued' || job.state === 'running') {
      cleanStore.set({ phase: 'running', photoId, stage: job.progress?.message ?? null });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      job = await fetchJob(job.id);
    }
    if (job.state !== 'succeeded') {
      cleanStore.set({ phase: 'failed', photoId, message: jobErrorText(job) });
      return;
    }
    const result = ResultSchema.safeParse(job.result);
    cleanStore.set(
      result.success
        ? {
            phase: 'done',
            photoId,
            method: result.data.method,
            ai: aiStateOf(result.data.ai),
            aiMessage: result.data.aiMessage ?? null,
          }
        : { phase: 'failed', photoId, message: null },
    );
  } catch (error) {
    cleanStore.set(
      error instanceof ApiError && error.code === 'unknown_job_kind'
        ? { phase: 'unavailable' }
        : { phase: 'failed', photoId, message: error instanceof Error ? error.message : null },
    );
  }
}

export function resetClean(): void {
  cleanStore.set({ phase: 'idle' });
}
