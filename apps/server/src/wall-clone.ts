/**
 * Template walls and clones (docs/api.md#template-walls): `POST /api/walls/:id/clone` makes an independent copy of a wall (the web
 * app calls it on the first edit of a template wall), `PUT /api/walls/:id/template` marks or unmarks a wall as a template. Runs as a
 * module, so it sits behind the loopback/origin guard like every other route.
 */
import { ActorSchema, IdSchema, type Actor } from '@hsw-editor/core';
import { z } from 'zod';
import { errorResponse } from './api.ts';
import { HttpError } from './http-error.ts';
import type { ServerDeps, ServerModule } from './modules.ts';

const HUMAN: Actor = { kind: 'human' };
const ROUTE = /^\/api\/walls\/([^/]+)\/(clone|template)$/;

const CloneBody = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  id: IdSchema.optional(),
  actor: ActorSchema.optional(),
});
const TemplateBody = z.strictObject({ template: z.boolean() });

async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.output<S>> {
  const text = await request.text();
  let raw: unknown = {};
  try {
    if (text !== '') raw = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_body',
      'request body does not match the schema',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

async function handle(request: Request, deps: ServerDeps): Promise<Response | null> {
  const match = ROUTE.exec(new URL(request.url).pathname);
  const id = match?.[1];
  const action = match?.[2];
  if (id === undefined || action === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    throw new HttpError(400, 'invalid_id', 'malformed id in the path');
  }
  if (action === 'clone' && request.method === 'POST') {
    const body = await readBody(request, CloneBody);
    const source = await deps.store.get(decoded);
    const state = await deps.store.clone(
      decoded,
      { name: body.name ?? source.wall.name, id: body.id },
      body.actor ?? HUMAN,
    );
    return Response.json(state, { status: 201 });
  }
  if (action === 'template' && request.method === 'PUT') {
    const body = await readBody(request, TemplateBody);
    await deps.store.setTemplate(decoded, body.template);
    return Response.json({ ok: true, template: body.template });
  }
  return null;
}

export const wallCloneModule: ServerModule = {
  name: 'wall-clone',
  async handle(request, deps) {
    try {
      return await handle(request, deps);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
