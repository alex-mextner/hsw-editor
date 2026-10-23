/** `GET|PUT /api/settings` and the `settings` change stream. Contract: docs/api.md, "Settings". */
import {
  parseSettingsPutBody,
  SETTINGS_MAX_BYTES,
  type SettingsChangedEvent,
} from '@hsw-editor/user-settings';
import { HttpError } from './http-error.ts';
import type { SettingsStore } from './settings.ts';
import { sseResponse } from './sse.ts';

/** Reads the body up to `SETTINGS_MAX_BYTES`; aborts the read as soon as the cap is exceeded. */
async function readCappedText(request: Request): Promise<string> {
  const tooLarge = new HttpError(
    413,
    'payload_too_large',
    `request body exceeds ${SETTINGS_MAX_BYTES} bytes`,
  );
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > SETTINGS_MAX_BYTES) throw tooLarge;
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SETTINGS_MAX_BYTES) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** `rest` = path segments after `settings`. Returns null for unknown routes (the caller answers 404). */
export async function settingsRoutes(
  request: Request,
  rest: readonly string[],
  settings: SettingsStore,
  heartbeatMs: number,
): Promise<Response | null> {
  const method = request.method;
  if (rest.length === 0 && method === 'GET') return Response.json(await settings.get());
  if (rest.length === 0 && method === 'PUT') {
    const text = await readCappedText(request);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
    }
    return Response.json(await settings.put(parseSettingsPutBody(raw)));
  }
  if (rest.length === 1 && rest[0] === 'events' && method === 'GET') {
    return sseResponse(request, {
      heartbeat: { everyMs: heartbeatMs, event: 'heartbeat', data: () => ({}) },
      start: async (sink) => {
        const send = (rev: number): void =>
          sink.send('settings', { rev } satisfies SettingsChangedEvent);
        // Subscribe first so a PUT landing between the two steps is still announced (a repeated rev is harmless).
        const unsubscribe = settings.subscribe((document) => send(document.rev));
        try {
          send((await settings.get()).rev);
        } catch (error) {
          unsubscribe();
          throw error;
        }
        return unsubscribe;
      },
    });
  }
  return null;
}
