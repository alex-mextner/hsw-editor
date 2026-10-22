/** `/api/draw/*`: backend status, settings, manual-upload inbox. Draw jobs go through the job runner. */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DrawError, parseDrawSettings } from '@hsw-editor/draw';
import { IMAGE_FILE_PATTERN, saveImage } from './image.ts';
import type { DrawRuntime } from './runtime.ts';
import { getBackendStatuses } from './status.ts';

export const MAX_UPLOAD_BYTES = 35 * 1024 * 1024;
const MANUAL_ID = /^[0-9a-f]{12}$/;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const errorResponse = (error: DrawError) =>
  json({ error: error.code, message: error.message }, error.code === 'invalid_request' ? 400 : 409);

/** Returns null when the path is not a draw route so the caller can continue routing. */
export function createDrawRoutes(runtime: DrawRuntime) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const { pathname } = url;
    if (!pathname.startsWith('/api/draw/')) return null;
    try {
      if (pathname === '/api/draw/backends' && request.method === 'GET') {
        const backends = await getBackendStatuses(runtime, {
          probe: url.searchParams.get('probe') === '1',
        });
        return json({ settings: await runtime.getSettings(), backends });
      }
      if (pathname === '/api/draw/settings') {
        if (request.method === 'GET') return json(await runtime.getSettings());
        if (request.method === 'PUT') {
          const settings = parseDrawSettings(await request.json().catch(() => null));
          await runtime.setSettings(settings);
          return json(settings);
        }
        return json({ error: 'method_not_allowed' }, 405);
      }
      const manual = /^\/api\/draw\/manual\/([^/]+)(\/inbox)?$/.exec(pathname);
      if (manual)
        return await manualRoute(runtime, request, manual[1] ?? '', manual[2] !== undefined);
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof DrawError) return errorResponse(error);
      throw error;
    }
  };
}

async function manualRoute(
  runtime: DrawRuntime,
  request: Request,
  id: string,
  inboxPath: boolean,
): Promise<Response> {
  if (!MANUAL_ID.test(id)) throw new DrawError('invalid_request', 'bad manual job id');
  const jobDir = join(runtime.paths.workDir, `manual-${id}`);
  const inbox = join(jobDir, 'inbox');
  const prompt = await readFile(join(jobDir, 'prompt.txt'), 'utf8').catch(() => null);
  if (prompt === null) return json({ error: 'not_found' }, 404);
  if (inboxPath && request.method === 'POST') {
    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_UPLOAD_BYTES) throw new DrawError('invalid_request', 'image too large');
    const bytes = await readBodyCapped(request, MAX_UPLOAD_BYTES);
    await mkdir(inbox, { recursive: true });
    // Time-ordered, collision-free name: concurrent uploads never overwrite each other.
    const stem = `upload-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const saved = await saveImage(inbox, stem, bytes).catch((error: unknown) => {
      if (error instanceof DrawError) throw new DrawError('invalid_request', error.message);
      throw error;
    });
    return json({ id, file: basename(saved.path), width: saved.width, height: saved.height }, 201);
  }
  if (!inboxPath && request.method === 'GET') {
    const files = await readdir(jobDir);
    const inboxFiles = await readdir(inbox).catch(() => []);
    return json({
      id,
      prompt: prompt.trim(),
      refs: files.filter((name) => name.startsWith('ref-')),
      uploaded: inboxFiles.filter((name) => IMAGE_FILE_PATTERN.test(name)).length,
    });
  }
  return json({ error: 'method_not_allowed' }, 405);
}

/** Read a request body, aborting as soon as it exceeds `limit` (chunked bodies carry no Content-Length). */
async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new DrawError('invalid_request', 'image too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
