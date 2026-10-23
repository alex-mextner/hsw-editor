/** The user element store: upload -> preview -> import -> edit -> remove, verified with the bank verifier. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bankPaths, type BankPaths } from '../paths.ts';
import { verifyBank } from '../verify.ts';
import { UserElementError } from './convert.ts';
import { boxesStl, boxStl, converterAvailable } from './meshfixtures.ts';
import { createUserBank, fillName, slugifyName, type UserBank } from './store.ts';

let work: string;
let paths: BankPaths;
let bank: UserBank;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'user-store-'));
  paths = { ...bankPaths(), cacheDir: join(work, 'cache'), userDir: join(work, 'user') };
  await mkdir(work, { recursive: true });
  bank = createUserBank(paths, { orphanGraceMs: 0 });
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

async function expectError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(UserElementError);
  expect((error as UserElementError).status).toBe(status);
  expect((error as UserElementError).code).toBe(code);
}

describe('names and ids', () => {
  test('ids are kebab-case with the my- prefix, Cyrillic is transliterated', () => {
    expect(slugifyName('Держатель отвёрток 6x')).toBe('my-derzhatel-otvertok-6x');
    expect(slugifyName('  Hook / M3!! ')).toBe('my-hook-m3');
    expect(slugifyName('???')).toBe('my-element');
  });

  test('a name in one language is mirrored into the other', () => {
    expect(fillName({ en: 'Hook' })).toEqual({ ru: 'Hook', en: 'Hook' });
    expect(fillName({ ru: 'Крюк', en: ' ' })).toEqual({ ru: 'Крюк', en: 'Крюк' });
  });
});

describe('uploads', () => {
  test('a file that is not an STL, GLB or 3MF is refused with 415 and leaves nothing behind', async () => {
    await expectError(
      bank.createUpload(new Uint8Array([1, 2, 3, 4]), 'x.stl'),
      415,
      'unsupported_media_type',
    );
    expect(await readdir(join(paths.userDir, 'uploads')).catch(() => [])).toEqual([]);
  });

  test.skipIf(!converterAvailable)(
    'an upload is probed once, previewed per settings (cached) and can be deleted',
    async () => {
      const upload = await bank.createUpload(boxStl([40, 30, 20]), 'my_box-holder.stl');
      expect(upload).toMatchObject({ format: 'stl', suggestedName: 'my box holder' });
      expect(upload.parts[0]?.dimsMm).toEqual({ x: 40, y: 30, z: 20 });
      const first = await bank.previewUpload(upload.id, { orient: { out: '+z', up: '+y' } });
      expect(first.glbUrl).toMatch(
        new RegExp(`^/api/bank/user/uploads/${upload.id}/preview/[0-9a-f]{16}\\.glb$`),
      );
      const file = bank.previewFile(
        upload.id,
        first.glbUrl.split('/').pop()?.replace('.glb', '') ?? '',
      );
      expect(file && (await Bun.file(file).exists())).toBe(true);
      const again = await bank.previewUpload(upload.id, { orient: { out: '+z', up: '+y' } });
      expect(again).toEqual(first);
      expect(await bank.deleteUpload(upload.id)).toBe(true);
      await expectError(bank.previewUpload(upload.id, undefined), 404, 'upload_not_found');
      expect(bank.previewFile('../etc', '0123456789abcdef')).toBeNull();
    },
    90_000,
  );
});

describe.skipIf(!converterAvailable)('import, edit, remove', () => {
  test('imports a verified user element: assets, sidecar, original, index', async () => {
    const upload = await bank.createUpload(boxStl([40, 30, 20]), 'Box.stl');
    const steps: string[] = [];
    const { element } = await bank.importElement(
      {
        uploadId: upload.id,
        name: { ru: 'Коробка', en: 'Box' },
        category: 'holders/screwdrivers',
        tags: { ru: ['коробка'], en: ['box'] },
        fitsTool: [
          { toolClass: 'screwdriver', dims: { shaftDiameter: { min: 3, max: 8 } }, capacity: 4 },
        ],
        settings: { orient: { out: '+z', up: '+y' } },
      },
      { progress: (m) => steps.push(m) },
    );
    expect(steps).toEqual(['converting', 'compressing', 'publishing']);
    expect(element).toMatchObject({
      id: 'my-box',
      source: 'user',
      generated: false,
      toolClasses: ['screwdriver'],
      mounting: { kind: 'hex-plug' },
      license: { redistributable: false },
      provenance: { origin: 'user-upload', orientation: 'curated' },
    });
    expect(element.dimsMm).toEqual({ x: 40, y: 30, z: 20 });
    expect(element.footprint.cells.some((c) => c.dCol === 0 && c.dRow2 === 0)).toBe(true);

    // the user tree is a valid bank: full verification (hashes, GLB bounds == bboxMm) passes
    const check = await verifyBank(paths.userDir);
    expect(check.problems).toEqual([]);
    expect(check.index?.elements.map((e) => e.id)).toEqual(['my-box']);

    const record = await bank.get('my-box');
    expect(record?.meta).toMatchObject({
      originalName: 'Box.stl',
      format: 'stl',
      watertight: true,
    });
    expect(await Bun.file(join(paths.userDir, 'sources/my-box/original.stl')).exists()).toBe(true);
    expect(await Bun.file(join(paths.userDir, 'uploads', upload.id)).exists()).toBe(false);
  }, 90_000);

  test('the same geometry twice is a 409 naming the existing element', async () => {
    const upload = await bank.createUpload(boxStl([40, 30, 20]), 'Box copy.stl');
    const error = await bank
      .importElement({
        uploadId: upload.id,
        name: { en: 'Box again' },
        category: 'holders',
        settings: { orient: { out: '+z', up: '+y' } },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(UserElementError);
    expect((error as UserElementError).code).toBe('duplicate_element');
    expect((error as UserElementError).details).toEqual({ id: 'my-box' });
  }, 90_000);

  test('a name clash gets a numeric suffix; an explicit clashing id is refused', async () => {
    const upload = await bank.createUpload(boxStl([30, 30, 30]), 'cube.stl');
    const { element } = await bank.importElement({
      uploadId: upload.id,
      name: { en: 'Box' },
      category: 'holders',
      settings: { orient: { out: '+z', up: '+y' } },
    });
    expect(element.id).toBe('my-box-2');
    const second = await bank.createUpload(boxStl([30, 30, 31]), 'cube2.stl');
    await expectError(
      bank.importElement({
        uploadId: second.id,
        id: 'my-box',
        name: { en: 'Other' },
        category: 'holders',
        settings: { orient: { out: '+z', up: '+y' } },
      }),
      409,
      'element_exists',
    );
  }, 90_000);

  test('footprint and mounting overrides are validated against each other', async () => {
    const upload = await bank.createUpload(boxStl([20, 20, 20]), 'small.stl');
    const base = {
      uploadId: upload.id,
      name: { en: 'Small' },
      category: 'holders',
      settings: { orient: { out: '+z' as const, up: '+y' as const } },
    };
    await expectError(
      bank.importElement({
        ...base,
        footprint: [{ dCol: 0, dRow2: 0 }],
        mounting: { kind: 'hex-plug', cells: [{ dCol: 1, dRow2: 1 }] },
      }),
      400,
      'invalid_body',
    );
    await expectError(
      bank.importElement({ ...base, footprint: [{ dCol: 1, dRow2: 1 }] }),
      400,
      'invalid_body',
    );
    const { element } = await bank.importElement({
      ...base,
      footprint: [
        { dCol: 0, dRow2: 0 },
        { dCol: 0, dRow2: 2 },
      ],
      mounting: { kind: 'm3-screw', cells: [{ dCol: 0, dRow2: 2 }] },
    });
    expect(element.footprint).toEqual({
      cells: [
        { dCol: 0, dRow2: 0 },
        { dCol: 0, dRow2: 2 },
      ],
      cols: 1,
      rows: 2,
    });
    expect(element.mounting).toEqual({ kind: 'm3-screw', cells: [{ dCol: 0, dRow2: 2 }] });
  }, 90_000);

  test('patching metadata keeps the geometry and drops pegs outside a shrunk footprint', async () => {
    const before = (await bank.get('my-box'))?.element;
    if (before === undefined) throw new Error('my-box was imported by an earlier test');
    const patched = await bank.patch('my-box', {
      name: { ru: 'Новая коробка' },
      tags: { ru: [], en: ['x'] },
      fitsTool: [{ toolClass: 'pliers' }],
    });
    expect(patched.name).toEqual({ ru: 'Новая коробка', en: 'Новая коробка' });
    expect(patched.toolClasses).toEqual(['pliers']);
    expect(patched.assets).toEqual(before.assets);
    expect(patched.bboxMm).toEqual(before.bboxMm);
    await expectError(
      bank.patch('my-box', {
        mounting: { kind: 'hex-plug', cells: [{ dCol: 5, dRow2: 5 }] },
      }),
      400,
      'invalid_body',
    );
    await expectError(bank.patch('my-ghost', { category: 'holders' }), 404, 'element_not_found');
    expect(await Bun.file(join(paths.userDir, 'index.json')).exists()).toBe(true);
    expect((await verifyBank(paths.userDir, { quick: true })).problems).toEqual([]);
  }, 90_000);

  test('reopen + replace re-converts the stored original and keeps the id; old assets are swept', async () => {
    const { upload, input } = await bank.reopen('my-box');
    expect(input.replaceId).toBe('my-box');
    expect(input.settings?.orient).toEqual({ out: '+z', up: '+y' });
    const { element } = await bank.importElement({
      ...input,
      settings: { ...input.settings, orient: { out: '+x', up: '+y' } },
    });
    expect(element.id).toBe('my-box');
    expect(element.dimsMm.z).toBe(40);
    // re-converting from the stored original only (no upload) works as well
    const again = await bank.importElement({
      replaceId: 'my-box',
      name: element.name,
      category: element.category,
      settings: { orient: { out: '+z', up: '+y' } },
    });
    expect(again.element.dimsMm.z).toBe(20);
    expect((await bank.list()).filter((e) => e.id === 'my-box')).toHaveLength(1);
    await bank.deleteUpload(upload.id);
    const files = await readdir(join(paths.userDir, 'glb'));
    const index = (await verifyBank(paths.userDir)).index;
    const referenced = new Set(
      index?.elements
        .flatMap((e) => [e.assets.lod0.path, e.assets.lod1.path])
        .map((p) => p.slice(4)),
    );
    expect(files.every((f) => referenced.has(f))).toBe(true);
  }, 120_000);

  test('removing deletes the element, its sidecar and original', async () => {
    await bank.remove('my-box-2');
    expect((await bank.list()).map((e) => e.id)).not.toContain('my-box-2');
    expect(await bank.get('my-box-2')).toBeNull();
    await expectError(bank.remove('my-box-2'), 404, 'element_not_found');
    expect(await Bun.file(join(paths.userDir, 'sources/my-box-2/original.stl')).exists()).toBe(
      false,
    );
  }, 60_000);

  test('stale uploads are removed on the next upload', async () => {
    const upload = await bank.createUpload(boxStl([12, 12, 12]), 'old.stl');
    const dir = join(paths.userDir, 'uploads', upload.id);
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await utimes(dir, old, old);
    await bank.createUpload(boxesStl([{ size: [13, 13, 13] }]), 'new.stl');
    expect(await Bun.file(join(dir, 'upload.json')).exists()).toBe(false);
  }, 60_000);

  test('a corrupt index is never overwritten by a write', async () => {
    const broken = createUserBank(
      { ...paths, userDir: join(work, 'corrupt') },
      { orphanGraceMs: 0 },
    );
    await Bun.write(join(work, 'corrupt', 'index.json'), '{ not json');
    await expectError(broken.patch('my-x', { category: 'holders' }), 500, 'user_bank_corrupt');
    expect(await Bun.file(join(work, 'corrupt', 'index.json')).text()).toBe('{ not json');
  });
});
