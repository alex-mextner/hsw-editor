/**
 * "Find tools": asks the vision service to look for tools in the wall photo (job `vision.photo_to_objects`) and
 * follows the job. The service is optional: a daemon without the job answers `unknown_job_kind` and the button says
 * so instead of failing. Proposed items arrive through the normal wall events.
 */
import { createValueStore } from '#state-backend';
import { ApiError } from '@/api/http.ts';
import { postJson } from '@/api/requests.ts';
import { fetchJob, jobErrorText, type Job } from '@/widgets/calibrationJob.ts';
import { z } from 'zod';

export const FIND_TOOLS_JOB_KIND = 'vision.photo_to_objects';
const POLL_MS = 800;

export type FindToolsState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly message: string | null }
  | { readonly phase: 'unavailable' }
  | { readonly phase: 'failed'; readonly message: string | null }
  | { readonly phase: 'done' };

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
  try {
    const started = JobEnvelopeSchema.parse(
      z.object({ job: z.unknown() }).parse(
        await postJson('/api/jobs', {
          kind: FIND_TOOLS_JOB_KIND,
          input: { wallId, photoId },
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
    findToolsStore.set(
      job.state === 'succeeded'
        ? { phase: 'done' }
        : { phase: 'failed', message: jobErrorText(job) },
    );
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
