import { describe, expect, test } from 'bun:test';
import { createEmptyWall, type Wall } from '@hsw-editor/core';
import { ApiError, NetworkError } from '@/api/http.ts';
import { cloneOf, copyName, forkApi, type WallBackend } from './fork.ts';

const wall: Wall = { ...createEmptyWall('demo', 'Demo wall'), rev: 7 };

function backend(clone: WallBackend['cloneWall']): { calls: string[]; backend: WallBackend } {
  const calls: string[] = [];
  const unused = (): never => {
    throw new Error('unused');
  };
  return {
    calls,
    backend: {
      listWalls: unused,
      createWall: unused,
      deleteWall: unused,
      history: unused,
      undo: unused,
      redo: unused,
      cloneWall: (source, input) => {
        calls.push(`clone ${source} -> ${input.id}`);
        return clone(source, input);
      },
      getWall: (id) => {
        calls.push(`get ${id}`);
        return Promise.resolve({ wall, canUndo: false, canRedo: false, warnings: [] });
      },
      applyOps: (id) => {
        calls.push(`ops ${id}`);
        return Promise.reject(new Error('not needed'));
      },
    },
  };
}

describe('cloneOf', () => {
  test('keeps the content under a new id and name with a fresh history', () => {
    const copy = cloneOf({ ...wall, items: [] }, 'mine', 'Mine');
    expect(copy).toMatchObject({ id: 'mine', name: 'Mine', rev: 0 });
    expect(copy.board).toEqual(wall.board);
  });
});

describe('forkApi', () => {
  const clone = { id: 'mine', name: 'Mine' };

  test('the copy is made once, before the first call that needs it is answered', async () => {
    const { calls, backend: service } = backend(() => Promise.resolve(wall));
    let created = 0;
    const fork = forkApi(service, 'demo', clone, () => (created += 1));
    await fork.getWall('mine');
    await fork.getWall('mine');
    expect(calls).toEqual(['clone demo -> mine', 'get mine', 'get mine']);
    expect(created).toBe(1);
  });

  test('a failed attempt (offline) is made again by the next call', async () => {
    let attempt = 0;
    const { calls, backend: service } = backend(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new NetworkError(new Error('down')))
        : Promise.resolve(wall);
    });
    const fork = forkApi(service, 'demo', clone, () => undefined);
    await expect(fork.getWall('mine')).rejects.toBeInstanceOf(NetworkError);
    await fork.getWall('mine');
    expect(calls.filter((call) => call.startsWith('clone'))).toHaveLength(2);
  });

  test('a copy that already exists under the fresh id is ours (the answer was lost)', async () => {
    const exists = new ApiError(409, 'wall_exists', 'taken', null);
    const { backend: service } = backend(() => Promise.reject(exists));
    let created = 0;
    const fork = forkApi(service, 'demo', clone, () => (created += 1));
    await fork.ready();
    expect(created).toBe(1);
  });

  test('any other refusal reaches the caller', async () => {
    const refused = new ApiError(403, 'forbidden', 'no', null);
    const { backend: service } = backend(() => Promise.reject(refused));
    const fork = forkApi(service, 'demo', clone, () => undefined);
    await expect(fork.ready()).rejects.toBe(refused);
  });
});

describe('copyName', () => {
  const label = (name: string): string => `${name} (copy)`;
  test('adds the suffix to a short name', () => {
    expect(copyName('Garage', label)).toBe('Garage (copy)');
  });
  test('cuts a name that would pass the 200-character limit with the suffix', () => {
    const named = copyName('x'.repeat(200), label);
    expect(named).toHaveLength(200);
    expect(named.endsWith(' (copy)')).toBe(true);
  });
});
