/**
 * User tool library on disk (single writer: the daemon).
 *
 *   <root>/<id>/tool.json  model.glb  model-lod1.glb  thumb.webp  source/<files>
 *   <root>/.trash/<id>-<ts>/   removed tools are moved here, never unlinked
 *
 * Writes are atomic per file (tmp + rename); `tool.json` is written last so a half-written tool is never listed.
 */
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HoldingInterface, ToolModel } from '../model.ts';
import { applyPatch } from '../custom/rebuild.ts';
import { getToolClass, hasToolClass } from '../registry.ts';
import { exportGlb } from '../glb.ts';
import { CustomToolSchema, type CustomTool, ToolIdSchema } from '../custom/schema.ts';
import { KeyedQueue, writeAtomic } from './fsutil.ts';
import { renderThumbWebp } from './thumb.ts';

export class ToolStoreError extends Error {
  readonly code: 'not_found' | 'exists' | 'invalid_id' | 'corrupt';
  constructor(code: ToolStoreError['code'], message: string) {
    super(message);
    this.name = 'ToolStoreError';
    this.code = code;
  }
}

export interface ToolSummary {
  id: string;
  name: CustomTool['name'];
  classId: string | null;
  /** Bank class of the tool's generator (null for a generic loft). */
  bankClass: string | null;
  tags: string[];
  fit: { method: CustomTool['fit']['method'] };
  dimensionsMm: CustomTool['dimensionsMm'];
  /** Bounding box in the tool frame: x = width, y = length, z = thickness (mm). */
  dimsMm: { x: number; y: number; z: number };
  /** `holding.dims` of the model (mm, by grip name), computed once per tool revision. */
  holdingDims: Record<string, number>;
  /** Relative URL of the thumbnail. */
  thumb: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  triangles: number;
}

export interface SourceFile {
  name: string;
  bytes: Uint8Array;
}

export interface ToolFiles {
  model: ToolModel;
  modelLod1: ToolModel;
}

/** Path segments of `/api/tools/<segment>` that are routes, not tools. */
const RESERVED_IDS: ReadonlySet<string> = new Set(['classes', 'drafts', 'vision', 'assets']);

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

export interface ToolHolding {
  holding: HoldingInterface;
  bboxMm: ToolModel['bounds'];
  /** Bank class of the generator; null for a generic loft. */
  bankClass: string | null;
}

const HOLDING_MEMO_SIZE = 4096;
const holdingMemo = new Map<string, ToolHolding>();

/**
 * Holding interface of a stored tool, rebuilt from its tool.json (the same rebuild a PATCH does) and memoised by
 * id + updatedAt, so listing the library does not rebuild every tool on every call.
 */
export function holdingOf(tool: CustomTool): ToolHolding {
  const key = `${tool.id}@${tool.updatedAt}`;
  const known = holdingMemo.get(key);
  if (known) return known;
  const model = applyPatch(tool, {}).model;
  const out: ToolHolding = {
    holding: model.holding,
    bboxMm: model.bounds,
    bankClass:
      tool.classId !== null && hasToolClass(tool.classId)
        ? getToolClass(tool.classId).bankClass
        : null,
  };
  if (holdingMemo.size >= HOLDING_MEMO_SIZE) {
    const oldest = holdingMemo.keys().next();
    if (!oldest.done) holdingMemo.delete(oldest.value);
  }
  holdingMemo.set(key, out);
  return out;
}

export function summarize(tool: CustomTool): ToolSummary {
  // a tool that no longer rebuilds (its class changed under it) stays listed, just without holding data
  let holdingDims: Record<string, number> = {};
  let bankClass: string | null = null;
  try {
    const h = holdingOf(tool);
    holdingDims = h.holding.dims;
    bankClass = h.bankClass;
  } catch {
    if (tool.classId !== null && hasToolClass(tool.classId)) {
      bankClass = getToolClass(tool.classId).bankClass;
    }
  }
  const d = tool.dimensionsMm;
  return {
    id: tool.id,
    name: tool.name,
    classId: tool.classId,
    bankClass,
    tags: tool.tags,
    fit: { method: tool.fit.method },
    dimensionsMm: d,
    dimsMm: { x: d.width, y: d.length, z: d.thickness },
    holdingDims,
    thumb: `/api/tools/${encodeURIComponent(tool.id)}/thumb.webp`,
    confidence: tool.fit.confidence,
    createdAt: tool.createdAt,
    updatedAt: tool.updatedAt,
    triangles: tool.model.triangles,
  };
}

export class ToolStore {
  readonly root: string;
  private readonly queue = new KeyedQueue();

  constructor(root: string) {
    this.root = root;
  }

  /** Id allocation and the write that claims it must not interleave: wrap `freeId` + `save` in this. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.queue.run('library', work);
  }

  private dir(id: string): string {
    if (!ToolIdSchema.safeParse(id).success)
      throw new ToolStoreError('invalid_id', `bad tool id: ${id}`);
    return join(this.root, id);
  }

  async list(): Promise<ToolSummary[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const out: ToolSummary[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const tool = await this.get(e.name).catch(() => null);
      if (tool) out.push(summarize(tool));
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<CustomTool> {
    const raw = await readFile(join(this.dir(id), 'tool.json'), 'utf8').catch(() => null);
    if (raw === null) throw new ToolStoreError('not_found', `no tool ${id}`);
    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      throw new ToolStoreError('corrupt', `tool ${id} has an unreadable tool.json`);
    }
    const parsed = CustomToolSchema.safeParse(doc);
    if (!parsed.success) throw new ToolStoreError('corrupt', `tool ${id} has an invalid tool.json`);
    return parsed.data;
  }

  /** True when a directory of that name exists, even if its tool.json is unreadable (never hand out its id). */
  async exists(id: string): Promise<boolean> {
    return readFile(join(this.dir(id), 'tool.json')).then(
      () => true,
      () => false,
    );
  }

  /** Unused id derived from `base` (`screwdriver`, `screwdriver-2`, ...). */
  async freeId(base: string): Promise<string> {
    const stem =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'tool';
    for (let n = 1; n < 10_000; n++) {
      const id = n === 1 ? stem : `${stem}-${n}`;
      if (RESERVED_IDS.has(id)) continue;
      if (!(await this.exists(id))) return id;
    }
    throw new ToolStoreError('exists', `no free id for ${base}`);
  }

  /** Write the model files and tool.json of `tool` (the `model` section is filled in here). */
  async save(
    tool: Omit<CustomTool, 'model'>,
    files: ToolFiles,
    sources: readonly SourceFile[] = [],
  ): Promise<CustomTool> {
    const dir = this.dir(tool.id);
    await mkdir(join(dir, 'source'), { recursive: true });
    for (const s of sources) {
      if (!SAFE_FILE.test(s.name))
        throw new ToolStoreError('invalid_id', `bad source file name: ${s.name}`);
      await writeAtomic(join(dir, 'source', s.name), s.bytes);
    }
    await writeAtomic(join(dir, 'model.glb'), exportGlb(files.model, { custom: tool.id }));
    await writeAtomic(join(dir, 'model-lod1.glb'), exportGlb(files.modelLod1, { custom: tool.id }));
    await writeAtomic(join(dir, 'thumb.webp'), await renderThumbWebp(files.model));
    const b = files.model.bounds;
    const full: CustomTool = {
      ...tool,
      model: {
        glb: 'model.glb',
        glbLod1: 'model-lod1.glb',
        thumb: 'thumb.webp',
        triangles: files.model.triangles,
        bboxMm: { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] },
      },
    };
    const check = CustomToolSchema.safeParse(full);
    if (!check.success) {
      throw new ToolStoreError(
        'corrupt',
        `tool ${tool.id} does not fit the tool schema: ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    }
    await writeAtomic(join(dir, 'tool.json'), `${JSON.stringify(full, null, 2)}\n`);
    return full;
  }

  async file(
    id: string,
    which: 'glb' | 'glbLod1' | 'thumb',
  ): Promise<{ path: string; mime: string }> {
    const tool = await this.get(id);
    const name = tool.model[which];
    return {
      path: join(this.dir(id), name),
      mime: which === 'thumb' ? 'image/webp' : 'model/gltf-binary',
    };
  }

  async sourceFile(id: string, name: string): Promise<string> {
    if (!SAFE_FILE.test(name)) throw new ToolStoreError('not_found', 'no such source');
    await this.get(id);
    return join(this.dir(id), 'source', name);
  }

  /**
   * Read, change and save one tool under the library lock (concurrent PATCHes neither lose updates nor
   * resurrect a tool that a DELETE just moved to the trash).
   */
  update(
    id: string,
    change: (tool: CustomTool) => { tool: Omit<CustomTool, 'model'>; files: ToolFiles },
  ): Promise<CustomTool> {
    return this.exclusive(async () => {
      const next = change(await this.get(id));
      return this.save(next.tool, next.files);
    });
  }

  /** Move to `.trash` (recoverable), serialised with `save`/`update`. */
  remove(id: string): Promise<string> {
    return this.exclusive(() => this.removeLocked(id));
  }

  private async removeLocked(id: string): Promise<string> {
    const dir = this.dir(id);
    // a tool whose tool.json is unreadable can still be removed: only the directory has to exist
    if (
      !(await stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    ) {
      throw new ToolStoreError('not_found', `no tool ${id}`);
    }
    const trash = join(this.root, '.trash');
    await mkdir(trash, { recursive: true });
    const target = join(trash, `${id}-${Date.now()}`);
    await rename(dir, target);
    return target;
  }
}
