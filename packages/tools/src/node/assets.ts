/**
 * The tool model asset store: LOD0/LOD1 GLBs of every built-in class (its default build) and every user tool
 * under content-hash names, plus the index that lists them (`TOOL_ASSET_INDEX_URL`). The guarantees mirror the bank's:
 *
 *  - a file is named by the first 16 hex of the sha-256 of its bytes, so its URL can be cached as immutable forever;
 *  - files are written before the index that lists them, each through a temp file and a rename, so a crash leaves the
 *    previous complete state (and no half-written file under a final name);
 *  - a file is served only when its bytes still hash to its name (memoised by size + mtime), so a truncated or bit-rotten
 *    copy is a 404 and a rebuild, never an immutable lie;
 *  - `health()` says what the store holds and what is missing or damaged; `deep` re-hashes and decodes every file;
 *  - a user tool whose model file is gone or is not a tool GLB is left out of the index (`unavailable`), not served broken.
 *
 * Built-in classes are regenerated once per process (about a second for all of them, yielding between classes), written only
 * when absent, so a restart is a stat per file. Orphaned files (a tool edited, a generator changed) are deleted once the daemon has seen them unlisted for a day.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TOOL_ASSET_PATH,
  ToolAssetEntrySchema,
  type ToolAssetEntry,
  type ToolAssetFile,
  type ToolAssetIndex,
} from '../assetIndex.ts';
import { classAssetId, toolAssetId } from '../assetIndex.ts';
import { exportGlb } from '../glb.ts';
import { readGlbMeta } from '../glbMeta.ts';
import type { ToolModel } from '../model.ts';
import { listToolClasses } from '../registry.ts';
import { boundsCentre, boundsDims, buildWallToolModel, holdingSummary } from '../wallModel.ts';
import { KeyedQueue, writeAtomic } from './fsutil.ts';

/** The part of the user library the store reads (`ToolStore` satisfies it). */
export interface UserToolRow {
  id: string;
  updatedAt: string;
  classId: string | null;
  bankClass: string | null;
}

export interface UserToolSource {
  list(): Promise<readonly UserToolRow[]>;
  file(id: string, which: 'glb' | 'glbLod1'): Promise<{ path: string }>;
}

export interface ToolAssetProblem {
  id: string;
  path: string;
  problem: 'missing' | 'size' | 'hash' | 'decode';
  detail?: string;
}

export interface ToolAssetHealth {
  ok: boolean;
  contentHash: string;
  entries: number;
  files: number;
  unavailable: ToolAssetIndex['unavailable'];
  problems: ToolAssetProblem[];
  /** Only with `deep`: every file was re-hashed and decoded. */
  deep: boolean;
}

const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HASH_LENGTH = 16;
const REPAIR_COOLDOWN_MS = 2000;

function contentName(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, HASH_LENGTH);
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** What reading one library tool gave: its index entry, or why it cannot be listed. */
type UserEntryResult = { readonly entry: ToolAssetEntry } | { readonly reason: string };

export class ToolAssetStore {
  readonly root: string;
  private readonly library: UserToolSource | undefined;
  private readonly queue = new KeyedQueue();
  private readonly classIds: ReadonlySet<string> | undefined;
  private builtIn: Promise<ToolAssetEntry[]> | null = null;
  private readonly userMemo = new Map<string, Promise<UserEntryResult>>();
  private lastIndex: ToolAssetIndex | null = null;
  private readonly verified = new Map<string, string>();
  /** When a file was first seen unlisted: it is deleted a day later, so clients holding the previous index still find it. */
  private readonly unlistedSince = new Map<string, number>();
  private repairing: Promise<void> | null = null;
  private lastRepairAt = 0;
  private orphansLoaded = false;

  /** `classIds` limits the built-in classes the store holds (the demo build ships a handful); default: all of them. */
  constructor(root: string, library?: UserToolSource, classIds?: readonly string[]) {
    this.root = root;
    this.library = library;
    this.classIds = classIds === undefined ? undefined : new Set(classIds);
  }

  private glbPath(name: string): string {
    return join(this.root, name);
  }

  /** Writes `bytes` under their content name unless that file is already there with the right size. */
  private async putFile(
    bytes: Uint8Array,
    triangles: number,
    repair: boolean,
  ): Promise<ToolAssetFile> {
    const path = `glb/${contentName(bytes)}.glb`;
    const target = this.glbPath(path);
    const present = repair ? null : await stat(target).catch(() => null);
    if (present?.size !== bytes.byteLength) {
      await mkdir(join(this.root, 'glb'), { recursive: true });
      await writeAtomic(target, bytes);
      this.verified.delete(path);
    }
    return { path, size: bytes.byteLength, triangles };
  }

  private async classEntries(repair: boolean): Promise<ToolAssetEntry[]> {
    const entries: ToolAssetEntry[] = [];
    for (const cls of listToolClasses()) {
      if (this.classIds && !this.classIds.has(cls.id)) continue;
      const built = buildWallToolModel(cls.id, {});
      const [lod0, lod1] = await Promise.all([
        this.putFile(exportGlb(built.lod0), built.lod0.triangles, repair),
        this.putFile(exportGlb(built.lod1), built.lod1.triangles, repair),
      ]);
      entries.push(
        entryOf(
          classAssetId(cls.id),
          'class',
          cls.id,
          cls.bankClass,
          built.values,
          built.hash,
          built.lod0,
          lod0,
          lod1,
        ),
      );
      await tick();
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async userEntry(tool: UserToolRow, repair: boolean): Promise<UserEntryResult> {
    if (!this.library) return { reason: 'no library' };
    try {
      const [a, b] = await Promise.all([
        this.library.file(tool.id, 'glb'),
        this.library.file(tool.id, 'glbLod1'),
      ]);
      const [bytes0, bytes1] = await Promise.all([readFile(a.path), readFile(b.path)]);
      const meta0 = readGlbMeta(bytes0);
      const meta1 = readGlbMeta(bytes1);
      if (!meta0.holding) return { reason: 'the model carries no holding interface' };
      const [lod0, lod1] = await Promise.all([
        this.putFile(bytes0, meta0.triangles, repair),
        this.putFile(bytes1, meta1.triangles, repair),
      ]);
      // What the client will parse: a model whose holding data is malformed is unavailable, it must not break the whole index.
      const parsed = ToolAssetEntrySchema.safeParse({
        id: toolAssetId(tool.id),
        kind: 'tool',
        classId: tool.classId,
        bankClass: tool.bankClass,
        values: null,
        paramHash: lod0.path.slice('glb/'.length, 'glb/'.length + HASH_LENGTH),
        dimsMm: meta0.dims,
        centreMm: meta0.centre,
        holding: meta0.holding,
        lod0,
        lod1,
      });
      return parsed.success
        ? { entry: parsed.data }
        : {
            reason: `the model's data is malformed: ${parsed.error.issues[0]?.path.join('.') ?? ''}`,
          };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The current index; builds the built-in classes on first use and re-reads user tools whose revision changed. */
  index(options: { repair?: boolean } = {}): Promise<ToolAssetIndex> {
    return this.queue.run('index', async () => {
      const repair = options.repair === true;
      if (repair) {
        this.builtIn = null;
        this.userMemo.clear();
      }
      const building = (this.builtIn ??= this.classEntries(repair));
      // A failed build (full disk, a generator that throws) is not remembered: the next call tries again.
      building.catch(() => {
        if (this.builtIn === building) this.builtIn = null;
      });
      const entries = [...(await building)];
      const unavailable: ToolAssetIndex['unavailable'] = [];
      const live = new Set<string>();
      for (const tool of (await this.library?.list()) ?? []) {
        // The model files are part of the key: one lost or rewritten after the first read is noticed.
        const key = `${tool.id}@${tool.updatedAt}@${await this.userFilesStamp(tool.id)}`;
        live.add(key);
        let pending = this.userMemo.get(key);
        if (!pending) {
          pending = this.userEntry(tool, repair);
          this.userMemo.set(key, pending);
        }
        const result = await pending;
        if ('reason' in result) {
          unavailable.push({ id: toolAssetId(tool.id), reason: result.reason });
          // A failed read is retried on the next call (the file may have been repaired meanwhile).
          this.userMemo.delete(key);
        } else entries.push(result.entry);
      }
      for (const key of this.userMemo.keys()) if (!live.has(key)) this.userMemo.delete(key);
      const index: ToolAssetIndex = {
        schemaVersion: 1,
        contentHash: createHash('sha256')
          .update(JSON.stringify([entries, unavailable]))
          .digest('hex')
          .slice(0, HASH_LENGTH),
        entries,
        unavailable,
      };
      if (this.lastIndex?.contentHash !== index.contentHash || repair) {
        await mkdir(this.root, { recursive: true });
        await writeAtomic(join(this.root, 'index.json'), `${JSON.stringify(index)}\n`);
        await this.sweep(index);
      }
      this.lastIndex = index;
      return index;
    });
  }

  /** Size and mtime of a library tool's model files; a lost file is `gone`. */
  private async userFilesStamp(id: string): Promise<string> {
    if (!this.library) return 'none';
    try {
      const files = await Promise.all([
        this.library.file(id, 'glb'),
        this.library.file(id, 'glbLod1'),
      ]);
      const infos = await Promise.all(files.map((file) => stat(file.path).catch(() => null)));
      return infos.map((info) => (info ? `${info.size}:${info.mtimeMs}` : 'gone')).join('/');
    } catch {
      return 'gone';
    }
  }

  /**
   * Deletes files no entry lists a day after they were first seen unlisted (a tool was edited, a generator changed): a client or
   * service worker that still holds the previous index keeps finding its files for that long.
   */
  private async sweep(index: ToolAssetIndex): Promise<void> {
    await this.loadOrphans();
    const before = JSON.stringify([...this.unlistedSince]);
    const listed = new Set(index.entries.flatMap((entry) => [entry.lod0.path, entry.lod1.path]));
    const names = await readdir(join(this.root, 'glb')).catch(() => [] as string[]);
    const now = Date.now();
    for (const name of names) {
      const path = `glb/${name}`;
      if (!TOOL_ASSET_PATH.test(path)) continue;
      if (listed.has(path)) {
        this.unlistedSince.delete(path);
        continue;
      }
      const since = this.unlistedSince.get(path) ?? now;
      this.unlistedSince.set(path, since);
      if (now - since > ORPHAN_MAX_AGE_MS) {
        await unlink(this.glbPath(path)).catch(() => undefined);
        this.unlistedSince.delete(path);
        this.verified.delete(path);
      }
    }
    // Remembered across restarts: a daemon that restarts every day would otherwise never reach the day.
    if (JSON.stringify([...this.unlistedSince]) !== before) {
      await writeAtomic(
        join(this.root, 'orphans.json'),
        JSON.stringify(Object.fromEntries(this.unlistedSince)),
      ).catch(() => undefined);
    }
  }

  private async loadOrphans(): Promise<void> {
    if (this.orphansLoaded) return;
    this.orphansLoaded = true;
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.root, 'orphans.json'), 'utf8'));
      if (typeof raw !== 'object' || raw === null) return;
      for (const [path, since] of Object.entries(raw)) {
        if (typeof since === 'number' && TOOL_ASSET_PATH.test(path))
          this.unlistedSince.set(path, since);
      }
    } catch {
      // No file yet, or an unreadable one: the clocks start now.
    }
  }

  /** The hash of the index served last, without waiting for a build: what response headers carry. */
  peekIndexHash(): string | null {
    return this.lastIndex?.contentHash ?? null;
  }

  private isListed(path: string): boolean {
    return (
      this.lastIndex?.entries.some(
        (entry) => entry.lod0.path === path || entry.lod1.path === path,
      ) ?? false
    );
  }

  /** Rebuilds the store once however many requests found damage at the same time. */
  private scheduleRepair(): void {
    // A repair that cannot fix the cause (full disk, read-only directory) must not start over on every retry of every client.
    if (this.repairing !== null || Date.now() - this.lastRepairAt < REPAIR_COOLDOWN_MS) return;
    this.lastRepairAt = Date.now();
    this.repairing = this.index({ repair: true })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.repairing = null;
      });
  }

  /**
   * The file behind `path` (`glb/<hash>.glb`) when it exists and still hashes to its name. Anything else is
   * `null`; a file that exists but fails the check also schedules a repair of the store.
   */
  async resolveFile(path: string): Promise<{ path: string; size: number } | null> {
    if (!TOOL_ASSET_PATH.test(path)) return null;
    const full = this.glbPath(path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) {
      // A file the index lists but the disk lost: rebuild it, the next request finds it again.
      if (this.isListed(path)) this.scheduleRepair();
      return null;
    }
    const stamp = `${info.size}:${info.mtimeMs}`;
    if (this.verified.get(path) !== stamp) {
      const bytes = await readFile(full).catch(() => null);
      const wanted = path.slice('glb/'.length, 'glb/'.length + HASH_LENGTH);
      if (!bytes || contentName(bytes) !== wanted) {
        // Only a damaged file the index lists is worth a rebuild; an unlisted one stays damaged whatever is rebuilt.
        if (this.isListed(path)) this.scheduleRepair();
        return null;
      }
      this.verified.set(path, stamp);
    }
    return { path: full, size: info.size };
  }

  async health(deep = false): Promise<ToolAssetHealth> {
    const index = await this.index();
    const problems: ToolAssetProblem[] = [];
    const files = new Map<string, string>();
    for (const entry of index.entries) {
      files.set(entry.lod0.path, entry.id);
      files.set(entry.lod1.path, entry.id);
    }
    const sizes = new Map<string, number>();
    for (const entry of index.entries) {
      sizes.set(entry.lod0.path, entry.lod0.size);
      sizes.set(entry.lod1.path, entry.lod1.size);
    }
    for (const [path, id] of files) {
      const info = await stat(this.glbPath(path)).catch(() => null);
      if (!info) {
        problems.push({ id, path, problem: 'missing' });
        continue;
      }
      if (info.size !== sizes.get(path)) {
        problems.push({
          id,
          path,
          problem: 'size',
          detail: `${info.size} bytes, index says ${sizes.get(path)}`,
        });
        continue;
      }
      if (!deep) continue;
      const bytes = await readFile(this.glbPath(path)).catch(() => null);
      if (!bytes) {
        problems.push({ id, path, problem: 'missing' });
        continue;
      }
      if (contentName(bytes) !== path.slice('glb/'.length, 'glb/'.length + HASH_LENGTH)) {
        problems.push({ id, path, problem: 'hash' });
        continue;
      }
      try {
        readGlbMeta(bytes);
      } catch (error) {
        problems.push({
          id,
          path,
          problem: 'decode',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      ok: problems.length === 0 && index.unavailable.length === 0,
      contentHash: index.contentHash,
      entries: index.entries.length,
      files: files.size,
      unavailable: index.unavailable,
      problems,
      deep,
    };
  }
}

function entryOf(
  id: string,
  kind: ToolAssetEntry['kind'],
  classId: string,
  bankClass: string,
  values: ToolAssetEntry['values'],
  paramHash: string,
  model: ToolModel,
  lod0: ToolAssetFile,
  lod1: ToolAssetFile,
): ToolAssetEntry {
  return {
    id,
    kind,
    classId,
    bankClass,
    values,
    paramHash,
    dimsMm: boundsDims(model.bounds),
    centreMm: boundsCentre(model.bounds),
    holding: holdingSummary(model),
    lod0,
    lod1,
  };
}
