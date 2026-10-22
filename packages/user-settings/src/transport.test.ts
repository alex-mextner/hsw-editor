import { describe, expect, test } from 'bun:test';
import type { SettingsDocument } from './contract.ts';
import { createHttpTransport, SettingsRejectedError } from './transport.ts';

const doc: SettingsDocument = {
  schema: 1,
  rev: 3,
  updatedAt: '2026-10-22T00:00:00.000Z',
  data: { a: 1 },
};
const respond = (status: number, body: object) => () =>
  Promise.resolve(Response.json(body, { status }));

describe('http transport', () => {
  test('get parses the document', async () => {
    const transport = createHttpTransport({ fetch: respond(200, doc), baseUrl: 'http://x' });
    expect(await transport.get()).toEqual(doc);
  });

  test('put: 200 ok, 409 conflict, 400/413 rejected, 5xx throws', async () => {
    const body = { data: { a: 1 } };
    expect(await createHttpTransport({ fetch: respond(200, doc) }).put(body)).toEqual({
      kind: 'ok',
      document: doc,
    });
    const conflict = {
      error: { code: 'rev_conflict', message: 'm' },
      settings: doc,
      currentRev: 3,
    };
    expect(await createHttpTransport({ fetch: respond(409, conflict) }).put(body)).toEqual({
      kind: 'conflict',
      document: doc,
    });
    const refused = createHttpTransport({
      fetch: respond(413, { error: { code: 'payload_too_large', message: 'big' } }),
    });
    await expect(refused.put(body)).rejects.toBeInstanceOf(SettingsRejectedError);
    const failing = createHttpTransport({ fetch: respond(500, {}) });
    await expect(failing.put(body)).rejects.not.toBeInstanceOf(SettingsRejectedError);
    const offline = createHttpTransport({ fetch: () => Promise.reject(new Error('net')) });
    await expect(offline.get()).rejects.toThrow('net');
  });

  test('an unusable server document is an error, not data', async () => {
    const transport = createHttpTransport({ fetch: respond(200, { schema: 7 }) });
    await expect(transport.get()).rejects.toThrow('unusable');
  });
});
