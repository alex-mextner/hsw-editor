import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrototypeIndex } from './prototypes.ts';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hsw-protos-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const f32 = (values: number[]): Uint8Array => new Uint8Array(new Float32Array(values).buffer);

async function write(dir: string, options: { dinoRows: number | null }): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  const meta = {
    dim: 2,
    classes: ['a', 'b'],
    prototypes: 2,
    ...(options.dinoRows === null ? {} : { dinoDim: 3 }),
  };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify([{ classId: 'a' }, { classId: 'b' }]));
  await writeFile(join(dir, 'text.f32'), f32([1, 0, 0, 1]));
  await writeFile(join(dir, 'prototypes.f32'), f32([1, 0, 0, 1]));
  if (options.dinoRows !== null)
    await writeFile(
      join(dir, 'dino-prototypes.f32'),
      f32(Array.from({ length: options.dinoRows * 3 }, () => 0.5)),
    );
}

describe('loadPrototypeIndex', () => {
  test('reads the DINOv2 prototypes next to the CLIP ones', async () => {
    const dir = join(root, 'with');
    await write(dir, { dinoRows: 2 });
    const index = await loadPrototypeIndex(dir, ['a', 'b']);
    expect(index?.dinoDim).toBe(3);
    expect(index?.dinoProtos?.length).toBe(6);
  });

  test('an index without DINOv2 prototypes still loads (CLIP only)', async () => {
    const dir = join(root, 'without');
    await write(dir, { dinoRows: null });
    const index = await loadPrototypeIndex(dir, ['a', 'b']);
    expect(index).not.toBeNull();
    expect(index?.dinoProtos).toBeUndefined();
  });

  test('DINOv2 prototypes that do not match the manifest are reported and left out, CLIP stays', async () => {
    const dir = join(root, 'stale');
    await write(dir, { dinoRows: 1 });
    const warnings: string[] = [];
    const index = await loadPrototypeIndex(dir, ['a', 'b'], (m) => warnings.push(m));
    expect(index).not.toBeNull();
    expect(index?.dinoProtos).toBeUndefined();
    expect(warnings.join(' ')).toContain('DINOv2 retrieval is off');
  });
});
