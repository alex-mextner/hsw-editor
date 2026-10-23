/** Core REST/SSE routes: walls, ops, undo/redo, assets, events and jobs. Contract: docs/api.md. */
import { basename, join } from 'node:path';
import {
  type ApiErrorBody,
  DEFAULT_BOARD,
  type ApplyResponse,
  type Actor,
  ActorSchema,
  AnswerRequestBodySchema,
  CancelRequestBodySchema,
  CreateRequestBodySchema,
  CreateWallBodySchema,
  type JsonValue,
  type ModelUploadResponse,
  ModelRefSchema,
  OpError,
  OpsBodySchema,
  type PhotoUploadResponse,
  PhotoSchema,
  type RevConflictBody,
  REQUEST_STATUSES,
  UndoBodySchema,
  type WallExport,
  type WallResponse,
  WallParseError,
  formatIssues,
} from '@hsw-editor/core';
import { SettingsContractError, type SettingsRevConflictBody } from '@hsw-editor/user-settings';
import type { z } from 'zod';
import { HttpError } from './http-error.ts';
import { SERVER_VERSION } from './version.ts';
import { isGlb, sniffImage } from './image.ts';
import { JobError } from './jobs.ts';
import { NormalizeError, normalizePhoto, type NormalizeErrorCode } from './photo/normalize.ts';
import type { ServerDeps } from './modules.ts';
import { SettingsConflictError } from './settings.ts';
import { settingsRoutes } from './settings-routes.ts';
import { sseResponse } from './sse.ts';
import { StoreError, type Outcome, type StoreErrorCode } from './store/wall-store.ts';

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
const MAX_MODEL_BYTES = 100 * 1024 * 1024;
const HUMAN: Actor = { kind: 'human' };

const STORE_STATUS: Record<StoreErrorCode, number> = {
  wall_not_found: 404,
  asset_not_found: 404,
  invalid_id: 400,
  wall_exists: 409,
  rev_conflict: 409,
  nothing_to_undo: 409,
  nothing_to_redo: 409,
  undo_conflict: 409,
  redo_conflict: 409,
  corrupt: 500,
  request_not_found: 404,
  request_closed: 409,
  invalid_request: 422,
  locked: 500,
};

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(errorBody(error.code, error.message, error.details), {
      status: error.status,
    });
  }
  if (error instanceof SettingsContractError) {
    const status = error.code === 'payload_too_large' ? 413 : 400;
    return Response.json(
      errorBody(error.code, error.message, error.issues.length > 0 ? error.issues : undefined),
      { status },
    );
  }
  if (error instanceof SettingsConflictError) {
    const body: SettingsRevConflictBody = {
      ...errorBody('rev_conflict', error.message),
      settings: error.settings,
      currentRev: error.settings.rev,
    };
    return Response.json(body, { status: 409 });
  }
  if (error instanceof StoreError) {
    if (error.code === 'rev_conflict' && error.wall !== undefined) {
      const body: RevConflictBody = {
        ...errorBody(error.code, error.message),
        wall: error.wall,
        currentRev: error.wall.rev,
      };
      return Response.json(body, { status: 409 });
    }
    return Response.json(errorBody(error.code, error.message), {
      status: STORE_STATUS[error.code],
    });
  }
  if (error instanceof OpError) {
    const details = {
      code: error.code,
      ...(error.opIndex === undefined ? {} : { opIndex: error.opIndex }),
    };
    return Response.json(errorBody('op_failed', error.message, details), { status: 422 });
  }
  if (error instanceof JobError) {
    const status =
      error.code === 'job_not_found' ? 404 : error.code === 'unknown_job_kind' ? 404 : 400;
    const code = error.code === 'invalid_input' ? 'invalid_body' : error.code;
    return Response.json(
      errorBody(code, error.message, error.issues.length > 0 ? error.issues : undefined),
      {
        status,
      },
    );
  }
  if (error instanceof WallParseError) {
    return Response.json(errorBody('invalid_body', error.message, error.issues), { status: 400 });
  }
  console.error('hsw-editor: unhandled error', error);
  return Response.json(errorBody('internal', 'internal error'), { status: 500 });
}

async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES)
    throw new HttpError(413, 'payload_too_large', 'request body is too large');
  let raw: JsonValue;
  try {
    raw = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_body',
      'request body does not match the schema',
      formatIssues(parsed.error),
    );
  }
  return parsed.data;
}

function applyResponse(outcome: Outcome): ApplyResponse {
  return {
    rev: outcome.wall.rev,
    changed: outcome.changed,
    op: outcome.op,
    inverse: outcome.inverse,
    wall: outcome.wall,
    warnings: outcome.warnings,
    canUndo: outcome.canUndo,
    canRedo: outcome.canRedo,
  };
}

function parseSince(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The part of a parsed multipart form the routes read. */
interface UploadForm {
  get(name: string): string | File | null;
}

async function readUpload(
  request: Request,
  limit: number,
): Promise<{ file: File; bytes: Uint8Array; fields: UploadForm; actor: Actor }> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw new HttpError(415, 'unsupported_media_type', 'expected multipart/form-data');
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > limit + 1024 * 1024)
    throw new HttpError(413, 'payload_too_large', `upload exceeds ${limit} bytes`);
  const fields = await request.formData();
  const file = fields.get('file');
  if (!(file instanceof File))
    throw new HttpError(400, 'invalid_body', 'multipart field "file" is required');
  if (file.size > limit)
    throw new HttpError(413, 'payload_too_large', `upload exceeds ${limit} bytes`);
  const rawActor = fields.get('actor');
  let actor = HUMAN;
  if (typeof rawActor === 'string') {
    const parsed = ActorSchema.safeParse(safeJson(rawActor));
    if (!parsed.success)
      throw new HttpError(
        400,
        'invalid_body',
        'actor must be a JSON actor',
        formatIssues(parsed.error),
      );
    actor = parsed.data;
  }
  return { file, bytes: new Uint8Array(await file.arrayBuffer()), fields, actor };
}

function safeJson(text: string): JsonValue {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formString(fields: UploadForm, key: string): string | undefined {
  const value = fields.get(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const NORMALIZE_STATUS: Record<NormalizeErrorCode, [number, string]> = {
  photo_undecodable: [415, 'unsupported_media_type'],
  heic_converter_unavailable: [501, 'heic_converter_unavailable'],
  heic_conversion_failed: [422, 'heic_conversion_failed'],
};

async function normalizeUpload(bytes: Uint8Array, home: string): Promise<Uint8Array> {
  try {
    return (await normalizePhoto(bytes, { workDir: join(home, 'tmp') })).bytes;
  } catch (error) {
    if (error instanceof NormalizeError) {
      const [status, code] = NORMALIZE_STATUS[error.code];
      throw new HttpError(status, code, error.message);
    }
    throw error;
  }
}

function assetResponse(path: string, mime: string): Response {
  const file = Bun.file(path);
  return new Response(file, {
    headers: { 'content-type': mime, 'cache-control': 'private, max-age=31536000, immutable' },
  });
}

/** Handles `/api/*` (except module-owned prefixes). Returns null for non-API paths. */
export async function handleApi(request: Request, deps: ServerDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  try {
    return (
      (await route(request, url, deps)) ??
      errorResponse(new HttpError(404, 'not_found', `no route ${request.method} ${url.pathname}`))
    );
  } catch (error) {
    return errorResponse(error);
  }
}

async function route(request: Request, url: URL, deps: ServerDeps): Promise<Response | null> {
  const parts = url.pathname
    .split('/')
    .filter((part) => part !== '')
    .slice(1); // drop "api"
  const [resource, id, sub, subId, tail] = parts;
  const method = request.method;
  const { store, jobs } = deps;

  if (resource === 'health' && parts.length === 1 && method === 'GET') {
    return Response.json(
      { ok: true, name: 'hsw-editor', version: SERVER_VERSION, home: store.home },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  if (resource === 'settings')
    return settingsRoutes(request, parts.slice(1), deps.settings, deps.config.heartbeatMs);

  if (resource === 'walls') {
    if (id === undefined) {
      if (method === 'GET') return Response.json({ walls: await store.list() });
      if (method === 'POST') {
        const body = await readJson(request, CreateWallBodySchema);
        const board =
          body.board === undefined
            ? undefined
            : {
                cols: body.board.cols ?? DEFAULT_BOARD.cols,
                rows: body.board.rows ?? DEFAULT_BOARD.rows,
                colPitchMm: body.board.colPitchMm ?? DEFAULT_BOARD.colPitchMm,
                rowPitchMm: body.board.rowPitchMm ?? DEFAULT_BOARD.rowPitchMm,
              };
        const state = await store.create(
          { name: body.name, id: body.id, board },
          body.actor ?? HUMAN,
        );
        return Response.json(state satisfies WallResponse, { status: 201 });
      }
      return null;
    }
    if (sub === undefined) {
      if (method === 'GET') return Response.json((await store.get(id)) satisfies WallResponse);
      if (method === 'DELETE') {
        const trashedTo = await store.remove(id);
        return Response.json({ ok: true, trashedTo });
      }
      return null;
    }
    return wallSubroute(request, url, deps, { id, sub, subId, tail, parts });
  }

  if (resource === 'jobs') {
    if (id === undefined) {
      if (method === 'GET') {
        return Response.json({
          jobs: jobs.list({
            kind: url.searchParams.get('kind') ?? undefined,
            wallId: url.searchParams.get('wallId') ?? undefined,
            state: url.searchParams.get('state') ?? undefined,
          }),
        });
      }
      if (method === 'POST') {
        const body = await readJsonLoose(request);
        if (typeof body['kind'] !== 'string')
          throw new HttpError(400, 'invalid_body', 'kind is required');
        const wallId = typeof body['wallId'] === 'string' ? body['wallId'] : undefined;
        const input = body['input'] ?? {};
        return Response.json({ job: jobs.submit(body['kind'], input, wallId) }, { status: 202 });
      }
      return null;
    }
    if (sub === undefined && method === 'GET') return Response.json({ job: jobs.get(id) });
    if (sub === 'cancel' && method === 'POST') return Response.json({ job: jobs.cancel(id) });
    if (sub === 'events' && method === 'GET') {
      jobs.get(id); // 404 before opening the stream
      const lastEventId = parseSince(request.headers.get('last-event-id')) ?? 0;
      return sseResponse(request, {
        start: (sink) =>
          jobs.subscribe(id, lastEventId, {
            onEvent: (event) => sink.send(event.event, event.data, event.id),
            onEnd: () => sink.close(),
          }),
      });
    }
    return null;
  }
  return null;
}

async function readJsonLoose(request: Request): Promise<{ [key: string]: JsonValue }> {
  const text = await request.text();
  let raw: JsonValue;
  try {
    raw = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, 'invalid_body', 'request body must be a JSON object');
  }
  return raw;
}

interface WallRoute {
  id: string;
  sub: string;
  subId: string | undefined;
  tail: string | undefined;
  parts: string[];
}

async function wallSubroute(
  request: Request,
  url: URL,
  deps: ServerDeps,
  { id, sub, subId, tail }: WallRoute,
): Promise<Response | null> {
  const { store, config } = deps;
  const method = request.method;

  if (sub === 'ops' && method === 'POST') {
    const body = await readJson(request, OpsBodySchema);
    const outcome = await store.apply(id, {
      ops: body.ops,
      baseRev: body.baseRev,
      actor: body.actor ?? HUMAN,
      label: body.label,
    });
    return Response.json(applyResponse(outcome));
  }
  if ((sub === 'undo' || sub === 'redo') && method === 'POST') {
    const body = await readJson(request, UndoBodySchema);
    const request2 = { baseRev: body.baseRev, actor: body.actor ?? HUMAN };
    const outcome =
      sub === 'undo' ? await store.undo(id, request2) : await store.redo(id, request2);
    return Response.json(applyResponse(outcome));
  }
  if (sub === 'history' && method === 'GET') {
    const since = parseSince(url.searchParams.get('since')) ?? -1;
    const limit = Math.min(parseSince(url.searchParams.get('limit')) ?? 1000, 10_000);
    return Response.json({ entries: await store.history(id, since, limit) });
  }
  if (sub === 'export' && method === 'GET') {
    const { wall, history } = await store.exportWall(id);
    const body: WallExport = { format: 'hsw-editor-wall', version: 1, wall, history };
    return Response.json(body);
  }

  if (sub === 'photos' && subId === undefined && method === 'POST') {
    const upload = await readUpload(request, MAX_PHOTO_BYTES);
    await store.get(id); // 404 before any conversion work
    // Pixels are stored upright (EXIF rotation applied, HEIC converted): the overlay's coordinates are oriented pixels.
    const photoBytes = await normalizeUpload(upload.bytes, config.home);
    const info = sniffImage(photoBytes);
    if (info === null)
      throw new HttpError(415, 'unsupported_media_type', 'not a JPEG, PNG or WebP image');
    const file = await store.addAsset(id, {
      dir: 'photos',
      ext: info.ext,
      bytes: photoBytes,
      prefix: 'p',
    });
    try {
      const photo = PhotoSchema.parse({
        id: basename(file, `.${info.ext}`),
        file,
        mime: info.mime,
        width: info.width,
        height: info.height,
        name:
          formString(upload.fields, 'name') ??
          (upload.file.name === '' ? undefined : upload.file.name),
        origin: 'upload',
        sha256: new Bun.CryptoHasher('sha256').update(photoBytes).digest('hex'),
      });
      const outcome = await store.apply(id, {
        ops: [{ type: 'addPhoto', photo }],
        actor: upload.actor,
      });
      const body: PhotoUploadResponse = { photo, rev: outcome.wall.rev, wall: outcome.wall };
      return Response.json(body, { status: 201 });
    } catch (error) {
      await store.removeAsset(id, file);
      throw error;
    }
  }
  if (sub === 'photos' && subId !== undefined && tail === 'file' && method === 'GET') {
    const { wall } = await store.get(id);
    const photo = wall.photos.find((candidate) => candidate.id === subId);
    if (photo === undefined) throw new HttpError(404, 'asset_not_found', `no photo ${subId}`);
    return assetResponse(store.assetPath(id, photo.file), photo.mime);
  }

  if (sub === 'models' && subId === undefined && method === 'POST') {
    const upload = await readUpload(request, MAX_MODEL_BYTES);
    if (!isGlb(upload.bytes))
      throw new HttpError(415, 'unsupported_media_type', 'not a binary glTF (.glb) file');
    const file = await store.addAsset(id, {
      dir: 'models',
      ext: 'glb',
      bytes: upload.bytes,
      prefix: 'm',
    });
    try {
      const forItemId = formString(upload.fields, 'forItemId');
      const model = ModelRefSchema.parse({
        id: basename(file, '.glb'),
        label:
          formString(upload.fields, 'label') ??
          (upload.file.name === '' ? 'Uploaded model' : upload.file.name),
        status: 'candidate',
        source: { type: 'upload' },
        file,
        ...(forItemId === undefined ? {} : { forItemId }),
      });
      const outcome = await store.apply(id, {
        ops: [{ type: 'addModelRef', model }],
        actor: upload.actor,
      });
      const body: ModelUploadResponse = { model, rev: outcome.wall.rev, wall: outcome.wall };
      return Response.json(body, { status: 201 });
    } catch (error) {
      await store.removeAsset(id, file);
      throw error;
    }
  }
  if (sub === 'models' && subId !== undefined && tail === 'file' && method === 'GET') {
    const { wall } = await store.get(id);
    const model = wall.models.find((candidate) => candidate.id === subId);
    if (model?.file === undefined)
      throw new HttpError(404, 'asset_not_found', `no model file ${subId}`);
    return assetResponse(store.assetPath(id, model.file), 'model/gltf-binary');
  }

  if (sub === 'requests')
    return requestRoutes(request, url, deps, { id, requestId: subId, action: tail });

  if (sub === 'events' && method === 'GET') {
    await store.get(id); // 404 before opening the stream
    const since =
      parseSince(request.headers.get('last-event-id')) ?? parseSince(url.searchParams.get('since'));
    let rev = since ?? 0;
    return sseResponse(request, {
      heartbeat: { everyMs: config.heartbeatMs, event: 'heartbeat', data: () => ({ rev }) },
      start: async (sink) => {
        const unsubscribe = await store.subscribe(id, since, {
          onResume: (resume, openRequests) => {
            if (resume.kind === 'snapshot') {
              rev = resume.wall.rev;
              sink.send('snapshot', { wall: resume.wall }, rev);
            } else {
              for (const entry of resume.entries) {
                rev = entry.rev;
                sink.send('op', entry, entry.rev);
              }
            }
            for (const open of openRequests) sink.send('request_input', { request: open });
          },
          onEntry: (entry) => {
            rev = entry.rev;
            sink.send('op', entry, entry.rev);
          },
          onRequest: (event) => {
            if (event.type === 'request_input') {
              sink.send('request_input', { request: event.request });
            } else {
              sink.send('request_resolved', {
                id: event.id,
                status: event.status,
                ...(event.answer === undefined ? {} : { answer: event.answer }),
              });
            }
          },
          onDeleted: () => {
            sink.send('deleted', {});
            sink.close();
          },
        });
        return unsubscribe;
      },
    });
  }
  return null;
}

export interface HealthPayload {
  readonly ok: true;
  readonly name: 'hsw-editor';
  readonly version: string;
  readonly home: string;
}

const MAX_WAIT_MS = 120_000;
const AGENT: Actor = { kind: 'agent' };

interface RequestRoute {
  id: string;
  requestId: string | undefined;
  action: string | undefined;
}

/** Input requests: agents ask, the UI answers (docs/api.md, "Input requests"). */
async function requestRoutes(
  request: Request,
  url: URL,
  { store }: ServerDeps,
  { id, requestId, action }: RequestRoute,
): Promise<Response | null> {
  const method = request.method;
  if (requestId === undefined) {
    if (method === 'POST') {
      const body = await readJson(request, CreateRequestBodySchema);
      const created = await store.createRequest(id, body.request, body.actor ?? AGENT);
      return Response.json({ request: created }, { status: 201 });
    }
    if (method === 'GET') {
      const status = url.searchParams.get('status');
      if (status !== null && !REQUEST_STATUSES.some((known) => known === status)) {
        throw new HttpError(
          400,
          'invalid_body',
          `status must be one of ${REQUEST_STATUSES.join(', ')}`,
        );
      }
      const known = REQUEST_STATUSES.find((candidate) => candidate === status);
      return Response.json({ requests: await store.listRequests(id, known) });
    }
    return null;
  }
  if (action === undefined && method === 'GET') {
    const wait = Math.min(parseSince(url.searchParams.get('wait')) ?? 0, MAX_WAIT_MS);
    return Response.json({ request: await store.getRequest(id, requestId, wait, request.signal) });
  }
  if (action === 'answer' && method === 'POST') {
    const body = await readJson(request, AnswerRequestBodySchema);
    const answered = await store.answerRequest(id, requestId, body.answer, body.actor ?? HUMAN);
    return Response.json({ request: answered });
  }
  if (action === 'cancel' && method === 'POST') {
    const body = await readJson(request, CancelRequestBodySchema);
    return Response.json({
      request: await store.cancelRequest(id, requestId, body.actor ?? HUMAN),
    });
  }
  return null;
}
