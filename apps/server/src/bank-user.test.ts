/** `/api/bank/user/*` + the `bank.user.import` job on the real daemon (temp data home, real mesh tool). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BankElement, BankIndex, Conversion, Upload, UserElementMeta } from '@hsw-editor/bank';
import { bankPaths, createBankHandler } from '@hsw-editor/bank/node';
import { startServer, type RunningServer } from './server.ts';

let root: string;
let home: string;
let running: RunningServer;
let savedEnv: Record<string, string | undefined>;

/** A closed 40 x 30 x 20 mm binary STL box. */
function boxStl(w: number, d: number, h: number): Uint8Array {
  const v = (x: number, y: number, z: number): [number, number, number] => [x * w, y * d, z * h];
  const quad = (a: number[], b: number[], c: number[], e: number[]): number[][][] => [
    [a, b, c],
    [a, c, e],
  ];
  const corner = (i: number): [number, number, number] => v(i & 1, (i >> 1) & 1, (i >> 2) & 1);
  const faces: number[][][] = [
    ...quad(corner(0), corner(2), corner(3), corner(1)),
    ...quad(corner(4), corner(5), corner(7), corner(6)),
    ...quad(corner(0), corner(1), corner(5), corner(4)),
    ...quad(corner(2), corner(6), corner(7), corner(3)),
    ...quad(corner(0), corner(4), corner(6), corner(2)),
    ...quad(corner(1), corner(3), corner(7), corner(5)),
  ];
  const out = new Uint8Array(84 + faces.length * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, faces.length, true);
  for (const [i, tri] of faces.entries())
    for (const [k, p] of tri.entries())
      for (let c = 0; c < 3; c++)
        view.setFloat32(84 + i * 50 + 12 + k * 12 + c * 4, p[c] ?? 0, true);
  return out;
}

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${running.url}${path}`, init);

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function uploadForm(bytes: Uint8Array, name: string): FormData {
  const form = new FormData();
  form.set('file', new File([bytes], name));
  return form;
}

async function upload(bytes: Uint8Array, name: string): Promise<Upload> {
  const response = await api('/api/bank/user/uploads', {
    method: 'POST',
    body: uploadForm(bytes, name),
  });
  expect(response.status).toBe(201);
  return (await body<{ upload: Upload }>(response)).upload;
}

interface JobBody {
  job: {
    id: string;
    state: string;
    result?: { element: BankElement; conversion: Conversion };
    error?: string;
  };
}

async function runImport(input: object): Promise<JobBody['job']> {
  const submit = await api('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'bank.user.import', input }),
  });
  expect(submit.status).toBe(202);
  const { job } = await body<JobBody>(submit);
  // the event stream closes after the terminal state: awaiting its end is awaiting the job
  await (await api(`/api/jobs/${job.id}/events`)).text();
  return (await body<JobBody>(await api(`/api/jobs/${job.id}`))).job;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-bank-user-'));
  home = join(root, 'home');
  // an ambient override would point the daemon away from the temp data home
  savedEnv = {
    HSW_BANK_DIR: process.env['HSW_BANK_DIR'],
    HSW_BANK_USER_DIR: process.env['HSW_BANK_USER_DIR'],
  };
  delete process.env['HSW_BANK_DIR'];
  delete process.env['HSW_BANK_USER_DIR'];
  running = await startServer({
    port: 0,
    host: '127.0.0.1',
    home,
    webDist: join(root, 'dist'),
    allowedOrigins: [],
    heartbeatMs: 1000,
  });
});

afterAll(async () => {
  await running.stop();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('uploads and previews', () => {
  test('rejects what is not a multipart STL/GLB/3MF', async () => {
    expect((await api('/api/bank/user/uploads', { method: 'POST', body: '{}' })).status).toBe(415);
    const wrong = await api('/api/bank/user/uploads', {
      method: 'POST',
      body: uploadForm(new TextEncoder().encode('hello'), 'notes.txt'),
    });
    expect(wrong.status).toBe(415);
    expect((await body<{ error: { code: string } }>(wrong)).error.code).toBe(
      'unsupported_media_type',
    );
    const empty = await api('/api/bank/user/uploads', { method: 'POST', body: new FormData() });
    expect(empty.status).toBe(400);
    expect((await api('/api/bank/user/uploads/not-an-id', { method: 'DELETE' })).status).toBe(400);
    expect(
      (await api('/api/bank/user/uploads/up-abcdefgh1234/preview', { method: 'POST', body: '{}' }))
        .status,
    ).toBe(404);
  });

  test('upload -> preview returns a conversion and a fetchable GLB; bad settings are 400', async () => {
    const up = await upload(boxStl(40, 30, 20), 'Test holder.stl');
    expect(up.parts[0]?.dimsMm).toEqual({ x: 40, y: 30, z: 20 });
    const preview = await api(`/api/bank/user/uploads/${up.id}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orient: { out: '+z', up: '+y' } }),
    });
    expect(preview.status).toBe(200);
    const { conversion } = await body<{ conversion: Conversion }>(preview);
    expect(conversion.dimsMm).toEqual({ x: 40, y: 30, z: 20 });
    expect(conversion.footprint.length).toBeGreaterThan(0);
    const glb = await api(conversion.glbUrl);
    expect(glb.status).toBe(200);
    expect(new TextDecoder().decode((await glb.arrayBuffer()).slice(0, 4))).toBe('glTF');
    const bad = await api(`/api/bank/user/uploads/${up.id}/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orient: { out: '+z', up: '+z' } }),
    });
    expect(bad.status).toBe(400);
    expect((await api(`/api/bank/user/uploads/${up.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await api(conversion.glbUrl)).status).toBe(404);
  }, 60_000);
});

describe('import job, bank index, edit, delete', () => {
  test('an imported element is in the bank index, assets, search and the user routes; it survives a fresh handler', async () => {
    const before = await api('/api/bank/index');
    const beforeHash = (await body<BankIndex>(before)).contentHash;
    const up = await upload(boxStl(60, 25, 25), 'Pliers rack.stl');
    const job = await runImport({
      uploadId: up.id,
      name: { ru: 'Стойка для плоскогубцев', en: 'Pliers rack' },
      category: 'holders/pliers',
      tags: { ru: ['стойка'], en: ['rack', 'mine'] },
      fitsTool: [{ toolClass: 'pliers', capacity: 3 }],
      settings: { orient: { out: '+z', up: '+y' } },
    });
    expect(job.state).toBe('succeeded');
    const element = job.result?.element;
    expect(element?.id).toBe('my-pliers-rack');

    // the very next index request already has it (no 500 ms staleness window)
    const indexResponse = await api('/api/bank/index');
    const index = await body<BankIndex>(indexResponse);
    expect(index.contentHash).not.toBe(beforeHash);
    expect(indexResponse.headers.get('etag')).toBe(`"${index.contentHash}"`);
    const mine = index.elements.find((e) => e.id === 'my-pliers-rack');
    expect(mine?.source).toBe('user');
    expect(index.elements.filter((e) => e.source !== 'user').length).toBeGreaterThan(50);

    const glb = await api(`/bank/assets/${mine?.assets.lod0.path}`);
    expect(glb.status).toBe(200);
    expect(
      (await api(`/bank/assets/${mine?.assets.thumbnail.path}`)).headers.get('content-type'),
    ).toContain('image/webp');
    const search = await body<{ results: { id: string }[] }>(await api('/api/bank/search?q=rack'));
    expect(search.results.map((r) => r.id)).toContain('my-pliers-rack');

    const list = await body<{ elements: BankElement[] }>(await api('/api/bank/user/elements'));
    expect(list.elements.map((e) => e.id)).toEqual(['my-pliers-rack']);
    const one = await body<{ element: BankElement; meta: UserElementMeta }>(
      await api('/api/bank/user/elements/my-pliers-rack'),
    );
    expect(one.meta).toMatchObject({
      originalName: 'Pliers rack.stl',
      format: 'stl',
      watertight: true,
    });
    expect((await api('/api/bank/user/elements/my-ghost')).status).toBe(404);
    expect((await api('/api/bank/user/elements/Bad_Id')).status).toBe(400);

    // a process restart reads the same tree from disk
    const paths = bankPaths({ ...process.env, HSW_EDITOR_HOME: home });
    const fresh = createBankHandler({ paths, userRoot: paths.userDir, revalidateMs: 0 });
    const reloaded = await body<BankIndex>(
      (await fresh(new Request('http://localhost/api/bank/index'))) ?? new Response('null'),
    );
    expect(reloaded.elements.some((e) => e.id === 'my-pliers-rack' && e.source === 'user')).toBe(
      true,
    );
  }, 90_000);

  test('a job with a bad input is a 400; a vanished upload fails the job with a message', async () => {
    const bad = await api('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'bank.user.import',
        input: { name: { en: 'x' }, category: 'holders' },
      }),
    });
    expect(bad.status).toBe(400);
    const gone = await runImport({
      uploadId: 'up-doesnotexist1',
      name: { en: 'Ghost' },
      category: 'holders',
    });
    expect(gone.state).toBe('failed');
    expect(gone.error).toContain('does not exist');
  });

  test('PATCH edits metadata; delete is refused while a wall uses the element and allowed with force', async () => {
    const patch = await api('/api/bank/user/elements/my-pliers-rack', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: { en: 'Pliers stand' }, tags: { ru: [], en: ['stand'] } }),
    });
    expect(patch.status).toBe(200);
    const patched = (await body<{ element: BankElement }>(patch)).element;
    expect(patched.name.en).toBe('Pliers stand');
    const index = await body<BankIndex>(await api('/api/bank/index'));
    expect(index.elements.find((e) => e.id === 'my-pliers-rack')?.name.en).toBe('Pliers stand');
    const invalid = await api('/api/bank/user/elements/my-pliers-rack', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'no/such' }),
    });
    expect(invalid.status).toBe(400);
    const unknownField = await api('/api/bank/user/elements/my-pliers-rack', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dimsMm: { x: 1, y: 1, z: 1 } }),
    });
    expect(unknownField.status).toBe(400);

    await api('/api/walls', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Garage', id: 'garage' }),
    });
    const placed = await api('/api/walls/garage/ops', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ops: [
          {
            type: 'addItem',
            item: { kind: 'holder', bankId: 'my-pliers-rack', cell: { col: 4, row: 3 } },
          },
        ],
      }),
    });
    expect(placed.status).toBe(200);
    const refused = await api('/api/bank/user/elements/my-pliers-rack', { method: 'DELETE' });
    expect(refused.status).toBe(409);
    const refusal = await body<{
      error: { code: string; details: { walls: { wallId: string; items: number }[] } };
    }>(refused);
    expect(refusal.error.code).toBe('element_in_use');
    expect(refusal.error.details.walls).toEqual([{ wallId: 'garage', items: 1 }]);
    expect((await api('/api/bank/elements/my-pliers-rack')).status).toBe(200);

    const forced = await api('/api/bank/user/elements/my-pliers-rack?force=1', {
      method: 'DELETE',
    });
    expect(forced.status).toBe(200);
    const after = await body<BankIndex>(await api('/api/bank/index'));
    expect(after.elements.some((e) => e.id === 'my-pliers-rack')).toBe(false);
    expect((await api('/api/bank/elements/my-pliers-rack')).status).toBe(404);
    expect((await api('/api/bank/user/elements/my-pliers-rack', { method: 'DELETE' })).status).toBe(
      404,
    );
  }, 60_000);

  test('reopen hands back an upload and the current metadata for the edit dialog', async () => {
    const up = await upload(boxStl(35, 35, 15), 'Tray.stl');
    const created = await runImport({
      uploadId: up.id,
      name: { en: 'Tray' },
      category: 'accessories',
      settings: { orient: { out: '+z', up: '+y' } },
    });
    expect(created.state).toBe('succeeded');
    const id = created.result?.element.id ?? '';
    const reopened = await api(`/api/bank/user/elements/${id}/reopen`, { method: 'POST' });
    expect(reopened.status).toBe(201);
    const { upload: again, input } = await body<{
      upload: Upload;
      input: { replaceId: string; uploadId: string };
    }>(reopened);
    expect(input).toMatchObject({ replaceId: id, uploadId: again.id });
    const replaced = await runImport({ ...input, settings: { orient: { out: '+x', up: '+y' } } });
    expect(replaced.state).toBe('succeeded');
    expect(replaced.result?.element.id).toBe(id);
    expect(replaced.result?.element.dimsMm.z).toBe(35);
  }, 90_000);
});
