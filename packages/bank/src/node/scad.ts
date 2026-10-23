/** OpenSCAD rendering of generator parts: parameter sets -> STL, cached by content hash. */
import { mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { heavyPrefix, run, withHeavyLock } from './exec.ts';
import type { BankPaths } from './paths.ts';

const OPENSCAD_BACKEND = 'manifold';
const PARALLEL_RENDERS = 4;

export interface ScadJob {
  /** File name under packages/bank/generators. */
  generator: string;
  part: string;
  version: number;
  values: Record<string, number>;
}

export function generatorPath(paths: BankPaths, generator: string): string {
  return join(paths.generatorsDir, generator);
}

function hashOf(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

const generatorHashes = new Map<string, { size: number; mtimeMs: number; hash: string }>();

/** Content hash of a generator file; re-read only when its size or mtime changed (one ladder = many keys). */
async function generatorHash(paths: BankPaths, generator: string): Promise<string> {
  const file = generatorPath(paths, generator);
  const info = await stat(file);
  const cached = generatorHashes.get(file);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.hash;
  const hash = hashOf(await Bun.file(file).text());
  generatorHashes.set(file, { size: info.size, mtimeMs: info.mtimeMs, hash });
  return hash;
}

/** Cache key of a render: generator source, part, family version and the sorted values. */
export async function scadKey(paths: BankPaths, job: ScadJob): Promise<string> {
  const values = Object.entries(job.values).sort(([a], [b]) => a.localeCompare(b));
  return hashOf(
    JSON.stringify([
      await generatorHash(paths, job.generator),
      job.part,
      job.version,
      values,
      OPENSCAD_BACKEND,
    ]),
  ).slice(0, 32);
}

/**
 * SHA-256 of a rendered STL, remembered in a sidecar next to it: the STL is immutable for its key,
 * so an unchanged rerun never re-reads the mesh.
 */
export async function stlHash(stl: string): Promise<string> {
  const sidecar = Bun.file(`${stl}.sha256`);
  if (await sidecar.exists()) return (await sidecar.text()).trim();
  const hash = new Bun.CryptoHasher('sha256')
    .update(new Uint8Array(await Bun.file(stl).arrayBuffer()))
    .digest('hex');
  const tmp = `${stl}.sha256.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, hash);
  await rename(tmp, `${stl}.sha256`);
  return hash;
}

export function scadStlPath(paths: BankPaths, key: string): string {
  return join(paths.cacheDir, 'scad', `${key}.stl`);
}

export function openscadArgs(paths: BankPaths, job: ScadJob, out: string): string[] {
  for (const [key, value] of Object.entries(job.values)) {
    // keys end up in `-D key=value`: only plain identifiers and finite numbers may pass
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))
      throw new Error(`invalid generator parameter name ${key}`);
    if (!Number.isFinite(value))
      throw new Error(`generator parameter ${key} is not a finite number`);
  }
  if (!/^[a-z0-9_]+$/.test(job.part)) throw new Error(`invalid generator part ${job.part}`);
  const defines = [
    `part="${job.part}"`,
    ...Object.entries(job.values).map(([k, v]) => `${k}=${v}`),
  ];
  return [
    'openscad',
    '--backend',
    OPENSCAD_BACKEND,
    '-o',
    out,
    ...defines.flatMap((d) => ['-D', d]),
    generatorPath(paths, job.generator),
  ];
}

export interface RenderResult {
  /** Cache key -> STL path of every job that has an STL (cached or freshly rendered). */
  stl: Map<string, string>;
  /** Cache key -> OpenSCAD error of the jobs that failed. */
  failed: Map<string, string>;
}

/** Renders every job whose STL is missing, up to PARALLEL_RENDERS at a time. Never throws for a failed render. */
export async function renderMissing(paths: BankPaths, jobs: ScadJob[]): Promise<RenderResult> {
  await mkdir(join(paths.cacheDir, 'scad'), { recursive: true });
  const stl = new Map<string, string>();
  const failed = new Map<string, string>();
  const todo = new Map<string, { job: ScadJob; out: string }>();
  for (const job of jobs) {
    const key = await scadKey(paths, job);
    const out = scadStlPath(paths, key);
    if (await Bun.file(out).exists()) stl.set(key, out);
    else todo.set(key, { job, out });
  }
  const queue = [...todo];
  const worker = async (): Promise<void> => {
    for (let next = queue.pop(); next; next = queue.pop()) {
      const [key, { job, out }] = next;
      // unique temp name + rename: concurrent renders of the same key never see a partial STL
      const tmp = `${out}.${process.pid}.${crypto.randomUUID()}.tmp.stl`;
      const proc = await run([...heavyPrefix(), ...openscadArgs(paths, job, tmp)]);
      if (proc.exitCode !== 0 || !(await Bun.file(tmp).exists())) {
        failed.set(key, `${job.part} ${JSON.stringify(job.values)}: ${proc.stderr.slice(-400)}`);
        continue;
      }
      await rename(tmp, out);
      stl.set(key, out);
    }
  };
  if (queue.length > 0) {
    // one lock acquisition for the whole pool: the workers stay parallel
    await withHeavyLock(() => Promise.all(Array.from({ length: PARALLEL_RENDERS }, worker)));
  }
  return { stl, failed };
}
