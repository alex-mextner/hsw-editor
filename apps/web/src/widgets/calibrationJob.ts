/** `calibrate-grid` job: API calls and the mapping from a job result to a photo calibration. */
import { CalibrationSchema, type Calibration } from '@hsw-editor/core';
import { z } from 'zod';
import { fetchJson } from '@/api/http.ts';
import { postJson } from '@/api/requests.ts';

export const GRID_JOB_KIND = 'calibrate-grid';

const ProgressSchema = z.object({
  done: z.number().optional(),
  total: z.number().optional(),
  fraction: z.number().min(0).max(1).optional(),
  message: z.string().optional(),
});
export type JobProgress = z.infer<typeof ProgressSchema>;

const JobSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  progress: ProgressSchema.optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
export type Job = z.infer<typeof JobSchema>;

const JobEnvelopeSchema = z.object({ job: JobSchema });
const ErrorTextSchema = z.union([z.string(), z.object({ message: z.string() })]);

/** Detector output: the calibration fields it fitted, as defined by the core schema. */
export const GridResultSchema = z.object({
  mmPerPx: CalibrationSchema.shape.mmPerPx,
  homography: CalibrationSchema.shape.homography,
  focalPx: CalibrationSchema.shape.focalPx,
  reprojErrorPx: CalibrationSchema.shape.reprojErrorPx,
  points: CalibrationSchema.shape.points,
});
export type GridResult = z.infer<typeof GridResultSchema>;

export async function startGridJob(wallId: string, photoId: string): Promise<Job> {
  const json = await postJson('/api/jobs', {
    kind: GRID_JOB_KIND,
    input: { wallId, photoId },
    wallId,
  });
  return JobEnvelopeSchema.parse(json).job;
}

export async function fetchJob(jobId: string): Promise<Job> {
  return JobEnvelopeSchema.parse(await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`)).job;
}

export async function cancelJob(jobId: string): Promise<void> {
  await postJson(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
}

/** Server-side failure text of a job, when it gave one. */
export function jobErrorText(job: Job): string | null {
  const parsed = ErrorTextSchema.safeParse(job.error);
  if (!parsed.success) return null;
  return typeof parsed.data === 'string' ? parsed.data : parsed.data.message;
}

/** `null` when the result has no scale (neither `mmPerPx` nor a homography): nothing to apply. */
export function gridCalibration(
  result: unknown,
): { result: GridResult; calibration: Calibration } | null {
  const parsed = GridResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const fields = parsed.data;
  if (fields.mmPerPx === undefined && fields.homography === undefined) return null;
  const calibration = CalibrationSchema.safeParse({
    method: 'grid',
    ...(fields.mmPerPx === undefined ? {} : { mmPerPx: fields.mmPerPx }),
    ...(fields.homography === undefined ? {} : { homography: fields.homography }),
    ...(fields.focalPx === undefined ? {} : { focalPx: fields.focalPx }),
    ...(fields.reprojErrorPx === undefined ? {} : { reprojErrorPx: fields.reprojErrorPx }),
    ...(fields.points === undefined ? {} : { points: fields.points }),
  });
  return calibration.success ? { result: fields, calibration: calibration.data } : null;
}
