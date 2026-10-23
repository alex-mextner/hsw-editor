/** Mesh import: format sniffing, probing, normalisation to the wall frame, repair. Runs the real mesh tool. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bankPaths, type BankPaths } from '../paths.ts';
import { convertMesh, probeMesh, resolveSettings, sniffMesh, UserElementError } from './convert.ts';
import { boxes3mf, boxesStl, boxGlb, boxStl } from './meshfixtures.ts';

let work: string;
let paths: BankPaths;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'user-convert-'));
  // the python venv is shared (creating one per test would download the dependencies again)
  paths = { ...bankPaths(), cacheDir: join(work, 'cache'), userDir: join(work, 'user') };
  await mkdir(join(work, 'in'), { recursive: true });
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

async function write(name: string, bytes: Uint8Array): Promise<string> {
  const file = join(work, 'in', name);
  await Bun.write(file, bytes);
  return file;
}

describe('sniffMesh', () => {
  test('accepts binary STL, ASCII STL, GLB and 3MF by content', async () => {
    expect(sniffMesh(boxStl([10, 10, 10]), 'a.stl')).toBe('stl');
    expect(sniffMesh(new TextEncoder().encode('solid x\nendsolid x\n'), 'A.STL')).toBe('stl');
    expect(sniffMesh(await boxGlb([10, 10, 10], 0.001), 'a.glb')).toBe('glb');
    expect(sniffMesh(boxes3mf([{ size: [10, 10, 10] }]), 'a.3mf')).toBe('3mf');
  });

  test('refuses a renamed file and an unknown extension', async () => {
    expect(sniffMesh(boxStl([10, 10, 10]), 'a.glb')).toBeNull();
    expect(sniffMesh(await boxGlb([10, 10, 10], 0.001), 'a.stl')).toBeNull();
    expect(sniffMesh(new Uint8Array([1, 2, 3]), 'a.3mf')).toBeNull();
    expect(sniffMesh(boxStl([10, 10, 10]), 'a.obj')).toBeNull();
  });
});

describe('probe and convert', () => {
  test('an STL box is probed, normalised to the wall frame (z = 0 on the wall) and thumbnailed', async () => {
    const file = await write('box.stl', boxStl([40, 30, 20], { origin: [5, 5, 5] }));
    const probe = await probeMesh(paths, file);
    expect(probe.parts).toHaveLength(1);
    expect(probe.parts[0]?.watertight).toBe(true);
    expect(probe.parts[0]?.dimsMm).toEqual({ x: 40, y: 30, z: 20 });

    const settings = resolveSettings({ orient: { out: '+z', up: '+y' } }, probe);
    expect(settings).toMatchObject({
      partId: '0',
      anchor: 'back-bbox',
      unit: 'auto',
      repair: true,
    });
    const glb = join(work, 'out', 'box.glb');
    const thumbnail = join(work, 'out', 'box.webp');
    const result = await convertMesh(paths, {
      file,
      format: 'stl',
      partCount: 1,
      settings,
      grid: paths.grid,
      glb,
      thumbnail,
      color: '#4f7fb0',
      workDir: join(work, 'out'),
    });
    expect(result.watertight).toBe(true);
    expect(result.warnings.join(' ')).not.toContain('watertight');
    expect(result.bboxMm.min[2]).toBeCloseTo(0, 3);
    expect(result.bboxMm.max[2]).toBeCloseTo(20, 3);
    expect(result.cells.some(([c, r]) => c === 0 && r === 0)).toBe(true);
    expect((await Bun.file(glb).arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await Bun.file(thumbnail).arrayBuffer()).byteLength).toBeGreaterThan(100);
  }, 60_000);

  test('the orientation decides which axis becomes the depth', async () => {
    const file = await write('orient.stl', boxStl([40, 30, 20]));
    const probe = await probeMesh(paths, file);
    const depthOf = async (out: '+z' | '+x'): Promise<number> => {
      const result = await convertMesh(paths, {
        file,
        format: 'stl',
        partCount: 1,
        settings: resolveSettings({ orient: { out, up: '+y' } }, probe),
        grid: paths.grid,
        glb: join(work, 'out', `orient-${out}.glb`),
        color: '#4f7fb0',
        workDir: join(work, 'out'),
      });
      return result.bboxMm.max[2] - result.bboxMm.min[2];
    };
    expect(await depthOf('+z')).toBeCloseTo(20, 2);
    expect(await depthOf('+x')).toBeCloseTo(40, 2);
  }, 60_000);

  test('a glTF in metres is scaled to millimetres by the auto unit', async () => {
    const file = await write('metres.glb', await boxGlb([0.04, 0.03, 0.02], 1));
    const probe = await probeMesh(paths, file);
    expect(probe.parts[0]?.dimsMm.x).toBeCloseTo(40, 2);
    const asMm = await write('mm.glb', await boxGlb([40, 30, 20], 1));
    expect((await probeMesh(paths, asMm)).parts[0]?.dimsMm.x).toBeCloseTo(40, 2);
  }, 60_000);

  test('a 3MF with two objects lists both parts, biggest first; unknown parts are refused', async () => {
    const file = await write(
      'two.3mf',
      boxes3mf([{ size: [10, 10, 10] }, { size: [50, 40, 30], origin: [100, 0, 0] }]),
    );
    const probe = await probeMesh(paths, file);
    expect(probe.parts).toHaveLength(2);
    expect(probe.parts[0]?.dimsMm.x).toBe(50);
    expect(probe.defaultPartId).toBe(probe.parts[0]?.partId ?? '');
    expect(() => resolveSettings({ partId: 'nope' }, probe)).toThrow(UserElementError);
  }, 60_000);

  test('an open box is repaired in process; with repair off it stays not watertight and warns', async () => {
    const file = await write('open.stl', boxStl([40, 30, 20], { open: true }));
    const probe = await probeMesh(paths, file);
    expect(probe.parts[0]?.watertight).toBe(false);
    const base = {
      file,
      format: 'stl' as const,
      partCount: 1,
      grid: paths.grid,
      color: '#4f7fb0',
      workDir: join(work, 'out'),
    };
    const repaired = await convertMesh(paths, {
      ...base,
      glb: join(work, 'out', 'open-fixed.glb'),
      settings: resolveSettings({ orient: { out: '+z', up: '+y' } }, probe),
    });
    expect(repaired.watertight).toBe(true);
    expect(repaired.repaired).toBe(true);
    expect(repaired.warnings.join(' ')).toContain('repaired');
    const untouched = await convertMesh(paths, {
      ...base,
      glb: join(work, 'out', 'open-raw.glb'),
      settings: resolveSettings({ orient: { out: '+z', up: '+y' }, repair: false }, probe),
    });
    expect(untouched.watertight).toBe(false);
    expect(untouched.warnings.join(' ')).toContain('not watertight');
  }, 60_000);

  test('without GL the thumbnail comes from the software fallback and the import still works', async () => {
    const file = await write('nogl.stl', boxStl([40, 30, 20]));
    const probe = await probeMesh(paths, file);
    const thumbnail = join(work, 'out', 'nogl.webp');
    process.env.HSW_USER_MESH_NO_GL = '1';
    try {
      const result = await convertMesh(paths, {
        file,
        format: 'stl',
        partCount: 1,
        settings: resolveSettings({ orient: { out: '+z', up: '+y' } }, probe),
        grid: paths.grid,
        glb: join(work, 'out', 'nogl.glb'),
        thumbnail,
        color: '#4f7fb0',
        workDir: join(work, 'out'),
      });
      expect(result.thumbnailFallback).toBe(true);
      expect(result.warnings.join(' ')).toContain('software fallback');
      const head = new TextDecoder().decode((await Bun.file(thumbnail).arrayBuffer()).slice(0, 12));
      expect(head.startsWith('RIFF') && head.endsWith('WEBP')).toBe(true);
    } finally {
      delete process.env.HSW_USER_MESH_NO_GL;
    }
  }, 60_000);

  test('a file that is not a mesh is a 422, not a crash', async () => {
    const file = await write('garbage.stl', new TextEncoder().encode('solid broken\nnot a mesh\n'));
    const error = await probeMesh(paths, file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UserElementError);
    expect((error as UserElementError).status).toBe(422);
  }, 60_000);

  test('the `3d` repair is used for a mesh the in-process repair cannot close', async () => {
    // a stand-in `3d` that "repairs" by writing a good box: proves the hand-off and the re-conversion
    const good = await write('good.stl', boxStl([40, 30, 20]));
    const fake = join(work, 'fake-3d.sh');
    await Bun.write(fake, `#!/bin/sh\n# 3d mesh <file> --repair -o <out>\ncp "${good}" "$5"\n`);
    await chmod(fake, 0o755);
    // two boxes touching along one edge: non-manifold, so the in-process hole filling cannot close it
    const broken = await write(
      'edge.stl',
      boxesStl([{ size: [10, 10, 10] }, { size: [10, 10, 10], origin: [10, 10, 0] }]),
    );
    const probe = await probeMesh(paths, broken);
    const previous = process.env.HSW_3D_BIN;
    process.env.HSW_3D_BIN = fake;
    try {
      const result = await convertMesh(paths, {
        file: broken,
        format: 'stl',
        partCount: 1,
        settings: resolveSettings({ orient: { out: '+z', up: '+y' }, repair: true }, probe),
        grid: paths.grid,
        glb: join(work, 'out', 'ext.glb'),
        color: '#4f7fb0',
        workDir: join(work, 'out'),
      });
      expect(result.watertight).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HSW_3D_BIN;
      else process.env.HSW_3D_BIN = previous;
    }
  }, 60_000);
});
