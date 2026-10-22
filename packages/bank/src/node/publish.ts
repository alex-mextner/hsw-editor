/**
 * Building blocks shared by every writer of a bank tree (ingest, `bank:adopt`, seed export): write an
 * index with its search index, copy assets, verify-and-withhold, and swap a directory into place without
 * ever exposing a half-written tree. Pure index composition lives in compose.ts.
 */
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  BankIndexSchema,
  type BankElement,
  type BankIndex,
  type UnavailableElement,
} from '../schema.ts';
import { composeIndex, searchIndexJson, withholdBroken, type IndexParts } from './compose.ts';
import {
  createStaging,
  currentGeneration,
  publishGeneration,
  BankVerificationError,
  type PublishResult,
} from './generations.ts';
import { firstProblemByElement, verifyBank } from './verify.ts';
import type { BankPaths } from './paths.ts';

/** `index.json` + `search-index.json` of one tree. Plain writes: the tree is private until published. */
export async function writeIndexFiles(root: string, index: BankIndex): Promise<void> {
  await Bun.write(join(root, 'index.json'), JSON.stringify(index));
  await Bun.write(join(root, 'search-index.json'), searchIndexJson(index));
}

/**
 * Composes the index of `staging`, writes it and verifies the whole tree; every element with a problem
 * (missing/truncated/corrupt file, GLB bounds that disagree with its bboxMm) is moved to `unavailable`
 * and the index is recomposed, so one bad element withholds itself instead of blocking the whole bank.
 * Index-level problems stay and make the later publish refuse.
 */
export async function composeVerified(staging: string, parts: IndexParts): Promise<BankIndex> {
  const first = composeIndex(parts);
  await writeIndexFiles(staging, first);
  const broken = firstProblemByElement((await verifyBank(staging)).issues);
  if (broken.size === 0) return first;
  const index = composeIndex(withholdBroken(parts, broken));
  await writeIndexFiles(staging, index);
  return index;
}

export async function copyInto(root: string, relativePath: string, from: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(from, target);
}

/**
 * Replaces `target` by the finished tree in `staging`: the old tree is renamed aside first, so there is
 * no point where readers see a partial mix, and removed only after the new one is in place. If the final
 * rename fails the old tree is put back.
 */
export async function replaceDirectory(staging: string, target: string): Promise<void> {
  const old = `${target}.old-${process.pid}`;
  await rm(old, { recursive: true, force: true });
  const hadOld = await rename(target, old).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false; // nothing to replace yet
      throw error; // EACCES, EBUSY, ...: never pretend there was no old tree
    },
  );
  try {
    await rename(staging, target);
  } catch (error) {
    if (hadOld) await rename(old, target);
    throw error;
  }
  if (hadOld) await rm(old, { recursive: true, force: true });
}

export interface AdoptResult {
  publish: PublishResult;
  /** Elements of the source that were left out because a file was missing or corrupt. */
  withheld: UnavailableElement[];
}

/**
 * Publishes the bank found in `sourceRoot` (a flat tree: a legacy bank, a copy of the seed, another
 * machine's export) as a new verified generation. Elements whose files are missing or corrupt in the
 * source are withheld and listed under `unavailable` instead of being published broken.
 */
export async function adoptBank(
  paths: BankPaths,
  sourceRoot: string,
  options: { keep?: number } = {},
): Promise<AdoptResult> {
  // Verified once, before anything is copied: a source whose own index is damaged or hand-edited
  // (contentHash, schema, cross-field invariants) is refused outright; per-element problems (missing,
  // truncated or corrupt file, GLB bounds that disagree with the index) only withhold that element.
  const checked = await verifyBank(sourceRoot);
  const indexProblems = checked.issues.filter((i) => i.kind === 'index');
  if (indexProblems.length > 0) throw new BankVerificationError(indexProblems.map((i) => i.detail));
  const broken = firstProblemByElement(checked.issues);
  const source = BankIndexSchema.parse(await Bun.file(join(sourceRoot, 'index.json')).json());
  const staging = await createStaging(paths);
  const elements: BankElement[] = [];
  const withheld: UnavailableElement[] = [...(source.unavailable ?? [])];
  try {
    for (const element of source.elements) {
      const problem = broken.get(element.id);
      if (problem !== undefined) {
        withheld.push({ id: element.id, name: element.name, reason: problem });
        continue;
      }
      const { lod0, lod1, thumbnail } = element.assets;
      for (const path of new Set([lod0.path, lod1.path, thumbnail.path]))
        await copyInto(staging, path, join(sourceRoot, path));
      elements.push(element);
    }
    const index = composeIndex({
      grid: source.grid,
      categories: source.categories,
      toolClasses: source.toolClasses,
      elements,
      unavailable: withheld,
    });
    await writeIndexFiles(staging, index);
    await Bun.write(
      join(staging, 'report.json'),
      JSON.stringify({ adoptedFrom: sourceRoot, at: new Date().toISOString(), withheld }, null, 2),
    );
    return { publish: await publishGeneration(paths, staging, options), withheld };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Files of a flat (pre-generations) bank in `bankDir`; `variant/` and `.fingerprint` are not part of it. */
const FLAT_ENTRIES = ['index.json', 'search-index.json', 'report.json', 'glb', 'thumb'] as const;

/**
 * One-shot migration of a flat bank written by an older ingest (`<bankDir>/index.json`, `glb/`, `thumb/`):
 * when no generation exists yet it is adopted as the first one (so asset names held by open browser tabs
 * keep resolving from the retained generation) and the flat files are removed; afterwards only
 * `generations/`, `current`, `variant/` live in the bank dir. Returns whether a migration ran.
 */
export async function migrateFlatBank(paths: BankPaths): Promise<boolean> {
  const hasFlat = await Bun.file(join(paths.bankDir, 'index.json')).exists();
  if (!hasFlat || (await currentGeneration(paths))) return false;
  await adoptBank(paths, paths.bankDir);
  for (const entry of FLAT_ENTRIES)
    await rm(join(paths.bankDir, entry), { recursive: true, force: true });
  return true;
}
