/**
 * Generation store of the built bank. A bank is never edited in place: ingestion (or `bank:adopt`)
 * builds a complete tree in a staging directory, verifies it, renames it to `generations/<id>` and then
 * swaps the `current` symlink. Readers therefore always see one consistent index + asset set, and the
 * previous generations stay on disk (default 3 in total) so a browser tab that still holds an older
 * index keeps resolving its hashed asset names instead of getting 404s.
 *
 *   <bankDir>/current -> generations/<id>          swapped atomically (rename over the symlink)
 *   <bankDir>/generations/<id>/{index.json,search-index.json,report.json,glb/,thumb/}
 *   <bankDir>/generations/.staging-*               incomplete builds, never served
 *   <bankDir>/variant/                             content-addressed variants, shared by all generations
 *
 * A flat bank written by an older ingest (`<bankDir>/index.json`) is still understood and ranks below
 * every generation.
 */
import { lstat, mkdir, readdir, readlink, rename, rm, stat, symlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { BankPaths } from './paths.ts';
import { verifyBank } from './verify.ts';

/** Generations kept on disk (the current one included). */
export const DEFAULT_KEEP_GENERATIONS = 3;

export interface GenerationInfo {
  id: string;
  root: string;
}

export class BankVerificationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    const shown = problems.slice(0, 20).join('\n  ');
    const more = problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : '';
    super(
      `refusing to publish an inconsistent bank (${problems.length} problems):\n  ${shown}${more}`,
    );
    this.name = 'BankVerificationError';
    this.problems = problems;
  }
}

export const generationsDir = (paths: BankPaths): string => join(paths.bankDir, 'generations');
export const currentLink = (paths: BankPaths): string => join(paths.bankDir, 'current');

async function hasIndex(root: string): Promise<boolean> {
  return stat(join(root, 'index.json')).then(
    (info) => info.isFile(),
    () => false,
  );
}

/** Published generations, newest first. Staging directories and directories without an index are skipped. */
export async function listGenerations(paths: BankPaths): Promise<GenerationInfo[]> {
  const entries = await readdir(generationsDir(paths)).catch(() => [] as string[]);
  const found: GenerationInfo[] = [];
  for (const id of entries
    .filter((name) => !name.startsWith('.'))
    .sort()
    .reverse()) {
    const root = join(generationsDir(paths), id);
    if (await hasIndex(root)) found.push({ id, root });
  }
  return found;
}

/** The generation `current` points at, or null when nothing was published (or the link dangles). */
export async function currentGeneration(paths: BankPaths): Promise<GenerationInfo | null> {
  const target = await readlink(currentLink(paths)).catch(() => null);
  if (target === null) return null;
  const root = resolve(paths.bankDir, target);
  if (!(await hasIndex(root))) return null;
  return { id: basename(root), root };
}

/**
 * Roots the server reads, best first: the current generation, older generations (so retired hashed
 * names keep resolving), the bank dir itself (variants, and a flat bank from an older ingest), the seed.
 */
export async function bankRoots(paths: BankPaths): Promise<string[]> {
  const current = await currentGeneration(paths);
  const generations = await listGenerations(paths);
  return [
    ...(current ? [current.root] : []),
    ...generations.map((g) => g.root).filter((root) => root !== current?.root),
    paths.bankDir,
    paths.seedDir,
  ];
}

/** The root that holds the built bank's index (current generation, else a flat bank), if any. */
export async function builtBankRoot(paths: BankPaths): Promise<string | null> {
  const current = await currentGeneration(paths);
  if (current) return current.root;
  return (await hasIndex(paths.bankDir)) ? paths.bankDir : null;
}

/** A fresh private directory to build a generation in; same filesystem as the final location. */
export async function createStaging(paths: BankPaths): Promise<string> {
  await removeStaleStaging(paths);
  const dir = join(generationsDir(paths), `.staging-${Date.now()}-${process.pid}`);
  await mkdir(join(dir, 'glb'), { recursive: true });
  await mkdir(join(dir, 'thumb'), { recursive: true });
  return dir;
}

/** Leftovers of a crashed build (staging trees, half-made `current` links); younger than an hour may be live. */
async function removeStaleStaging(paths: BankPaths): Promise<void> {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const sweep = async (dir: string, prefix: string): Promise<void> => {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith(prefix)) continue;
      const target = join(dir, name);
      const info = await lstat(target).catch(() => null);
      if (info && info.mtimeMs < cutoff) await rm(target, { recursive: true, force: true });
    }
  };
  await sweep(generationsDir(paths), '.staging-');
  await sweep(paths.bankDir, '.current.');
}

/** `YYYYMMDDTHHMMSSmmmZ`: millisecond resolution keeps ids sortable as strings. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

function stampMs(id: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id);
  return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`) : 0;
}

async function removeOld(paths: BankPaths, keep: number): Promise<string[]> {
  const [current, generations] = await Promise.all([
    currentGeneration(paths),
    listGenerations(paths),
  ]);
  const kept = new Set(generations.slice(0, Math.max(1, keep)).map((g) => g.id));
  if (current) kept.add(current.id);
  const removed: string[] = [];
  for (const generation of generations) {
    if (kept.has(generation.id)) continue;
    await rm(generation.root, { recursive: true, force: true });
    removed.push(generation.id);
  }
  return removed;
}

export interface PublishResult {
  id: string;
  root: string;
  /** The staged bank was identical to the current one; nothing changed. */
  unchanged: boolean;
  contentHash: string;
  elements: number;
  /** Generations deleted by the retention policy. */
  pruned: string[];
}

/**
 * Verifies the staged bank and, only if it is clean, makes it the current generation. The staging
 * directory is consumed in every outcome: renamed into place, or removed on a no-op / refusal / failed
 * swap. A refused bank leaves `current` exactly as it was.
 */
export async function publishGeneration(
  paths: BankPaths,
  staging: string,
  options: { keep?: number; now?: Date; fullVerify?: boolean; prune?: boolean } = {},
): Promise<PublishResult> {
  // `fullVerify: false` is for callers that just verified this exact tree in full (see composeVerified):
  // the gate then only re-checks the index, existence and sizes.
  const result = await verifyBank(staging, options.fullVerify === false ? { quick: true } : {});
  if (result.issues.length > 0 || result.contentHash === undefined) {
    await rm(staging, { recursive: true, force: true });
    throw new BankVerificationError(result.problems);
  }
  const current = await currentGeneration(paths);
  if (current) {
    // Identical content is a no-op only while the published copy is fully intact (every file present with
    // its recorded size AND sha256): a damaged current generation with the same hash must be replaced by
    // the verified staging tree, otherwise a same-size bit flip could never be repaired.
    const published = await verifyBank(current.root, { bounds: false });
    if (published.contentHash === result.contentHash && published.issues.length === 0) {
      await rm(staging, { recursive: true, force: true });
      return {
        id: current.id,
        root: current.root,
        unchanged: true,
        contentHash: result.contentHash,
        elements: result.checked,
        pruned: [],
      };
    }
  }
  // A new generation must sort after every existing one even when the clock stalled or went back.
  const newest = (await listGenerations(paths))[0];
  const at = Math.max((options.now ?? new Date()).getTime(), newest ? stampMs(newest.id) + 1 : 0);
  const id = `${stamp(new Date(at))}-${result.contentHash.slice(0, 12)}`;
  const root = join(generationsDir(paths), id);
  const next = join(paths.bankDir, `.current.${process.pid}.${Date.now()}`);
  let renamed = false;
  try {
    await rename(staging, root);
    renamed = true;
    await symlink(join('generations', id), next);
    await rename(next, currentLink(paths));
  } catch (error) {
    // A failed swap must not leave a staging copy, a dangling temp link or an orphan generation behind.
    await rm(staging, { recursive: true, force: true });
    await rm(next, { force: true });
    if (renamed) await rm(root, { recursive: true, force: true });
    throw error;
  }
  const pruned =
    options.prune === false ? [] : await removeOld(paths, options.keep ?? keepFromEnv());
  return {
    id,
    root,
    unchanged: false,
    contentHash: result.contentHash,
    elements: result.checked,
    pruned,
  };
}

function keepFromEnv(): number {
  const parsed = Number(process.env.HSW_BANK_KEEP_GENERATIONS);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_KEEP_GENERATIONS;
}
