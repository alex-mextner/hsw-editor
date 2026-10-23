import type { Actor, Board, Op, Wall } from '@hsw-editor/core';
import { z } from 'zod';
import {
  CreateWallResponseSchema,
  ErrorBodySchema,
  HistoryResponseSchema,
  PhotoUploadResponseSchema,
  OpResponseSchema,
  WallListSchema,
  WallResponseSchema,
  type HistoryEntry,
  type OpResponse,
  type WallResponse,
  type WallSummary,
} from './schemas.ts';
import { OFFLINE_COPY_HEADER } from '../pwa/cachePolicy.ts';

function tabName(): string {
  try {
    const stored = globalThis.sessionStorage?.getItem('hsw-editor.actor');
    if (stored) return stored;
    const name = `web-${Math.random().toString(36).slice(2, 6)}`;
    globalThis.sessionStorage?.setItem('hsw-editor.actor', name);
    return name;
  } catch {
    return 'web';
  }
}

/** Identity of this browser tab in history and SSE events; lets the tab recognise its own echoes. */
export const HUMAN: Actor = { kind: 'human', name: tabName() };

/** Failure of an API call, with the server's machine-readable code when there was a response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
  get isConflict(): boolean {
    return this.status === 409 && this.code === 'rev_conflict';
  }
}

/** The daemon is unreachable (offline, restarting). Distinct from an API refusal. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'NetworkError';
  }
}

/** Gateway statuses a dev proxy / reverse proxy answers with while the daemon is down or restarting. */
const GATEWAY_DOWN = new Set([502, 503, 504]);

/** Reachability reports of real API calls; the connection monitor (src/offline/runtime.ts) subscribes. */
export const reachability: { onReachable: () => void; onUnreachable: () => void } = {
  onReachable: () => undefined,
  onUnreachable: () => undefined,
};

/** The error for a non-2xx answer: the server's `{error}` body as `ApiError`, a dead gateway as `NetworkError`. */
function failureFor(status: number, json: unknown): ApiError | NetworkError {
  const parsed = ErrorBodySchema.safeParse(json);
  if (!parsed.success && GATEWAY_DOWN.has(status)) {
    reachability.onUnreachable();
    return new NetworkError(new Error(`HTTP ${status}`));
  }
  reachability.onReachable();
  return new ApiError(
    status,
    parsed.success ? parsed.data.error.code : 'http_error',
    parsed.success ? parsed.data.error.message : `HTTP ${status}`,
    json,
  );
}

/** JSON request failing with `ApiError`/`NetworkError`; the caller parses the body. */
export async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    // A request the caller cancelled says nothing about the daemon.
    if (init?.signal?.aborted) throw error;
    reachability.onUnreachable();
    throw new NetworkError(error);
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw failureFor(response.status, json);
  // An answer the worker made from its kept copy says nothing about the daemon.
  if (!response.headers.has(OFFLINE_COPY_HEADER)) reachability.onReachable();
  return json;
}

/** Bytes sent so far; `fetch` cannot report upload progress, so uploads go through XMLHttpRequest. */
export interface UploadProgress {
  readonly loaded: number;
  readonly total: number;
}

function uploadJson(
  path: string,
  body: FormData,
  onProgress: ((progress: UploadProgress) => void) | undefined,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.({ loaded: event.loaded, total: event.total });
    };
    xhr.onerror = () => {
      reachability.onUnreachable();
      reject(new NetworkError(new Error('upload failed')));
    };
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        reachability.onReachable();
        resolve(json);
      } else reject(failureFor(xhr.status, json));
    };
    xhr.send(body);
  });
}

async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  return schema.parse(await fetchJson(path, init));
}

function post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
  return request(path, schema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const wallPath = (id: string): string => `/api/walls/${encodeURIComponent(id)}`;

export const api = {
  async listWalls(): Promise<WallSummary[]> {
    return (await request('/api/walls', WallListSchema)).walls;
  },
  async createWall(input: { name: string; board?: Board }): Promise<Wall> {
    return (await post('/api/walls', { ...input, actor: HUMAN }, CreateWallResponseSchema)).wall;
  },
  getWall(id: string): Promise<WallResponse> {
    return request(wallPath(id), WallResponseSchema);
  },
  async deleteWall(id: string): Promise<void> {
    await request(wallPath(id), z.object({ ok: z.literal(true) }), { method: 'DELETE' });
  },
  applyOps(id: string, ops: readonly Op[], baseRev: number, label?: string): Promise<OpResponse> {
    return post(
      `${wallPath(id)}/ops`,
      { ops, baseRev, actor: HUMAN, ...(label === undefined ? {} : { label }) },
      OpResponseSchema,
    );
  },
  undo(id: string, baseRev?: number): Promise<OpResponse> {
    return post(
      `${wallPath(id)}/undo`,
      { actor: HUMAN, ...(baseRev === undefined ? {} : { baseRev }) },
      OpResponseSchema,
    );
  },
  redo(id: string, baseRev?: number): Promise<OpResponse> {
    return post(
      `${wallPath(id)}/redo`,
      { actor: HUMAN, ...(baseRev === undefined ? {} : { baseRev }) },
      OpResponseSchema,
    );
  },
  async history(id: string, since = 0, limit = 200): Promise<HistoryEntry[]> {
    return (
      await request(`${wallPath(id)}/history?since=${since}&limit=${limit}`, HistoryResponseSchema)
    ).entries;
  },
  /**
   * Uploads a photo; the server normalises it (EXIF rotation, HEIC/AVIF) and records it with an `addPhoto`
   * op, then answers with the new photo and the wall that contains it.
   */
  async uploadPhoto(
    id: string,
    file: File,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ readonly photoId: string; readonly wall: Wall }> {
    const form = new FormData();
    form.set('file', file);
    form.set('name', file.name);
    form.set('actor', JSON.stringify(HUMAN));
    const json = await uploadJson(`${wallPath(id)}/photos`, form, onProgress);
    const parsed = PhotoUploadResponseSchema.parse(json);
    return { photoId: parsed.photo.id, wall: parsed.wall };
  },
  photoUrl: (id: string, photoId: string): string =>
    `${wallPath(id)}/photos/${encodeURIComponent(photoId)}/file`,
  modelUrl: (id: string, modelId: string): string =>
    `${wallPath(id)}/models/${encodeURIComponent(modelId)}/file`,
  exportUrl: (id: string): string => `${wallPath(id)}/export`,
  eventsUrl: (id: string): string => `${wallPath(id)}/events`,
};
