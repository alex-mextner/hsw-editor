/**
 * Typed client of the user-element routes (`/api/bank/user/*`, job `bank.user.import`, contract in
 * `packages/bank/src/user.ts`). Every response is parsed with the shared zod schemas; failures surface as the
 * `ApiError` / `NetworkError` of `api/http.ts`.
 */
import { z } from 'zod';
import {
  BankElementSchema,
  ConversionSchema,
  UploadSchema,
  UserImportInputSchema,
  USER_IMPORT_JOB,
  userRoutes,
  type Conversion,
  type ConvertSettings,
  type BankElement,
  type Upload,
  type UserImportInput,
  type UserPatch,
} from '@hsw-editor/bank';
import { ApiError, fetchJson } from '@/api/http.ts';
import { postJson } from '@/api/requests.ts';
import { fetchJob, jobErrorText, type Job, type JobProgress } from '@/widgets/calibrationJob.ts';

const OkSchema = z.object({ ok: z.literal(true) });
const JobStartSchema = z.object({ job: z.object({ id: z.string().min(1) }).loose() });
const ReopenSchema = z.object({ upload: UploadSchema, input: UserImportInputSchema });
const ImportResultSchema = z.object({ element: BankElementSchema }).loose();

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export async function uploadMesh(file: File, signal?: AbortSignal): Promise<Upload> {
  const form = new FormData();
  form.set('file', file);
  const json = await fetchJson(userRoutes.uploads, {
    method: 'POST',
    body: form,
    ...(signal ? { signal } : {}),
  });
  return z.object({ upload: UploadSchema }).parse(json).upload;
}

/** Runs the mesh tool with `settings` (1-5 s); the result carries the preview GLB URL and the detected cells. */
export async function previewUpload(
  uploadId: string,
  settings: ConvertSettings,
  signal?: AbortSignal,
): Promise<Conversion> {
  const json = await fetchJson(userRoutes.preview(uploadId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(settings),
    ...(signal ? { signal } : {}),
  });
  return z.object({ conversion: ConversionSchema }).parse(json).conversion;
}

export async function deleteUpload(uploadId: string): Promise<void> {
  OkSchema.parse(await fetchJson(userRoutes.upload(uploadId), { method: 'DELETE' }));
}

/** Copies the stored original of a user element into a new upload and returns its metadata as an import input. */
export async function reopenElement(
  elementId: string,
): Promise<{ upload: Upload; input: UserImportInput }> {
  return ReopenSchema.parse(await fetchJson(userRoutes.reopen(elementId), { method: 'POST' }));
}

export async function patchElement(elementId: string, patch: UserPatch): Promise<BankElement> {
  const json = await fetchJson(userRoutes.element(elementId), {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  return z.object({ element: BankElementSchema }).parse(json).element;
}

export async function deleteElement(elementId: string, force: boolean): Promise<void> {
  const path = `${userRoutes.element(elementId)}${force ? '?force=1' : ''}`;
  OkSchema.parse(await fetchJson(path, { method: 'DELETE' }));
}

const InUseDetailsSchema = z.object({
  error: z.object({
    details: z.object({
      walls: z.array(
        z.object({ wallId: z.string(), items: z.union([z.number(), z.array(z.unknown())]) }),
      ),
    }),
  }),
});

export interface WallUsage {
  readonly wallId: string;
  readonly items: number;
}

/** The walls that still use an element, when `error` is the 409 `element_in_use` of a delete. */
export function elementInUseWalls(error: unknown): readonly WallUsage[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.code !== 'element_in_use') {
    return null;
  }
  const parsed = InUseDetailsSchema.safeParse(error.body);
  if (!parsed.success) return [];
  return parsed.data.error.details.walls.map((wall) => ({
    wallId: wall.wallId,
    items: typeof wall.items === 'number' ? wall.items : wall.items.length,
  }));
}

export async function startImportJob(input: UserImportInput): Promise<string> {
  const json = await postJson('/api/jobs', { kind: USER_IMPORT_JOB, input });
  return JobStartSchema.parse(json).job.id;
}

export type ImportJobOutcome =
  | { readonly status: 'succeeded'; readonly element: BankElement }
  | { readonly status: 'failed'; readonly message: string | null }
  | { readonly status: 'cancelled' };

const POLL_MS = 500;

function wait(ms: number, signal: AbortSignal): Promise<void> {
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
 * Polls the import job every 500 ms until it ends, reporting `progress.message` (`converting`, `compressing`,
 * `publishing`). A transient network failure while polling is retried: the job lives in the daemon, not here.
 * Resolves `cancelled` when `signal` aborts (the job keeps running server-side).
 */
export async function followImportJob(
  jobId: string,
  onProgress: (progress: JobProgress | undefined) => void,
  signal: AbortSignal,
): Promise<ImportJobOutcome> {
  while (!signal.aborted) {
    let job: Job | null = null;
    try {
      job = await fetchJob(jobId);
    } catch (error) {
      // An API refusal (404 job gone, ...) is final; only a dead connection is worth another try.
      if (error instanceof ApiError) throw error;
    }
    if (job !== null) {
      onProgress(job.progress);
      if (job.state === 'succeeded') {
        const parsed = ImportResultSchema.safeParse(job.result);
        if (parsed.success) return { status: 'succeeded', element: parsed.data.element };
        return { status: 'failed', message: null };
      }
      if (job.state === 'failed') return { status: 'failed', message: jobErrorText(job) };
      if (job.state === 'cancelled') return { status: 'cancelled' };
    }
    await wait(POLL_MS, signal);
  }
  return { status: 'cancelled' };
}
