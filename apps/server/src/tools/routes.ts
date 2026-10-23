/**
 * `/api/tools/*`: built-in tool classes (parametric generators), the user tool library and the photo
 * import drafts. The `tools.analyze` job (registered in `./module.ts`) runs the sidecar on a draft; everything
 * else is synchronous. Error bodies follow docs/api.md: `{ error: { code, message, details? } }`.
 */
import {
  type AnyToolClass,
  CalibrationInputSchema,
  CustomToolPatchSchema,
  DraftObjectPatchSchema,
  FAMILY_LABELS,
  type ParamValue,
  type ToolModel,
  TagsSchema,
  ToolInputError,
  applyPatch,
  createManualTool,
  exportGlb,
  generate,
  getToolClass,
  hasToolClass,
  listToolClasses,
  presetValues,
} from '@hsw-editor/tools';
import {
  DraftError,
  ToolStoreError,
  VisionRequestError,
  VisionUnavailableError,
  addDraftObject,
  commitDraft,
  groupDraftObjects,
  holdingOf,
  mergeDraftObjects,
  patchDraftObject,
  recalibrateDraft,
  splitDraftObject,
  type DraftDeps,
} from '@hsw-editor/tools/node';
import { z } from 'zod';
import { classThumb, thumbKey } from './thumbs.ts';

const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
const MAX_PHOTOS = 20;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

function fail(status: number, code: string, message: string, details?: unknown): Response {
  return json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

function fileResponse(path: string, mime: string, immutable: boolean): Response {
  return new Response(Bun.file(path), {
    headers: {
      'content-type': mime,
      'cache-control': immutable ? 'private, max-age=31536000, immutable' : 'no-cache',
    },
  });
}

const ParamValues = z.record(z.string(), z.union([z.number(), z.string()]));
const ClassQuery = z.object({
  lod: z.enum(['0', '1']).default('0'),
  preset: z.string().optional(),
  p: z.string().optional(),
});
const ManualToolBody = z.strictObject({
  classId: z.string(),
  params: ParamValues.default({}),
  name: z
    .strictObject({
      en: z.string().max(120).optional(),
      ru: z.string().max(120).optional(),
    })
    .default({}),
  tags: TagsSchema.default([]),
});
const KeysBody = z.strictObject({ keys: z.array(z.string()).min(2).max(40) });
const SplitBody = z.union([
  z.strictObject({ key: z.string(), n: z.number().int().min(2).max(4) }),
  z.strictObject({
    key: z.string(),
    linePx: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]),
  }),
]);
const AddBody = z.union([
  z.strictObject({ photo: z.number().int().min(0), pointPx: z.tuple([z.number(), z.number()]) }),
  z.strictObject({
    photo: z.number().int().min(0),
    boxXywh: z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]),
  }),
]);
const CommitBody = z.strictObject({
  keys: z.array(z.string()).max(200).optional(),
  /** Added (union) to the tags of every committed tool. */
  tags: TagsSchema.optional(),
});

/** Query / form fields that carry JSON: a malformed value is a 400 naming the field, not a body error. */
function parseJsonField(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ToolInputError(`${name} is not valid JSON`);
  }
}

/** A request whose URL, JSON or fields are malformed (400 `invalid_id` / `invalid_json` / `invalid_body`). */
class RequestShapeError extends Error {
  readonly code: 'invalid_id' | 'invalid_json' | 'invalid_body';
  readonly details: string[] | undefined;
  constructor(code: RequestShapeError['code'], message: string, details?: string[]) {
    super(message);
    this.name = 'RequestShapeError';
    this.code = code;
    this.details = details;
  }
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RequestShapeError(
      'invalid_id',
      `malformed percent-escape in the URL path: ${segment}`,
    );
  }
}

/** Request data is validated here and only here: a schema failure elsewhere is a server bug (500), not a 400. */
function parseInput<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new RequestShapeError(
    'invalid_body',
    `${what} does not match the schema`,
    parsed.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`),
  );
}

async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new RequestShapeError('invalid_json', 'body is not valid JSON');
  }
  return parseInput(schema, value, 'body');
}

function classValues(cls: AnyToolClass, q: z.infer<typeof ClassQuery>): Record<string, ParamValue> {
  let base: Record<string, ParamValue> = {};
  if (q.preset) {
    if (!cls.presets.some((p) => p.id === q.preset)) {
      throw new ToolInputError(`class ${cls.id} has no preset ${q.preset}`);
    }
    base = presetValues(cls.id, q.preset);
  }
  if (!q.p) return base;
  const parsed = ParamValues.safeParse(parseJsonField('p', q.p));
  if (!parsed.success) throw new ToolInputError('p must be a JSON object of parameter values');
  return { ...base, ...parsed.data };
}

const classMetricsMemo = new Map<
  string,
  {
    dimsMm: { x: number; y: number; z: number };
    holdingDims: Record<string, number>;
  }
>();

/** Size and holding dims of the default build of a class, computed on first use. */
function classMetrics(cls: AnyToolClass): NonNullable<ReturnType<typeof classMetricsMemo.get>> {
  let m = classMetricsMemo.get(cls.id);
  if (!m) {
    const model = generate(cls.id, {}, 0);
    const b = model.bounds;
    m = {
      dimsMm: {
        x: b.max[0] - b.min[0],
        y: b.max[1] - b.min[1],
        z: b.max[2] - b.min[2],
      },
      holdingDims: model.holding.dims,
    };
    classMetricsMemo.set(cls.id, m);
  }
  return m;
}

function describeClass(cls: AnyToolClass): Record<string, unknown> {
  return {
    id: cls.id,
    family: cls.family,
    familyLabel: FAMILY_LABELS[cls.family],
    name: cls.name,
    bankClass: cls.bankClass,
    keywords: cls.keywords,
    schema: cls.schema,
    presets: cls.presets,
    thumb: `/api/tools/classes/${encodeURIComponent(cls.id)}/thumb.webp`,
    ...classMetrics(cls),
  };
}

const DRAFT_STATUS = {
  not_found: 404,
  invalid: 400,
  conflict: 409,
  unsupported_media: 415,
  corrupt: 500,
} as const;
const STORE_STATUS = {
  not_found: 404,
  exists: 409,
  invalid_id: 400,
  corrupt: 500,
} as const;

function errorToResponse(error: unknown): Response {
  if (error instanceof RequestShapeError) {
    return fail(400, error.code, error.message, error.details);
  }
  if (error instanceof ToolInputError) return fail(400, 'invalid_request', error.message);
  if (error instanceof DraftError) {
    const code =
      error.code === 'not_found'
        ? 'draft_not_found'
        : error.code === 'unsupported_media'
          ? 'unsupported_media_type'
          : error.code;
    return fail(DRAFT_STATUS[error.code], code, error.message);
  }
  if (error instanceof ToolStoreError) {
    return fail(
      STORE_STATUS[error.code],
      error.code === 'not_found' ? 'tool_not_found' : error.code,
      error.message,
    );
  }
  if (error instanceof VisionUnavailableError || error instanceof VisionRequestError) {
    return fail(502, 'vision_unavailable', error.message);
  }
  throw error;
}

export type ToolsRoutes = (
  request: Request,
  deps: DraftDeps,
  home: string,
) => Promise<Response | null>;

export const handleToolsRequest: ToolsRoutes = async (request, deps, home) => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== '/api/tools' && !path.startsWith('/api/tools/')) return null;
  try {
    const parts = path
      .split('/')
      .filter(Boolean)
      .slice(2)
      .map((segment) => decodePathSegment(segment));
    return await route(request, url, parts, deps, home);
  } catch (error) {
    return errorToResponse(error);
  }
};

async function route(
  request: Request,
  url: URL,
  parts: readonly string[],
  deps: DraftDeps,
  home: string,
): Promise<Response> {
  const method = request.method;
  const [a, b, c] = parts;

  if (a === 'classes') return classRoute(request, url, home, b, c);
  if (a === 'drafts') return draftRoute(request, deps, parts.slice(1));

  if (a === undefined) {
    if (method === 'GET') return json({ tools: await deps.tools.list() });
    if (method === 'POST') return createManual(request, deps);
    return fail(405, 'method_not_allowed', 'GET or POST');
  }
  const id = a;
  if (b === undefined) {
    if (method === 'GET') return json({ tool: await deps.tools.get(id) });
    if (method === 'PATCH') {
      const patch = await readBody(request, CustomToolPatchSchema);
      const saved = await deps.tools.update(id, (tool) => {
        const rebuilt = applyPatch(tool, patch);
        return {
          tool: rebuilt.tool,
          files: { model: rebuilt.model, modelLod1: rebuilt.modelLod1 },
        };
      });
      return json({ tool: saved });
    }
    if (method === 'DELETE') return json({ ok: true, trashedTo: await deps.tools.remove(id) });
    return fail(405, 'method_not_allowed', 'GET, PATCH or DELETE');
  }
  if (method !== 'GET') return fail(405, 'method_not_allowed', 'GET only');
  if (b === 'model.glb') return stored(await deps.tools.file(id, 'glb'));
  if (b === 'model-lod1.glb') return stored(await deps.tools.file(id, 'glbLod1'));
  if (b === 'holding') {
    const tool = await deps.tools.get(id);
    try {
      return json(holdingOf(tool));
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      return fail(409, 'conflict', `tool ${id} can no longer be rebuilt: ${String(error)}`);
    }
  }
  if (b === 'thumb.webp') return stored(await deps.tools.file(id, 'thumb'));
  if (b === 'source' && c) {
    const path = await deps.tools.sourceFile(id, c);
    const file = Bun.file(path);
    if (!(await file.exists())) return fail(404, 'not_found', 'no such source file');
    return fileResponse(path, file.type || 'application/octet-stream', true);
  }
  return fail(404, 'not_found', 'unknown tool resource');
}

function stored(f: { path: string; mime: string }): Response {
  return fileResponse(f.path, f.mime, false);
}

async function classRoute(
  request: Request,
  url: URL,
  home: string,
  classId: string | undefined,
  resource: string | undefined,
): Promise<Response> {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', 'GET only');
  if (classId === undefined) return json({ classes: listToolClasses().map(describeClass) });
  if (!hasToolClass(classId)) return fail(404, 'class_not_found', `no tool class ${classId}`);
  const cls = getToolClass(classId);
  if (resource === undefined) return json(describeClass(cls));
  if (resource !== 'model.glb' && resource !== 'holding' && resource !== 'thumb.webp') {
    return fail(404, 'not_found', 'unknown class resource');
  }
  const q = parseInput(ClassQuery, Object.fromEntries(url.searchParams), 'query');
  const model = generate(cls.id, classValues(cls, q), q.lod === '1' ? 1 : 0);
  if (resource === 'thumb.webp') return thumbResponse(request, home, model, q.p === undefined);
  if (resource === 'model.glb') {
    return new Response(exportGlb(model), {
      headers: {
        'content-type': 'model/gltf-binary',
        'cache-control': 'no-cache',
      },
    });
  }
  return json({
    params: model.params,
    holding: model.holding,
    bboxMm: model.bounds,
    bankClass: cls.bankClass,
  });
}

/** Revalidated on every use (the generator may change); the strong ETag is the content key, so most are 304s. */
async function thumbResponse(
  request: Request,
  home: string,
  model: ToolModel,
  persist: boolean,
): Promise<Response> {
  const key = thumbKey(model);
  const headers = {
    'cache-control': 'public, max-age=0, must-revalidate',
    etag: `"${key}"`,
  };
  const match = request.headers.get('if-none-match');
  // weak comparison (RFC 9110): `W/"key"` and `*` match too; no render happens for a revalidation
  if (
    match !== null &&
    match.split(',').some((t) => t.trim() === '*' || t.trim().replace(/^W\//, '') === `"${key}"`)
  ) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(await classThumb(home, model, persist).bytes, {
    headers: { ...headers, 'content-type': 'image/webp' },
  });
}

/** A built-in class with chosen parameters saved to the user library. */
async function createManual(request: Request, deps: DraftDeps): Promise<Response> {
  const body = await readBody(request, ManualToolBody);
  if (!hasToolClass(body.classId)) {
    return fail(404, 'class_not_found', `no tool class ${body.classId}`);
  }
  const saved = await deps.tools.exclusive(async () => {
    const id = await deps.tools.freeId(body.name.en ?? body.classId);
    const manual = createManualTool({
      tags: body.tags,
      id,
      classId: body.classId,
      params: body.params,
      name: body.name,
    });
    return deps.tools.save(manual.tool, {
      model: manual.model,
      modelLod1: manual.modelLod1,
    });
  });
  return json({ tool: saved }, 201);
}

async function draftRoute(
  request: Request,
  deps: DraftDeps,
  parts: readonly string[],
): Promise<Response> {
  const method = request.method;
  const [id, sub, key, ...rest] = parts;
  if (id === undefined) {
    if (method === 'POST') return createDraft(request, deps);
    return fail(405, 'method_not_allowed', 'POST only');
  }
  if (sub === undefined) {
    if (method === 'GET') return json({ draft: await deps.drafts.get(id) });
    if (method === 'DELETE') {
      await deps.drafts.remove(id);
      return json({ ok: true });
    }
    return fail(405, 'method_not_allowed', 'GET or DELETE');
  }
  if (sub === 'files' && method === 'GET') {
    const path = await deps.drafts.file(id, [key, ...rest].join('/'));
    return fileResponse(path, Bun.file(path).type || 'application/octet-stream', false);
  }
  if (sub === 'objects' && key !== undefined && method === 'PATCH') {
    const patch = await readBody(request, DraftObjectPatchSchema);
    return json({ draft: await patchDraftObject(deps, id, key, patch) });
  }
  if (method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');
  if (sub === 'group') {
    const body = await readBody(request, KeysBody);
    return json({ draft: await groupDraftObjects(deps, id, body.keys) });
  }
  if (sub === 'merge') {
    const body = await readBody(request, KeysBody);
    return json({ draft: await mergeDraftObjects(deps, id, body.keys) });
  }
  if (sub === 'split') {
    const body = await readBody(request, SplitBody);
    const how = 'n' in body ? { n: body.n } : { linePx: body.linePx };
    return json({ draft: await splitDraftObject(deps, id, body.key, how) });
  }
  if (sub === 'add') {
    const body = await readBody(request, AddBody);
    const { photo, ...prompt } = body;
    return json({ draft: await addDraftObject(deps, id, photo, prompt) });
  }
  if (sub === 'calibration') {
    const body = await readBody(request, CalibrationInputSchema);
    return json({ draft: await recalibrateDraft(deps, id, body) });
  }
  if (sub === 'commit') {
    const body = await readBody(request, CommitBody);
    const result = await commitDraft(deps, id, body.keys, new Date(), body.tags);
    return json({ ...result, draft: await deps.drafts.get(id) }, 201);
  }
  return fail(404, 'not_found', 'unknown draft resource');
}

async function createDraft(request: Request, deps: DraftDeps): Promise<Response> {
  if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    return fail(415, 'unsupported_media_type', 'expected multipart/form-data with photo fields');
  }
  const form = await request.formData().catch((): never => {
    throw new RequestShapeError('invalid_body', 'the multipart body is malformed or cut off');
  });
  const files: Blob[] = [];
  for (const v of form.getAll('photo')) if (typeof v !== 'string') files.push(v);
  if (files.length === 0) {
    return fail(400, 'invalid_body', 'multipart field "photo" (one or more files) is required');
  }
  if (files.length > MAX_PHOTOS) {
    return fail(400, 'invalid_body', `at most ${MAX_PHOTOS} photos per import`);
  }
  const big = files.find((f) => f.size > MAX_PHOTO_BYTES);
  if (big) return fail(413, 'payload_too_large', 'photos are limited to 40 MB');
  const photos = await Promise.all(
    files.map(async (f, i) => ({
      name: f instanceof File ? f.name : `photo-${i}`,
      bytes: new Uint8Array(await f.arrayBuffer()),
    })),
  );
  const mode = form.get('mode') === 'single' ? 'single' : 'multi';
  const rawCalibration = form.get('calibration');
  const calibration =
    typeof rawCalibration === 'string' && rawCalibration.trim()
      ? parseInput(
          CalibrationInputSchema,
          parseJsonField('calibration', rawCalibration),
          'calibration',
        )
      : null;
  const draft = await deps.drafts.create({ mode, calibration, photos });
  return json({ draft }, 201);
}
