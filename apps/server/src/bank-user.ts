/**
 * User-made bank elements on the daemon: `/api/bank/user/*` routes and the `bank.user.import` job.
 * The store and the merge into the served index live in `@hsw-editor/bank/node` (docs/bank.md "User
 * elements"); this file owns HTTP, the wall-usage check on delete and the job registration.
 */
import {
  bankPaths,
  createBankHandler,
  createUserBank,
  UserElementError,
  type BankHandler,
  type UserBank,
} from '@hsw-editor/bank/node';
import {
  ConvertSettingsSchema,
  MAX_USER_MESH_BYTES,
  USER_IMPORT_JOB,
  UserImportInputSchema,
  UserPatchSchema,
  userElementIdSchema,
  uploadIdSchema,
} from '@hsw-editor/bank';
import { formatIssues, type JsonValue } from '@hsw-editor/core';
import type { z } from 'zod';
import { errorBody } from './api.ts';
import { HttpError } from './http-error.ts';
import { registerJob } from './jobs.ts';
import type { ServerDeps } from './modules.ts';

/** What the daemon holds per data home: the served bank handler and the user store it merges. */
export interface BankContext {
  readonly handler: BankHandler;
  readonly user: UserBank;
}

const contexts = new Map<string, BankContext>();

/** One context per data home (a daemon has one; tests run several against temp homes). */
export function bankContextFor(home: string): BankContext {
  let context = contexts.get(home);
  if (context === undefined) {
    const paths = bankPaths({ ...process.env, HSW_EDITOR_HOME: home });
    context = {
      handler: createBankHandler({ paths, userRoot: paths.userDir }),
      user: createUserBank(paths),
    };
    contexts.set(home, context);
  }
  return context;
}

function toJson(value: object): JsonValue {
  // the store's records are plain data; a round trip drops `undefined` and proves they are JSON
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

registerJob({
  kind: USER_IMPORT_JOB,
  inputSchema: UserImportInputSchema,
  concurrency: 1,
  async run(input, ctx) {
    const { user, handler } = bankContextFor(ctx.home);
    try {
      const result = await user.importElement(input, {
        signal: ctx.signal,
        progress: (message) => ctx.progress({ message }),
      });
      return toJson(result);
    } finally {
      handler.invalidate();
    }
  },
});

const ELEMENTS = '/api/bank/user/elements';
const UPLOADS = '/api/bank/user/uploads';
const ELEMENT_ROUTE = /^\/api\/bank\/user\/elements\/([^/]+)(?:\/(reopen))?$/;
const UPLOAD_ROUTE =
  /^\/api\/bank\/user\/uploads\/([^/]+)(?:\/(preview)(?:\/([0-9a-f]{16})\.glb)?)?$/;

function fail(status: number, code: string, message: string, details?: unknown): Response {
  return Response.json(errorBody(code, message, details), { status });
}

function failFrom(error: unknown): Response {
  if (error instanceof UserElementError)
    return fail(error.status, error.code, error.message, error.details);
  if (error instanceof HttpError)
    return fail(error.status, error.code, error.message, error.details);
  console.error('hsw-editor: user element request failed', error);
  return fail(500, 'internal', 'internal error');
}

async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    const text = await request.text();
    raw = text === '' ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(
      400,
      'invalid_body',
      'request body does not match the schema',
      formatIssues(parsed.error),
    );
  return parsed.data;
}

function id<S extends z.ZodType>(schema: S, raw: string, what: string): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid_id', `${what} id ${raw} is not valid`);
  return parsed.data;
}

async function readFileUpload(request: Request): Promise<{ bytes: Uint8Array; filename: string }> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data'))
    throw new HttpError(415, 'unsupported_media_type', 'expected multipart/form-data');
  if (Number(request.headers.get('content-length') ?? 0) > MAX_USER_MESH_BYTES + 1024 * 1024)
    throw new HttpError(413, 'payload_too_large', `upload exceeds ${MAX_USER_MESH_BYTES} bytes`);
  const fields = await request.formData();
  const file = fields.get('file');
  if (!(file instanceof File))
    throw new HttpError(400, 'invalid_body', 'multipart field "file" is required');
  if (file.size > MAX_USER_MESH_BYTES)
    throw new HttpError(413, 'payload_too_large', `upload exceeds ${MAX_USER_MESH_BYTES} bytes`);
  return { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name };
}

/** Walls that still place `elementId`: deleting it would leave those items without a model. */
async function wallsUsing(
  deps: ServerDeps,
  elementId: string,
): Promise<{ wallId: string; items: number }[]> {
  const used: { wallId: string; items: number }[] = [];
  for (const summary of await deps.store.list()) {
    const { wall } = await deps.store.get(summary.id);
    const items = wall.items.filter((item) => item.bankId === elementId).length;
    if (items > 0) used.push({ wallId: summary.id, items });
  }
  return used;
}

/** `null` for URLs that are not user-element routes. */
export async function handleUserRoutes(
  request: Request,
  deps: ServerDeps,
): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url);
  if (!pathname.startsWith('/api/bank/user/')) return null;
  const { user, handler } = bankContextFor(deps.config.home);
  const method = request.method;
  try {
    if (pathname === ELEMENTS && method === 'GET')
      return Response.json({ elements: await user.list() });

    const element = ELEMENT_ROUTE.exec(pathname);
    if (element) {
      const elementId = id(userElementIdSchema, decodeURIComponent(element[1] ?? ''), 'element');
      if (element[2] === 'reopen' && method === 'POST')
        return Response.json(await user.reopen(elementId), { status: 201 });
      if (element[2] === undefined && method === 'GET') {
        const record = await user.get(elementId);
        return record
          ? Response.json(record)
          : fail(404, 'element_not_found', `no user element ${elementId}`);
      }
      if (element[2] === undefined && method === 'PATCH') {
        const patched = await user.patch(elementId, await readBody(request, UserPatchSchema));
        handler.invalidate();
        return Response.json({ element: patched });
      }
      if (element[2] === undefined && method === 'DELETE') {
        if (!(await user.list()).some((e) => e.id === elementId))
          return fail(404, 'element_not_found', `no user element ${elementId}`);
        if (searchParams.get('force') !== '1') {
          const walls = await wallsUsing(deps, elementId);
          if (walls.length > 0)
            return fail(
              409,
              'element_in_use',
              `${elementId} is placed on ${walls.length} wall(s); delete with force=1 to leave those items without a model`,
              { walls },
            );
        }
        await user.remove(elementId);
        handler.invalidate();
        return Response.json({ ok: true });
      }
      return fail(405, 'method_not_allowed', `${method} ${pathname}`);
    }

    if (pathname === UPLOADS && method === 'POST') {
      const { bytes, filename } = await readFileUpload(request);
      return Response.json({ upload: await user.createUpload(bytes, filename) }, { status: 201 });
    }

    const upload = UPLOAD_ROUTE.exec(pathname);
    if (upload) {
      const uploadId = id(uploadIdSchema, decodeURIComponent(upload[1] ?? ''), 'upload');
      if (upload[2] === undefined && method === 'DELETE') {
        await user.deleteUpload(uploadId);
        return Response.json({ ok: true });
      }
      if (upload[2] === 'preview' && upload[3] === undefined && method === 'POST') {
        const settings = await readBody(request, ConvertSettingsSchema);
        return Response.json({ conversion: await user.previewUpload(uploadId, settings) });
      }
      if (upload[2] === 'preview' && upload[3] !== undefined && method === 'GET') {
        const file = user.previewFile(uploadId, upload[3]);
        if (file !== null && (await Bun.file(file).exists()))
          return new Response(Bun.file(file), {
            headers: {
              'content-type': 'model/gltf-binary',
              'cache-control': 'private, max-age=3600',
            },
          });
        return fail(404, 'asset_not_found', 'preview not found (expired?)');
      }
      return fail(405, 'method_not_allowed', `${method} ${pathname}`);
    }
    return fail(404, 'not_found', `unknown route ${pathname}`);
  } catch (error) {
    return failFrom(error);
  }
}
