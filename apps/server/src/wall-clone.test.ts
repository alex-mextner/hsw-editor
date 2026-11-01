/** Template walls and clones: the store's `clone`/`setTemplate` and the module routes, against a real daemon on a temp data dir. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOp,
  type ApplyResponse,
  type ApiErrorBody,
  type WallResponse,
  type WallSummary,
} from '@hsw-editor/core';
import { wallCloneModule } from './wall-clone.ts';
import { startServer, type RunningServer } from './server.ts';

let running: RunningServer;
let root: string;
let base: string;

const json = { 'content-type': 'application/json' };

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });
}

async function addHolder(wall: string, id: string): Promise<void> {
  const op = parseOp({
    type: 'addItem',
    item: { id, kind: 'holder', bankId: 'hook', cell: { col: 2, row: 2 } },
  });
  const response = await post(`/api/walls/${wall}/ops`, { ops: [op] });
  expect(response.status).toBe(200);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-clone-'));
  const dist = join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, 'index.html'), '<html></html>');
  running = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home: join(root, 'home'),
      webDist: dist,
      allowedOrigins: [],
      heartbeatMs: 1000,
    },
    { modules: [wallCloneModule] },
  );
  base = running.url;
});

afterAll(async () => {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('template walls and clones', () => {
  test('a clone is an independent copy with its own history, and the source is untouched', async () => {
    await post('/api/walls', { name: 'Showcase', id: 'showcase' });
    await addHolder('showcase', 'a');
    await addHolder('showcase', 'b');

    const response = await post('/api/walls/showcase/clone', { name: 'My wall', id: 'mine' });
    expect(response.status).toBe(201);
    const clone = (await response.json()) as WallResponse;
    expect(clone.wall).toMatchObject({ id: 'mine', name: 'My wall', rev: 0 });
    expect(clone.wall.items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(clone.canUndo).toBe(false);

    await addHolder('mine', 'c');
    const undone = await post('/api/walls/mine/undo', {});
    const afterUndo = (await undone.json()) as ApplyResponse;
    expect(afterUndo.wall.items).toHaveLength(2);
    // Undo stops at the copy: nothing reaches back into the source.
    expect((await post('/api/walls/mine/undo', {})).status).toBe(409);

    const source = (await (await fetch(`${base}/api/walls/showcase`)).json()) as WallResponse;
    expect(source.wall.items.map((item) => item.id)).toEqual(['a', 'b']);
  });

  test('the clone takes the source name when none is given, and a taken id is refused', async () => {
    const response = await post('/api/walls/showcase/clone', {});
    const clone = (await response.json()) as WallResponse;
    expect(clone.wall.name).toBe('Showcase');
    expect(clone.wall.id).not.toBe('showcase');
    const again = await post('/api/walls/showcase/clone', { id: 'mine' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ApiErrorBody).error.code).toBe('wall_exists');
  });

  test('cloning a wall that does not exist is a 404', async () => {
    expect((await post('/api/walls/nope/clone', {})).status).toBe(404);
  });

  test('a template is marked in the list and in the wall, is kept in a file next to the wall, and the clone is not one', async () => {
    const mark = await fetch(`${base}/api/walls/showcase/template`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ template: true }),
    });
    expect(mark.status).toBe(200);
    expect(existsSync(join(root, 'home', 'walls', 'showcase', 'template'))).toBe(true);

    const list = (await (await fetch(`${base}/api/walls`)).json()) as { walls: WallSummary[] };
    expect(list.walls.find((wall) => wall.id === 'showcase')?.template).toBe(true);
    expect(list.walls.find((wall) => wall.id === 'mine')?.template).toBeUndefined();
    const wall = (await (await fetch(`${base}/api/walls/showcase`)).json()) as WallResponse & {
      template?: boolean;
    };
    expect(wall.template).toBe(true);

    const clone = (await (
      await post('/api/walls/showcase/clone', { id: 'from-template' })
    ).json()) as WallResponse & { template?: boolean };
    expect(clone.template).toBeUndefined();

    await fetch(`${base}/api/walls/showcase/template`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ template: false }),
    });
    expect(existsSync(join(root, 'home', 'walls', 'showcase', 'template'))).toBe(false);
  });

  test('a malformed template body is a 400', async () => {
    const response = await fetch(`${base}/api/walls/showcase/template`, {
      method: 'PUT',
      headers: json,
      body: JSON.stringify({ template: 'yes' }),
    });
    expect(response.status).toBe(400);
  });

  test('the asset files of the source are copied, and no half-made copy stays behind', async () => {
    await post('/api/walls', { name: 'With files', id: 'with-files' });
    const photos = join(root, 'home', 'walls', 'with-files', 'photos');
    await mkdir(photos, { recursive: true });
    await writeFile(join(photos, 'p1.jpg'), 'jpeg-bytes');
    const response = await post('/api/walls/with-files/clone', { id: 'with-files-copy' });
    expect(response.status).toBe(201);
    const copied = join(root, 'home', 'walls', 'with-files-copy', 'photos', 'p1.jpg');
    expect(await Bun.file(copied).text()).toBe('jpeg-bytes');

    const refused = await post('/api/walls/with-files/clone', { id: 'with-files-copy' });
    expect(refused.status).toBe(409);
    const walls = await readdir(join(root, 'home', 'walls'));
    expect(walls.filter((name) => name.startsWith('.clone-'))).toEqual([]);
  });

  test('a create and a clone of the same id at once: one wins, the other is refused', async () => {
    const [made, cloned] = await Promise.all([
      post('/api/walls', { name: 'Race', id: 'race-id' }),
      post('/api/walls/showcase/clone', { id: 'race-id' }),
    ]);
    expect([made.status, cloned.status].sort()).toEqual([201, 409]);
    const wall = (await (await fetch(`${base}/api/walls/race-id`)).json()) as WallResponse;
    expect(wall.wall.rev).toBe(0);
  });

  test('a malformed id in the path is a 400, not a server error', async () => {
    expect((await post('/api/walls/%E0/clone', {})).status).toBe(400);
  });

  test('two clones to one id at once: the second waits, then is told the wall exists, and the wall can be read', async () => {
    const [first, second] = await Promise.all([
      post('/api/walls/showcase/clone', { id: 'twice' }),
      post('/api/walls/showcase/clone', { id: 'twice' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect((await fetch(`${base}/api/walls/twice`)).status).toBe(200);
  });
});
