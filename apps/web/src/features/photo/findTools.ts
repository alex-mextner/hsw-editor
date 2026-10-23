/**
 * "Find tools": asks the vision service to look for tools in the wall photo (job `vision.photo_to_objects`),
 * follows the job and keeps what it found as ghosts over the photo (`visionGhosts.ts`) for the user to accept or
 * discard. The service is optional: a daemon without the job answers `unknown_job_kind` and the button says so
 * instead of failing.
 */
import { createValueStore } from '#state-backend';
import { ApiError } from '@/api/http.ts';
import { postJson } from '@/api/requests.ts';
import { t } from '@/i18n/index.ts';
import { photoStore } from '@/state/photo.ts';
import { sessionStore } from '@/wall/session.ts';
import { fetchJob, jobErrorText, type Job } from '@/widgets/calibrationJob.ts';
import { z } from 'zod';
import { discardAllGhosts, parseToolGhosts, scaleGhosts, setGhosts } from './visionGhosts.ts';

export const FIND_TOOLS_JOB_KIND = 'vision.photo_to_objects';
const POLL_MS = 800;

export type FindToolsState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly message: string | null }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'failed'; readonly message: string | null }
  /** `found` ghosts were drawn; `unrecognised` objects were seen but could not be named. */
  | { readonly phase: 'done'; readonly found: number; readonly unrecognised: number };

export const findToolsStore = createValueStore<FindToolsState>({ phase: 'idle' });

const JobEnvelopeSchema = z.object({ id: z.string().min(1) }).loose();

export function isUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'unknown_job_kind';
}

function messageOf(job: Job): string | null {
  return job.progress?.message ?? null;
}

export async function runFindTools(wallId: string, photoId: string): Promise<void> {
  if (findToolsStore.get().phase === 'running') return;
  findToolsStore.set({ phase: 'running', message: null });
  // A new search replaces the proposals of the last one, also when it fails.
  discardAllGhosts();
  try {
    const started = JobEnvelopeSchema.parse(
      z.object({ job: z.unknown() }).parse(
        await postJson('/api/jobs', {
          kind: FIND_TOOLS_JOB_KIND,
          // The bank's tool classes are the vocabulary, so a recognised class is one a holder can be found for.
          input: { wallId, photoId, useBank: true },
          wallId,
        }),
      ).job,
    );
    let job = await fetchJob(started.id);
    while (job.state === 'queued' || job.state === 'running') {
      findToolsStore.set({ phase: 'running', message: messageOf(job) });
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      job = await fetchJob(job.id);
    }
    // The user moved to another photo while the search ran: its ghosts, and its failure, belong nowhere now.
    if (photoStore.get().photoId !== photoId) {
      findToolsStore.set({ phase: 'idle' });
      return;
    }
    if (job.state !== 'succeeded') {
      findToolsStore.set({ phase: 'failed', message: jobErrorText(job) });
      return;
    }
    const parsed = parseToolGhosts(job.result);
    if (parsed === null) {
      findToolsStore.set({ phase: 'failed', message: t('photo.findTools.badResult') });
      return;
    }
    // The sidecar works on the stored photo, but the coordinates are only right for the size it saw: bring them
    // to the size the viewport draws, and refuse a result for a differently shaped image.
    const stored = sessionStore.get()?.wall?.photos.find((entry) => entry.id === photoId);
    const ghosts = stored
      ? scaleGhosts(parsed.ghosts, parsed.image, { width: stored.width, height: stored.height })
      : parsed.ghosts;
    if (ghosts === null) {
      findToolsStore.set({ phase: 'failed', message: t('photo.findTools.badResult') });
      return;
    }
    setGhosts(photoId, ghosts);
    findToolsStore.set({ phase: 'done', found: ghosts.length, unrecognised: parsed.unrecognised });
  } catch (error) {
    findToolsStore.set(
      isUnavailable(error)
        ? { phase: 'unavailable' }
        : { phase: 'failed', message: error instanceof Error ? error.message : null },
    );
  }
}

export function resetFindTools(): void {
  findToolsStore.set({ phase: 'idle' });
}
