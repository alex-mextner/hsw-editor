/**
 * The store of user-made bank elements: `<home>/bank-user` is a bank tree in the format of a generation
 * (`index.json`, content-hashed `glb/` + `thumb/`) holding only user elements, plus `meta/<id>.json`,
 * `sources/<id>/original.<ext>` and `uploads/`. The daemon is the single writer; every write is serialised,
 * assets are written (immutable, content-named) before the index that references them is replaced atomically,
 * so readers (the bank handler) never see an index pointing at a missing file. Contract: docs/bank.md.
 */
import { copyFile, mkdir, open, readdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { BANK_CATEGORIES } from '../../categories.ts';
import {
  BankIndexSchema,
  type BankElement,
  type BankIndex,
  type CellOffset,
  type FitsTool,
  type LocalizedText,
} from '../../schema.ts';
import { TOOL_CLASSES } from '../../toolClasses.ts';
import {
  ConversionSchema,
  type Conversion,
  type ConvertSettings,
  type MeshFormat,
  type Upload,
  type UserElementMeta,
  UploadSchema,
  type UserImportInput,
  UserElementMetaSchema,
  type UserName,
  type UserPatch,
  USER_ELEMENT_ID_PREFIX,
} from '../../user.ts';
import { composeIndex } from '../compose.ts';
import { compressGlb } from '../compress.ts';
import { footprintOf, artefactInputs, geometryOf } from '../geometry.ts';
import { sha256Hex } from '../hash.ts';
import { BANK_GRID, type BankPaths } from '../paths.ts';
import {
  convertMesh,
  probeMesh,
  resolveSettings,
  sniffMesh,
  UserElementError,
  type Converted,
  type Probe,
  type ResolvedSettings,
} from './convert.ts';

/** Uploads nobody finished are removed after this long. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
/** Unreferenced asset files are kept this long so a browser tab holding an older index still resolves them. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export interface UserBankOptions {
  /** Test seam: how long unreferenced assets survive a sweep. */
  orphanGraceMs?: number;
}

export interface ImportHooks {
  progress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ElementRecord {
  element: BankElement;
  meta: UserElementMeta;
}

export interface UserBank {
  readonly root: string;
  list(): Promise<BankElement[]>;
  get(id: string): Promise<ElementRecord | null>;
  createUpload(bytes: Uint8Array, filename: string): Promise<Upload>;
  getUpload(id: string): Promise<Upload | null>;
  previewUpload(id: string, settings: ConvertSettings | undefined): Promise<Conversion>;
  /** Absolute path of a preview GLB, or null. */
  previewFile(id: string, hash: string): string | null;
  deleteUpload(id: string): Promise<boolean>;
  reopen(id: string): Promise<{ upload: Upload; input: UserImportInput }>;
  importElement(
    input: UserImportInput,
    hooks?: ImportHooks,
  ): Promise<{ element: BankElement; conversion: Conversion }>;
  patch(id: string, patch: UserPatch): Promise<BankElement>;
  remove(id: string): Promise<void>;
}

const CYRILLIC: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/** `my-<kebab slug>` of a display name; Cyrillic is transliterated, anything else non-alphanumeric is a separator. */
export function slugifyName(name: string): string {
  const latin = [...name.toLowerCase()].map((ch) => CYRILLIC[ch] ?? ch).join('');
  const slug = latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return `${USER_ELEMENT_ID_PREFIX}${slug === '' ? 'element' : slug}`;
}

/** A name given in one language only is mirrored into the other. */
export function fillName(name: UserName): LocalizedText {
  const ru = (name.ru ?? '').trim();
  const en = (name.en ?? '').trim();
  return { ru: ru === '' ? en : ru, en: en === '' ? ru : en };
}

function uniqueId(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const candidate = `${wanted.slice(0, 60)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.json() : null;
}

const cellKey = (c: CellOffset): string => `${c.dCol},${c.dRow2}`;

function randomSuffix(length: number): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, length);
}

function uploadIdNow(): string {
  return `up-${randomSuffix(12)}`;
}

function invalid(message: string, details?: unknown): UserElementError {
  return new UserElementError(400, 'invalid_body', message, details);
}

export function createUserBank(paths: BankPaths, options: UserBankOptions = {}): UserBank {
  const root = paths.userDir;
  const orphanGraceMs = options.orphanGraceMs ?? ORPHAN_GRACE_MS;
  const uploadsDir = join(root, 'uploads');
  const metaFile = (id: string): string => join(root, 'meta', `${id}.json`);
  const sourceDir = (id: string): string => join(root, 'sources', id);
  const uploadDir = (id: string): string => join(uploadsDir, id);

  let writeTail: Promise<unknown> = Promise.resolve();
  /** One writer at a time: index read-modify-write cycles must not interleave. */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = writeTail.then(task, task);
    writeTail = next.catch(() => undefined);
    return next;
  }
  let convertTail: Promise<unknown> = Promise.resolve();
  /** The mesh tool is CPU heavy: previews and imports run one at a time. */
  function converting<T>(task: () => Promise<T>): Promise<T> {
    const next = convertTail.then(task, task);
    convertTail = next.catch(() => undefined);
    return next;
  }

  async function readIndex(): Promise<BankIndex | null> {
    const raw = await readJson(join(root, 'index.json')).catch((error: unknown) => {
      throw new UserElementError(
        500,
        'user_bank_corrupt',
        `${join(root, 'index.json')} is not readable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    if (raw === null) return null;
    const parsed = BankIndexSchema.safeParse(raw);
    if (!parsed.success)
      throw new UserElementError(
        500,
        'user_bank_corrupt',
        `${join(root, 'index.json')} does not match the bank schema; refusing to overwrite it`,
        parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    return parsed.data;
  }

  async function elements(): Promise<BankElement[]> {
    return (await readIndex())?.elements ?? [];
  }

  async function readMeta(id: string): Promise<UserElementMeta | null> {
    const raw = await readJson(metaFile(id)).catch(() => null);
    const parsed = UserElementMetaSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** Writes `list` as the new index (validated); returns the element list as stored. */
  async function commit(list: BankElement[]): Promise<void> {
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
    let index: BankIndex;
    try {
      index = composeIndex({
        grid: BANK_GRID,
        categories: [...BANK_CATEGORIES],
        toolClasses: [...TOOL_CLASSES],
        elements: sorted,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      throw invalid(text.split('\n').slice(1, 6).join('; ') || text);
    }
    await atomicWriteFile(join(root, 'index.json'), JSON.stringify(index));
    await sweepAssets(index).catch(() => undefined);
  }

  /** Deletes asset files no element references any more, once they are older than the grace period. */
  async function sweepAssets(index: BankIndex): Promise<void> {
    const used = new Set(
      index.elements.flatMap((e) => [
        e.assets.lod0.path,
        e.assets.lod1.path,
        e.assets.thumbnail.path,
      ]),
    );
    const now = Date.now();
    for (const dir of ['glb', 'thumb']) {
      for (const name of await readdir(join(root, dir)).catch(() => [] as string[])) {
        if (used.has(`${dir}/${name}`)) continue;
        const file = join(root, dir, name);
        const info = await stat(file).catch(() => null);
        if (info && now - info.mtimeMs >= orphanGraceMs) await rm(file, { force: true });
      }
    }
  }

  async function sweepUploads(): Promise<void> {
    const now = Date.now();
    for (const name of await readdir(uploadsDir).catch(() => [] as string[])) {
      const info = await stat(join(uploadsDir, name)).catch(() => null);
      if (info && now - info.mtimeMs > UPLOAD_TTL_MS)
        await rm(join(uploadsDir, name), { recursive: true, force: true });
    }
  }

  async function readUpload(id: string): Promise<{ upload: Upload; file: string } | null> {
    const parsed = UploadSchema.safeParse(
      await readJson(join(uploadDir(id), 'upload.json')).catch(() => null),
    );
    if (!parsed.success) return null;
    return { upload: parsed.data, file: join(uploadDir(id), `original.${parsed.data.format}`) };
  }

  const probeOf = (upload: Upload): Probe => ({
    sha256: upload.sha256,
    defaultPartId: upload.defaultPartId,
    parts: upload.parts,
  });

  async function newUpload(
    source: string,
    filename: string,
    format: MeshFormat,
    bytes: number,
  ): Promise<Upload> {
    const id = uploadIdNow();
    const dir = uploadDir(id);
    await mkdir(dir, { recursive: true });
    try {
      const file = join(dir, `original.${format}`);
      await copyFile(source, file);
      const probe = await probeMesh(paths, file);
      const stem = basename(filename, extname(filename)).replace(/[_-]+/g, ' ').trim();
      const upload: Upload = {
        id,
        filename,
        format,
        bytes,
        sha256: probe.sha256,
        parts: probe.parts,
        defaultPartId: probe.defaultPartId,
        suggestedName: stem === '' ? 'Element' : stem,
        createdAt: new Date().toISOString(),
      };
      await Bun.write(join(dir, 'upload.json'), JSON.stringify(upload));
      return upload;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async function stageUpload(bytes: Uint8Array, filename: string): Promise<Upload> {
    const format = sniffMesh(bytes, filename);
    if (format === null)
      throw new UserElementError(
        415,
        'unsupported_media_type',
        'expected a binary or ASCII STL, a binary glTF (.glb) or a 3MF file',
      );
    await sweepUploads();
    const staged = join(root, 'uploads', `.incoming-${randomSuffix(8)}`);
    await Bun.write(staged, bytes);
    try {
      return await newUpload(staged, filename, format, bytes.length);
    } finally {
      await rm(staged, { force: true });
    }
  }

  async function conversionOf(
    id: string,
    settings: ConvertSettings | undefined,
  ): Promise<{ conversion: Conversion; upload: Upload }> {
    const found = await readUpload(id);
    if (!found)
      throw new UserElementError(404, 'upload_not_found', `upload ${id} does not exist (expired?)`);
    const resolved = resolveSettings(settings, probeOf(found.upload));
    const hash = sha256Hex(JSON.stringify(resolved)).slice(0, 16);
    const previewDir = join(uploadDir(id), 'preview');
    const cache = join(previewDir, `${hash}.json`);
    const cached = await readJson(cache).catch(() => null);
    const glbUrl = `/api/bank/user/uploads/${id}/preview/${hash}.glb`;
    const parsedCache = ConversionSchema.safeParse(cached);
    const built = parsedCache.success ? { ...parsedCache.data, glbUrl } : null;
    if (built && (await Bun.file(join(previewDir, `${hash}.glb`)).exists()))
      return { conversion: built, upload: found.upload };
    const out = join(previewDir, `${hash}.glb`);
    const result = await converting(() =>
      convertMesh(paths, {
        file: found.file,
        format: found.upload.format,
        partCount: found.upload.parts.length,
        settings: resolved,
        grid: paths.grid,
        glb: out,
        color: artefactInputs('accessories').color,
        workDir: previewDir,
      }),
    );
    const conversion = conversionFromResult(result, resolved, glbUrl);
    await Bun.write(cache, JSON.stringify(conversion));
    return { conversion, upload: found.upload };
  }

  function conversionFromResult(
    result: Converted,
    settings: ResolvedSettings,
    glbUrl: string,
  ): Conversion {
    const geometry = geometryOf(result, 'm3-screw');
    return {
      glbUrl,
      bboxMm: geometry.bboxMm,
      dimsMm: geometry.dimsMm,
      triangles: result.triangles,
      footprint: geometry.footprint.cells,
      mountingCells:
        result.mountingCells.length > 0
          ? result.mountingCells.map(([dCol, dRow2]) => ({ dCol, dRow2 }))
          : geometry.footprint.cells,
      watertight: result.watertight,
      repaired: result.repaired,
      settings,
      warnings: result.warnings,
    };
  }

  function mountingFor(
    category: string,
    conversion: Conversion,
    footprint: readonly CellOffset[],
    wanted: UserImportInput['mounting'],
  ): BankElement['mounting'] {
    const kind = wanted?.kind ?? (category.startsWith('panels') ? 'none' : 'hex-plug');
    if (kind === 'none') return { kind, cells: [] };
    if (wanted && wanted.cells.length > 0) return { kind, cells: wanted.cells };
    const inside = new Set(footprint.map(cellKey));
    // the same cells the dialog shows as pegs (screw holes of the silhouette, else the whole footprint)
    const detected = conversion.mountingCells.filter((c) => inside.has(cellKey(c)));
    return { kind, cells: detected.length > 0 ? detected : [...footprint] };
  }

  function mergeFits(input: FitsTool[] | undefined, toolClasses: string[] | undefined): string[] {
    return [...new Set([...(toolClasses ?? []), ...(input ?? []).map((f) => f.toolClass)])];
  }

  async function importElement(
    input: UserImportInput,
    hooks: ImportHooks = {},
  ): Promise<{ element: BankElement; conversion: Conversion }> {
    const previous = input.replaceId === undefined ? null : await getRecord(input.replaceId);
    if (input.replaceId !== undefined && previous === null)
      throw new UserElementError(
        404,
        'element_not_found',
        `no user element ${input.replaceId} to replace`,
      );
    hooks.signal?.throwIfAborted();

    // the file: a fresh upload, or the stored original of the element being edited
    let upload: Upload;
    let file: string;
    let settingsIn: ConvertSettings | undefined = input.settings;
    if (input.uploadId !== undefined) {
      const found = await readUpload(input.uploadId);
      if (!found)
        throw new UserElementError(
          404,
          'upload_not_found',
          `upload ${input.uploadId} does not exist (expired?)`,
        );
      ({ upload, file } = found);
    } else {
      const stored = previous!;
      const dir = sourceDir(stored.element.id);
      file = join(dir, `original.${stored.meta.format}`);
      if (!(await Bun.file(file).exists()))
        throw new UserElementError(
          409,
          'source_missing',
          `the original file of ${stored.element.id} is gone; upload it again`,
        );
      const probe = await probeMesh(paths, file);
      upload = {
        id: uploadIdNow(),
        filename: stored.meta.originalName,
        format: stored.meta.format,
        bytes: stored.meta.sourceBytes,
        sha256: probe.sha256,
        parts: probe.parts,
        defaultPartId: probe.defaultPartId,
        suggestedName: stored.meta.originalName,
        createdAt: stored.meta.createdAt,
      };
      settingsIn = { ...stored.meta.settings, ...input.settings };
    }

    hooks.progress?.('converting');
    const resolved = resolveSettings(settingsIn, probeOf(upload));
    const work = join(uploadsDir, `.work-${randomSuffix(10)}`);
    const color = artefactInputs(input.category).color;
    try {
      const converted = await converting(() => {
        hooks.signal?.throwIfAborted();
        return convertMesh(paths, {
          file,
          format: upload.format,
          partCount: upload.parts.length,
          settings: resolved,
          grid: paths.grid,
          glb: join(work, 'raw.glb'),
          thumbnail: join(work, 'thumb.webp'),
          color,
          workDir: work,
        });
      });
      hooks.signal?.throwIfAborted();
      hooks.progress?.('compressing');
      const raw = new Uint8Array(await Bun.file(join(work, 'raw.glb')).arrayBuffer());
      const compressed = await compressGlb(raw);
      const thumbBytes = new Uint8Array(await Bun.file(join(work, 'thumb.webp')).arrayBuffer());

      hooks.progress?.('publishing');
      return await exclusive(async () => {
        const existing = await elements();
        const geometryHash = converted.geometryHash;
        const twin = existing.find(
          (e) => e.provenance.geometryHash === geometryHash && e.id !== input.replaceId,
        );
        if (twin)
          throw new UserElementError(
            409,
            'duplicate_element',
            `${twin.id} already has exactly this geometry`,
            { id: twin.id },
          );
        const taken = new Set(existing.map((e) => e.id));
        const name = fillName(input.name);
        const id = input.replaceId ?? uniqueId(input.id ?? slugifyName(name.en || name.ru), taken);
        if (input.replaceId === undefined && input.id !== undefined && taken.has(input.id))
          throw new UserElementError(409, 'element_exists', `${input.id} already exists`);

        const lod0 = await putAsset('glb', compressed.lod0, 'glb');
        const lod1 =
          compressed.trianglesLod1 === compressed.trianglesLod0
            ? lod0
            : await putAsset('glb', compressed.lod1, 'glb');
        const thumbnail = await putAsset('thumb', thumbBytes, 'webp');

        const detected = conversionFromResult(converted, resolved, `/bank/assets/${lod0.path}`);
        const geometry = geometryOf(converted, 'hex-plug');
        const footprintCells = input.footprint ?? geometry.footprint.cells;
        const mounting = mountingFor(input.category, detected, footprintCells, input.mounting);
        const keep = previous?.element;
        const fitsTool = input.fitsTool ?? keep?.fitsTool ?? [];
        const element: BankElement = {
          id,
          source: 'user',
          name,
          ...((input.description ?? keep?.description)
            ? { description: (input.description ?? keep?.description)! }
            : {}),
          category: input.category,
          tags: input.tags ?? keep?.tags ?? { ru: [], en: [] },
          toolClasses: mergeFits(fitsTool, input.toolClasses ?? keep?.toolClasses),
          fitsTool,
          footprint: footprintOf(footprintCells),
          bboxMm: geometry.bboxMm,
          dimsMm: geometry.dimsMm,
          mounting,
          generated: false,
          assets: {
            lod0,
            lod1,
            thumbnail,
            triangles: { lod0: compressed.trianglesLod0, lod1: compressed.trianglesLod1 },
          },
          ...((input.printNotes ?? keep?.printNotes)
            ? { printNotes: (input.printNotes ?? keep?.printNotes)! }
            : {}),
          provenance: {
            origin: 'user-upload',
            source: {
              site: 'unknown',
              file: upload.filename,
              ...(resolved.partId === '0' ? {} : { partId: resolved.partId }),
              sourceSha256: upload.sha256,
            },
            geometryHash,
            orientation: settingsIn?.orient ? 'curated' : 'auto',
            duplicates: [],
          },
          license: {
            spdx: 'LicenseRef-Unknown',
            observed: 'imported by the user',
            attribution: '',
            redistributable: false,
          },
        };
        const next = existing.filter((e) => e.id !== id);
        next.push(element);

        // sidecars and the original first; the index swap publishes everything at once
        const dir = sourceDir(id);
        const target = join(dir, `original.${upload.format}`);
        if (file !== target) {
          await mkdir(dir, { recursive: true });
          await copyFile(file, `${target}.tmp`);
          await rename(`${target}.tmp`, target);
        }
        const now = new Date().toISOString();
        const meta: UserElementMeta = {
          originalName: upload.filename,
          format: upload.format,
          sourceSha256: upload.sha256,
          sourceBytes: upload.bytes,
          settings: resolved,
          watertight: converted.watertight,
          repaired: converted.repaired,
          warnings: converted.warnings,
          createdAt: previous?.meta.createdAt ?? now,
          updatedAt: now,
        };
        await atomicWriteFile(metaFile(id), JSON.stringify(meta));
        await commit(next);
        if (input.uploadId !== undefined)
          await rm(uploadDir(input.uploadId), { recursive: true, force: true });
        return { element, conversion: { ...detected, glbUrl: `/bank/assets/${lod0.path}` } };
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** Content-named, immutable asset; an identical file is not rewritten. */
  async function putAsset(kind: 'glb' | 'thumb', bytes: Uint8Array, ext: string) {
    const hash = sha256Hex(bytes);
    const path = `${kind}/${hash.slice(0, 16)}.${ext}`;
    const file = join(root, path);
    const info = await stat(file).catch(() => null);
    if (info?.size === bytes.length) {
      // keep a reused file out of the orphan sweep
      await utimes(file, new Date(), new Date());
    } else {
      await atomicWriteFile(file, bytes);
    }
    return { path, bytes: bytes.length, sha256: hash } as const;
  }

  async function getRecord(id: string): Promise<ElementRecord | null> {
    const element = (await elements()).find((e) => e.id === id);
    if (!element) return null;
    const meta = await readMeta(id);
    if (!meta) return null;
    return { element, meta };
  }

  return {
    root,
    list: elements,
    get: getRecord,
    createUpload: stageUpload,
    async getUpload(id) {
      return (await readUpload(id))?.upload ?? null;
    },
    async previewUpload(id, settings) {
      return (await conversionOf(id, settings)).conversion;
    },
    previewFile(id, hash) {
      return /^[0-9a-f]{16}$/.test(hash) && /^up-[a-z0-9]+$/.test(id)
        ? join(uploadDir(id), 'preview', `${hash}.glb`)
        : null;
    },
    async deleteUpload(id) {
      if (!/^up-[a-z0-9]+$/.test(id)) return false;
      const existed = await stat(uploadDir(id)).catch(() => null);
      await rm(uploadDir(id), { recursive: true, force: true });
      return existed !== null;
    },
    async reopen(id) {
      const record = await getRecord(id);
      if (!record) throw new UserElementError(404, 'element_not_found', `no user element ${id}`);
      const original = join(sourceDir(id), `original.${record.meta.format}`);
      if (!(await Bun.file(original).exists()))
        throw new UserElementError(
          409,
          'source_missing',
          `the original file of ${id} is gone; upload it again`,
        );
      const upload = await exclusive(() =>
        newUpload(original, record.meta.originalName, record.meta.format, record.meta.sourceBytes),
      );
      const { element } = record;
      const input: UserImportInput = {
        uploadId: upload.id,
        replaceId: id,
        settings: record.meta.settings,
        name: element.name,
        ...(element.description ? { description: element.description } : {}),
        category: element.category,
        tags: element.tags,
        toolClasses: element.toolClasses,
        fitsTool: element.fitsTool,
        footprint: element.footprint.cells,
        mounting: element.mounting,
        ...(element.printNotes ? { printNotes: element.printNotes } : {}),
      };
      return { upload, input };
    },
    importElement,
    async patch(id, patch) {
      return exclusive(async () => {
        const list = await elements();
        const current = list.find((e) => e.id === id);
        if (!current) throw new UserElementError(404, 'element_not_found', `no user element ${id}`);
        const footprint = patch.footprint ?? current.footprint.cells;
        const mounting = patch.mounting ?? current.mounting;
        const inside = new Set(footprint.map(cellKey));
        const kept =
          mounting.kind === 'none' ? [] : mounting.cells.filter((c) => inside.has(cellKey(c)));
        const fitsTool = patch.fitsTool ?? current.fitsTool;
        const next: BankElement = {
          ...current,
          ...(patch.name ? { name: fillName(patch.name) } : {}),
          ...(patch.description ? { description: patch.description } : {}),
          ...(patch.category ? { category: patch.category } : {}),
          ...(patch.tags ? { tags: patch.tags } : {}),
          ...(patch.printNotes ? { printNotes: patch.printNotes } : {}),
          // replacing fitsTool without naming classes re-derives them, so a removed entry does not linger
          toolClasses: mergeFits(
            fitsTool,
            patch.toolClasses ?? (patch.fitsTool ? [] : current.toolClasses),
          ),
          fitsTool,
          footprint: footprintOf(footprint),
          mounting: {
            kind: mounting.kind,
            // a footprint edit drops pegs outside it; an explicit mounting patch is validated as given
            cells: patch.mounting ? mounting.cells : kept,
          },
        };
        await commit(list.map((e) => (e.id === id ? next : e)));
        const meta = await readMeta(id);
        if (meta)
          await atomicWriteFile(
            metaFile(id),
            JSON.stringify({ ...meta, updatedAt: new Date().toISOString() }),
          );
        return next;
      });
    },
    async remove(id) {
      await exclusive(async () => {
        const list = await elements();
        if (!list.some((e) => e.id === id))
          throw new UserElementError(404, 'element_not_found', `no user element ${id}`);
        await commit(list.filter((e) => e.id !== id));
        await rm(metaFile(id), { force: true });
        await rm(sourceDir(id), { recursive: true, force: true });
      });
    },
  };
}
