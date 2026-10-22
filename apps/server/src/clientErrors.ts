/**
 * Client error log: the browser reports load/render failures to `POST /api/client-errors`, one JSONL line each in
 * `<home>/logs/client-errors.jsonl` (rotated to `.1` at a size cap); `GET` reads the newest back. Contract: docs/api.md.
 * Runs as a module, so it sits behind the loopback/origin guard like every other route.
 */
import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatIssues } from '@hsw-editor/core';
import { z } from 'zod';
import { SerialQueue } from './serial-queue.ts';
import { errorBody } from './api.ts';
import type { ServerDeps, ServerModule } from './modules.ts';

export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const LOG_NAME = 'client-errors.jsonl';

const KINDS = ['asset-load', 'render', 'unhandled', 'user-report'] as const;

/** Caps for free-text fields; longer values are truncated (a report with a long stack is still worth keeping). */
const CAPS = {
  message: 2000,
  url: 500,
  stack: 4000,
  userAgent: 300,
  page: 500,
  bankId: 200,
} as const;
type TextField = keyof typeof CAPS;
const TEXT_FIELDS = Object.keys(CAPS) as TextField[];
const DETAIL_KEY_CAP = 100;
const DETAIL_VALUE_CAP = 500;
const NO_STORE = { 'cache-control': 'no-store' };

const BodySchema = z.object({
  kind: z.enum(KINDS),
  message: z.string().min(1),
  ts: z.iso.datetime({ offset: true }),
  url: z.string().optional(),
  bankId: z.string().optional(),
  status: z.number().int().optional(),
  stack: z.string().optional(),
  page: z.string().optional(),
  userAgent: z.string().optional(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type ClientErrorEntry = z.output<typeof BodySchema>;

/**
 * Removes `?query` / `#fragment` runs (they can carry tokens) from any text: URLs and relative paths glued to a
 * query, and detached `?key=value` runs. Deliberately blunt: it also eats trailing punctuation or `:line:col`
 * after a query.
 */
function scrubText(value: string): string {
  return value.replace(/(?<=\S)[?#]\S+|[?#]\S*=\S*/g, '');
}

function limitText(value: string, cap: number): string {
  const scrubbed = scrubText(value);
  return scrubbed.length > cap ? scrubbed.slice(0, cap) : scrubbed;
}

function sanitize(entry: ClientErrorEntry): ClientErrorEntry {
  const clean: ClientErrorEntry = { ...entry };
  for (const field of TEXT_FIELDS) {
    const value = entry[field];
    if (value !== undefined) clean[field] = limitText(value, CAPS[field]);
  }
  if (entry.detail !== undefined) {
    clean.detail = Object.fromEntries(
      Object.entries(entry.detail).map(([key, value]) => [
        limitText(key, DETAIL_KEY_CAP),
        typeof value === 'string' ? limitText(value, DETAIL_VALUE_CAP) : value,
      ]),
    );
  }
  // Scrubbing can empty a message that was only a query; keep it readable back (the schema requires min 1).
  if (clean.message === '') clean.message = '(scrubbed)';
  return clean;
}

function fail(status: number, code: string, message: string, details?: unknown): Response {
  return Response.json(errorBody(code, message, details), {
    status,
    headers: NO_STORE,
  });
}

/** Reads at most `limit` bytes; null when the body is larger (stops reading at the cap). */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A torn line (crash mid-append) or a foreign one is skipped, not fatal. */
function parseLine(line: string): ClientErrorEntry | null {
  if (line === '') return null;
  try {
    const parsed = BodySchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return '';
    throw error;
  }
}

export interface ClientErrorLogOptions {
  /** Rotate to `<file>.1` once appending would grow the file past this many bytes. */
  readonly maxLogBytes?: number;
}

export function createClientErrorsModule(options: ClientErrorLogOptions = {}): ServerModule {
  const maxLogBytes = options.maxLogBytes ?? MAX_LOG_BYTES;
  // One in-process writer: appends and reads run in submission order, so lines never interleave.
  const queue = new SerialQueue();

  async function append(dir: string, entry: ClientErrorEntry): Promise<void> {
    const file = join(dir, LOG_NAME);
    const line = `${JSON.stringify(entry)}\n`;
    await mkdir(dir, { recursive: true });
    let size = await stat(file).then(
      (info) => info.size,
      (error: unknown) => {
        if (isMissing(error)) return 0;
        throw error;
      },
    );
    if (size > 0 && size + Buffer.byteLength(line) > maxLogBytes) {
      await rename(file, `${file}.1`);
      size = 0;
    }
    // A crash mid-append leaves a line without its newline; terminate it so this entry is not glued onto it.
    const torn =
      size > 0 &&
      (await Bun.file(file)
        .slice(size - 1, size)
        .text()) !== '\n';
    await appendFile(file, torn ? `\n${line}` : line);
  }

  /** Newest `limit` valid entries, oldest first. Reads each file whole (<= cap) but parses only from the end. */
  async function tail(dir: string, limit: number): Promise<ClientErrorEntry[]> {
    const file = join(dir, LOG_NAME);
    const found: ClientErrorEntry[] = [];
    for (const path of [file, `${file}.1`]) {
      const lines = (await readIfExists(path)).split('\n');
      for (let index = lines.length - 1; index >= 0 && found.length < limit; index--) {
        const entry = parseLine(lines[index] ?? '');
        if (entry !== null) found.push(entry);
      }
      if (found.length >= limit) break;
    }
    return found.reverse();
  }

  async function respond(request: Request, deps: ServerDeps): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== '/api/client-errors') return null;
    const dir = join(deps.config.home, 'logs');

    if (request.method === 'POST') {
      const text = await readLimited(request, MAX_BODY_BYTES);
      if (text === null)
        return fail(413, 'payload_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return fail(400, 'invalid_json', 'request body is not valid JSON');
      }
      const parsed = BodySchema.safeParse(raw);
      if (!parsed.success)
        return fail(
          400,
          'invalid_body',
          'request body does not match the schema',
          formatIssues(parsed.error),
        );
      await queue.run(() => append(dir, sanitize(parsed.data)));
      return new Response(null, { status: 204, headers: NO_STORE });
    }

    if (request.method === 'GET') {
      const param = url.searchParams.get('limit');
      const requested = param === null ? DEFAULT_LIMIT : Number(param);
      if (!Number.isInteger(requested) || requested < 1)
        return fail(400, 'invalid_query', 'limit must be a positive integer');
      const entries = await queue.run(() => tail(dir, Math.min(requested, MAX_LIMIT)));
      return Response.json({ entries }, { headers: NO_STORE });
    }

    return fail(405, 'method_not_allowed', `no route ${request.method} ${url.pathname}`);
  }

  return {
    name: 'client-errors',
    async handle(request, deps) {
      try {
        return await respond(request, deps);
      } catch (error) {
        // Disk or stream failures: same envelope as the core API, never Bun's bare 500 page.
        console.error('hsw-editor: client-errors failed', error);
        return fail(500, 'internal', 'internal error');
      }
    },
  };
}

export const clientErrorsModule = createClientErrorsModule();
