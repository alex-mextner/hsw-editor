/** OpenSCAD rendering of generator parts: parameter sets -> STL, cached by content hash. */
import { mkdir } from 'node:fs/promises';
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
  return join(paths.repoRoot, 'packages/bank/generators', generator);
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

/** Renders every job whose STL is missing; throws listing the failures. Returns key -> STL path. */
export async function renderMissing(
  paths: BankPaths,
  jobs: ScadJob[],
): Promise<Map<string, string>> {
  await mkdir(join(paths.cacheDir, 'scad'), { recursive: true });
  const result = new Map<string, string>();
  const todo: { key: string; job: ScadJob; out: string }[] = [];
  for (const job of jobs) {
    const key = await scadKey(paths, job);
    const out = scadStlPath(paths, key);
    result.set(key, out);
    if (!(await Bun.file(out).exists())) todo.push({ key, job, out });
  }
  const failures: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let item = todo[next++]; item; item = todo[next++]) {
      const tmp = `${item.out}.tmp.stl`;
      const proc = await run([...heavyPrefix(), ...openscadArgs(paths, item.job, tmp)]);
      if (proc.exitCode !== 0 || !(await Bun.file(tmp).exists())) {
        failures.push(
          `${item.job.part} ${JSON.stringify(item.job.values)}: ${proc.stderr.slice(-400)}`,
        );
        continue;
      }
      await Bun.write(item.out, Bun.file(tmp));
      await Bun.file(tmp).delete();
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_RENDERS }, worker));
  if (failures.length > 0)
    throw new Error(`OpenSCAD failed for ${failures.length} part(s):\n${failures.join('\n')}`);
  return result;
}
