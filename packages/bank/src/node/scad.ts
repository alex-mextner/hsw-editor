/** OpenSCAD rendering of generator parts: parameter sets -> STL, cached by content hash. */
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { heavyPrefix, run } from './exec.ts';
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

/** Cache key of a render: generator source, part, family version and the sorted values. */
export async function scadKey(paths: BankPaths, job: ScadJob): Promise<string> {
  const source = await Bun.file(generatorPath(paths, job.generator)).text();
  const values = Object.entries(job.values).sort(([a], [b]) => a.localeCompare(b));
  return hashOf(
    JSON.stringify([hashOf(source), job.part, job.version, values, OPENSCAD_BACKEND]),
  ).slice(0, 32);
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
  await Promise.all(Array.from({ length: PARALLEL_RENDERS }, worker));
  return { stl, failed };
}
