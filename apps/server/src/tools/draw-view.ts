/**
 * "Draw a missing view of this draft object" (docs/draw.md, docs/vision.md "Multi-view"): the object's cut-out goes to a
 * draw backend, the drawing comes back as a `source: 'generated'` candidate and is kept next to the draft.
 *
 *   <draft dir>/drawn/<object key>/<subject id>/subject.png   the cut-out on white (what the backend gets as reference 1)
 *                                               /<view>.<ext>  an ACCEPTED drawing (quality gate passed)
 *                                               /views.json    every candidate of the subject (accepted or rejected) + its check
 *
 * The subject id is a hash of the cut-out's bytes: object keys (`<photo>:<sidecar id>`) are reused when a draft is analysed
 * again, so a drawing (and a manual upload job) must belong to the picture it was drawn from, never to a key.
 *
 * Drawings are hints, never ground truth: they carry `source: 'generated'`, are never attached to a wall or a tool as a
 * measurement, and the sidecar scores them next to (never inside) the held-out photo check (`generatedViews`).
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  DRAW_BACKEND_IDS,
  DRAW_VIEWS,
  type DrawBackendId,
  type DrawBackendStatus,
  type DrawCandidate,
  type DrawObjectSpec,
  type DrawView,
  type QualityReport,
} from '@hsw-editor/draw';
import type { JsonValue } from '@hsw-editor/core';
import { type DraftObject, getToolClass, hasToolClass } from '@hsw-editor/tools';
import { DraftError, type DraftDeps } from '@hsw-editor/tools/node';
import sharp from 'sharp';
import { z } from 'zod';
import { safeStem } from '../draw/image.ts';
import type { DrawRuntime } from '../draw/runtime.ts';
import { getBackendStatuses } from '../draw/status.ts';
import { generateViews } from '../draw/views.ts';
import type { JobContext } from '../jobs.ts';
import type { ServiceRequest, VisionClient } from '../vision/client.ts';

export const TOOLS_DRAW_VIEW_JOB = 'tools.draw_view';
/** The two views a top-down photo does not have: the end (`side`) and the profile along the length (`top`). */
export const DEFAULT_DRAW_VIEWS: readonly DrawView[] = ['side', 'top'];

export const DrawViewBodySchema = z.strictObject({
  views: z.array(z.enum(DRAW_VIEWS)).min(1).max(DRAW_VIEWS.length).optional(),
  backend: z.enum(DRAW_BACKEND_IDS).optional(),
});

/** The job input: the route's body with the view list resolved, plus which object. */
export const DrawViewInputSchema = DrawViewBodySchema.extend({
  draftId: z.string(),
  key: z.string(),
  views: z.array(z.enum(DRAW_VIEWS)).min(1).max(DRAW_VIEWS.length),
});
export type DrawViewInput = z.infer<typeof DrawViewInputSchema>;

/** How a drawing scored against the sidecar's fit of the object. A hint: `flag` means "does not look like the fit". */
export type DrawnViewCheck =
  | {
      readonly state: 'checked';
      readonly source: 'generated';
      readonly iou: number | null;
      readonly flag: boolean;
      readonly usable: boolean;
      readonly azimuthDeg: number;
      readonly elevationDeg: number;
    }
  | { readonly state: 'unavailable'; readonly reason: string };

/** One drawing of an object, exactly as the API reports it. */
export interface DrawnView {
  readonly source: 'generated';
  readonly view: DrawView;
  readonly backend: DrawBackendId;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly mime: string;
  readonly promptTemplateVersion: number;
  readonly accepted: boolean;
  readonly quality: QualityReport;
  /** Relative to the draft directory; null when the quality gate rejected the drawing. */
  readonly file: string | null;
  readonly check: DrawnViewCheck | null;
  readonly drawnAt: string;
}

export type DrawViewResult =
  | { readonly status: 'done'; readonly views: readonly DrawnView[] }
  | {
      readonly status: 'manual_pending';
      readonly views: readonly DrawnView[];
      readonly view: DrawView;
      /** Upload the image with `POST /api/draw/manual/<manualJobId>/inbox`, then run the same request again. */
      readonly manual: {
        readonly jobId: string;
        readonly prompt: string;
        readonly refCount: number;
      };
      readonly automation: readonly DrawBackendStatus[];
    }
  | {
      readonly status: 'failed';
      readonly views: readonly DrawnView[];
      readonly view: DrawView;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryAfterMs?: number;
      };
      readonly automation: readonly DrawBackendStatus[];
    };

/** The JSON a job result carries: the value round-tripped through `JSON` (drops `undefined`) and proven JSON by the parse. */
export function toJson(value: unknown): JsonValue {
  return z.json().parse(JSON.parse(JSON.stringify(value)));
}

/** Scores drawings against the fit the sidecar made of the object; one entry per drawing (`unavailable` with the reason). */
export type DrawnViewChecker = (
  fit: Record<string, JsonValue>,
  drawn: readonly { readonly view: DrawView; readonly path: string }[],
  signal: AbortSignal,
) => Promise<readonly DrawnViewCheck[]>;

const GeneratedRowSchema = z.looseObject({
  iou: z.number().nullable(),
  flag: z.boolean(),
  usable: z.boolean(),
  azimuth_deg: z.number(),
  elevation_deg: z.number(),
});
const MultiviewResponseSchema = z.looseObject({ generatedViews: z.array(GeneratedRowSchema) });

/** The checker that asks the managed vision sidecar (`POST /multiview`). It starts the sidecar on demand. */
export function sidecarChecker(client: VisionClient): DrawnViewChecker {
  return async (fit, drawn, signal) => {
    const unavailable = (reason: string): readonly DrawnViewCheck[] =>
      drawn.map(() => ({ state: 'unavailable', reason }));
    try {
      const request: ServiceRequest = {
        fit,
        generated_views: drawn.map((d) => ({ image_path: d.path, view: d.view })),
      };
      const response = MultiviewResponseSchema.parse(
        await client.post('/multiview', request, signal),
      );
      if (response.generatedViews.length !== drawn.length) {
        return unavailable(
          'the vision service scored a different number of drawings than were sent',
        );
      }
      return response.generatedViews.map((row): DrawnViewCheck => ({
        state: 'checked',
        source: 'generated',
        iou: row.iou,
        flag: row.flag,
        usable: row.usable,
        azimuthDeg: row.azimuth_deg,
        elevationDeg: row.elevation_deg,
      }));
    } catch (error) {
      if (signal.aborted) throw error;
      return unavailable(`the vision service could not score the drawing: ${String(error)}`);
    }
  };
}

/** The parsed JSON of a file we wrote ourselves or the sidecar did; null when it is missing or unreadable (never a thrown 500). */
async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write-then-rename: a reader (the GET route, a second run) never sees half a file. */
async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const partial = `${path}.part`;
  await Bun.write(partial, data);
  await rename(partial, path);
}

const SidecarObjectsSchema = z.looseObject({
  objects: z.array(
    z.looseObject({ id: z.number(), fit: z.record(z.string(), z.json()).nullable().optional() }),
  ),
});

/** The library fit the sidecar stored for the object (`vision/<photo>/objects.json`), or null (no scale, fit failed, edited away). */
async function sidecarFit(
  deps: DraftDeps,
  draftId: string,
  photo: number,
  objectId: number,
): Promise<Record<string, JsonValue> | null> {
  const file = join(deps.drafts.dir(draftId), 'vision', String(photo), 'objects.json');
  const parsed = SidecarObjectsSchema.safeParse(await readJsonFile(file));
  if (!parsed.success) return null;
  return parsed.data.objects.find((o) => o.id === objectId)?.fit ?? null;
}

function objectSpec(obj: DraftObject): DrawObjectSpec {
  const className =
    obj.classId !== null && hasToolClass(obj.classId)
      ? getToolClass(obj.classId).name.en
      : undefined;
  const name = obj.name.en ?? className ?? 'tool';
  const dims = obj.dimensionsMm;
  const user = obj.userDimensions;
  // The subject reference is the UPRIGHT cut-out: length runs along the image's width, the profile width along its height.
  const length = user?.length ?? dims?.length;
  const width = user?.width ?? dims?.width;
  const thickness = user?.thickness ?? dims?.thickness;
  return {
    name,
    // The view convention the sidecar scores against (`GENERATED_VIEW_ANGLES` in hsw_vision/stages/multiview.py).
    description:
      'a hand tool. The reference image is its FRONT view with the long axis horizontal; SIDE is the view from its right end, TOP the view from above (its profile along the length)',
    ...(length !== undefined && width !== undefined && thickness !== undefined
      ? {
          dimsMm: {
            width: Math.round(length),
            height: Math.round(width),
            depth: Math.round(thickness),
          },
        }
      : {}),
  };
}

/** The cut-out composited on white: the reference every backend gets as `subject`. Deterministic bytes (manual jobs key on the path). */
async function writeSubject(source: string, target: string): Promise<void> {
  const bytes = await sharp(source)
    .flatten({ background: '#ffffff' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFileAtomic(target, bytes);
}

function publicView(
  candidate: DrawCandidate,
  file: string | null,
  check: DrawnViewCheck | null,
  now: Date,
): DrawnView {
  return {
    source: 'generated',
    view: candidate.view,
    backend: candidate.backend,
    sha256: candidate.sha256,
    width: candidate.width,
    height: candidate.height,
    mime: candidate.mime,
    promptTemplateVersion: candidate.promptTemplateVersion,
    accepted: candidate.accepted,
    quality: candidate.quality,
    file,
    check,
    drawnAt: now.toISOString(),
  };
}

/** What `views.json` holds per view; the rest of a stored entry is passed through as written. */
const StoredViewSchema = z.looseObject({ file: z.string().nullable(), accepted: z.boolean() });
const ViewsFileSchema = z.looseObject({ views: z.record(z.string(), StoredViewSchema) });

/** The object a draw request is about, with the files that belong to its CURRENT picture. */
interface Subject {
  readonly obj: DraftObject;
  /** Absolute path of the object's cut-out. */
  readonly cutout: string;
  /** `drawn/<key>/<subject id>`: relative to the draft directory. */
  readonly relDir: string;
  readonly dir: string;
}

async function findObject(deps: DraftDeps, draftId: string, key: string): Promise<DraftObject> {
  const draft = await deps.drafts.get(draftId);
  const obj = draft.objects.find((o) => o.key === key);
  if (!obj) throw new DraftError('not_found', `no object ${key} in draft ${draftId}`);
  return obj;
}

/** The subject of an object whose cut-out exists; its id changes with the picture, so a re-analysis starts clean. */
async function subjectOf(deps: DraftDeps, draftId: string, obj: DraftObject): Promise<Subject> {
  if (!obj.images.cutout) {
    throw new DraftError('invalid', `object ${obj.key} has no cut-out to draw from`);
  }
  const cutout = join(deps.drafts.dir(draftId), obj.images.cutout);
  const bytes = await readFile(cutout).catch(() => null);
  if (bytes === null)
    throw new DraftError('invalid', `object ${obj.key} has no cut-out to draw from`);
  const subjectId = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const relDir = join('drawn', safeStem(obj.key, 'object'), subjectId);
  return { obj, cutout, relDir, dir: join(deps.drafts.dir(draftId), relDir) };
}

/** Every drawing kept for the object's current picture (newest per view, accepted or rejected). */
export async function readDrawnViews(
  deps: DraftDeps,
  draftId: string,
  key: string,
): Promise<JsonValue[]> {
  const obj = await findObject(deps, draftId, key);
  if (!obj.images.cutout) return [];
  const subject = await subjectOf(deps, draftId, obj).catch(() => null);
  if (subject === null) return [];
  const parsed = ViewsFileSchema.safeParse(await readJsonFile(join(subject.dir, 'views.json')));
  return parsed.success ? Object.values(parsed.data.views).map((view) => toJson(view)) : [];
}

/** Absolute path of an accepted drawing of the object's current picture (`<view>.<ext>`); only names listed in `views.json`. */
export async function drawnFile(
  deps: DraftDeps,
  draftId: string,
  key: string,
  name: string,
): Promise<string> {
  const obj = await findObject(deps, draftId, key);
  const subject = await subjectOf(deps, draftId, obj).catch(() => null);
  const parsed = subject
    ? ViewsFileSchema.safeParse(await readJsonFile(join(subject.dir, 'views.json')))
    : null;
  const listed =
    subject !== null &&
    parsed?.success === true &&
    Object.values(parsed.data.views).some((v) => v.file === join(subject.relDir, name));
  if (subject === null || !listed) {
    throw new DraftError('not_found', `no drawing ${name} of object ${key} in draft ${draftId}`);
  }
  return join(subject.dir, name);
}

/** What the route validates BEFORE a job is queued (so a bad request is a 4xx, not a failed job). */
export async function prepareDrawView(
  deps: DraftDeps,
  draftId: string,
  key: string,
): Promise<Subject> {
  const obj = await findObject(deps, draftId, key);
  if (obj.status === 'discarded' || obj.status === 'added') {
    throw new DraftError('conflict', `object ${key} is ${obj.status}: nothing to draw`);
  }
  return subjectOf(deps, draftId, obj);
}

export interface DrawViewDeps {
  readonly drafts: DraftDeps;
  readonly runtime: DrawRuntime;
  readonly check: DrawnViewChecker;
  readonly now?: () => Date;
}

/** The backends that are not usable right now (login wall, quota, challenge, missing binary) with their literal one-time steps. */
async function unusableBackends(runtime: DrawRuntime): Promise<DrawBackendStatus[]> {
  const statuses = await getBackendStatuses(runtime, { probe: false });
  return statuses.filter((s) => s.id !== 'manual' && s.state !== 'ready');
}

/** How a drawing scores against the object's fit: `unavailable` (with the reason) when there is no fit to score against. */
async function checkDrawn(
  deps: DrawViewDeps,
  fit: Record<string, JsonValue> | null,
  candidate: DrawCandidate,
  signal: AbortSignal,
): Promise<DrawnViewCheck> {
  if (fit === null) {
    return {
      state: 'unavailable',
      reason: 'the object has no fit from the vision service (no scale, or the fit failed)',
    };
  }
  const [check] = await deps.check(fit, [{ view: candidate.view, path: candidate.path }], signal);
  return check ?? { state: 'unavailable', reason: 'the vision service returned no score' };
}

export async function runDrawView(
  deps: DrawViewDeps,
  input: DrawViewInput,
  ctx: Pick<JobContext, 'signal' | 'progress' | 'log'>,
): Promise<DrawViewResult> {
  const now = deps.now ?? (() => new Date());
  const { drafts, runtime } = deps;
  const subject = await prepareDrawView(drafts, input.draftId, input.key);
  const { obj, relDir, dir } = subject;
  await mkdir(dir, { recursive: true });
  const subjectFile = join(dir, 'subject.png');
  await writeSubject(subject.cutout, subjectFile);
  const draftDir = drafts.drafts.dir(input.draftId);

  const fit = await sidecarFit(drafts, input.draftId, obj.photo, obj.objectId);
  const kept: DrawnView[] = [];
  const outcome = await generateViews(
    runtime,
    {
      // the subject id is in the tag: a manual upload job belongs to the picture it was asked for
      tag: `${input.draftId}/${input.key}/${relDir.split('/').at(-1)}`,
      object: objectSpec(obj),
      views: input.views,
      subjectPaths: [subjectFile],
      ...(input.backend === undefined ? {} : { backend: input.backend }),
    },
    {
      signal: ctx.signal,
      progress: (done, total, message) => ctx.progress({ done, total, message }),
      log: (message) => ctx.log(message),
      attach: async (candidate) => {
        const file = join(relDir, `${candidate.view}${extname(candidate.path)}`);
        await copyFile(candidate.path, join(draftDir, file));
        const check = await checkDrawn(deps, fit, candidate, ctx.signal);
        const view = publicView(candidate, file, check, now());
        kept.push(view);
        // recorded the moment it is kept: a later view that fails or throws must not hide a drawing that cost a request
        await recordViews(dir, [view]);
      },
    },
  );
  // Rejected drawings are reported (with the gate's reasons) but not attached to anything.
  const rejected = outcome.candidates
    .filter((c) => !c.accepted)
    .map((c) => publicView(c, null, null, now()));
  await recordViews(dir, rejected);
  const views = [...kept, ...rejected];

  if (outcome.status === 'done') return { status: 'done', views };
  const automation = await unusableBackends(runtime);
  if (outcome.status === 'manual_pending') {
    return {
      status: 'manual_pending',
      views,
      view: outcome.view,
      manual: {
        jobId: outcome.manualJobId,
        prompt: outcome.prompt,
        refCount: outcome.refPaths.length,
      },
      automation,
    };
  }
  return {
    status: 'failed',
    views,
    view: outcome.view,
    error: {
      code: outcome.code,
      message: outcome.message,
      ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
    },
    automation,
  };
}

/**
 * Merge drawings into `views.json` (one entry per view, the newest wins). A rejected drawing never replaces an accepted one
 * of the same view: a bad retry must not erase a good drawing.
 */
async function recordViews(dir: string, views: readonly DrawnView[]): Promise<void> {
  if (views.length === 0) return;
  const file = join(dir, 'views.json');
  const parsed = ViewsFileSchema.safeParse(await readJsonFile(file));
  const stored: Record<string, JsonValue> = parsed.success
    ? Object.fromEntries(Object.entries(parsed.data.views).map(([view, v]) => [view, toJson(v)]))
    : {};
  const previous = parsed.success ? parsed.data.views : {};
  for (const view of views) {
    if (!view.accepted && previous[view.view]?.accepted === true) continue;
    stored[view.view] = toJson(view);
  }
  await writeFileAtomic(file, `${JSON.stringify({ version: 1, views: stored }, null, 1)}\n`);
}

/** A pinned backend that is not usable is refused up front with its literal steps; `auto` falls through to `manual` instead. */
export async function pinnedBackendProblem(
  runtime: DrawRuntime,
  requested: DrawBackendId | undefined,
): Promise<DrawBackendStatus | null> {
  const choice = requested ?? (await runtime.getSettings()).backend;
  if (choice === 'auto' || choice === 'manual') return null;
  const statuses = await getBackendStatuses(runtime, { probe: false });
  const status = statuses.find((s) => s.id === choice);
  return status && status.state !== 'ready' ? status : null;
}
