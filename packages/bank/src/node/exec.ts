import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BankPaths } from './paths.ts';

const HEAVY_LOCK = '/tmp/3d-cli-heavy.lock';

/**
 * Resource limits for the pipeline's child processes (mesh conversion, thumbnail rendering, OpenSCAD):
 * a systemd scope with memory/CPU caps at low priority. These jobs take seconds and a few hundred MB,
 * so they do NOT queue behind the workstation's shared heavy lock (held for hours by torch/slicer
 * jobs); set HSW_BANK_LOCK=1 to serialise behind it anyway (see withHeavyLock). HSW_BANK_NO_WRAPPER=1
 * disables all of it.
 */
export function heavyPrefix(): string[] {
  if (process.env.HSW_BANK_NO_WRAPPER === '1' || !Bun.which('systemd-run')) return [];
  const scope = [
    'systemd-run',
    '--user',
    '--scope',
    '-q',
    '-p',
    'MemoryMax=4G',
    '-p',
    'MemorySwapMax=0',
    '-p',
    'CPUQuota=400%',
    'nice',
    '-n',
    '10',
  ];
  return scope;
}

/** Set in the environment of children that run while the heavy lock is held: nested runs must not take it again. */
export const HEAVY_LOCK_HELD_ENV = 'HSW_HEAVY_LOCK_HELD';

/** Whether a parent process held the lock when this process started; read once, never changed afterwards. */
const PARENT_HOLDS_LOCK = process.env[HEAVY_LOCK_HELD_ENV] === '1';

/** In-process holder shared by every concurrent `withHeavyLock`; `users` is the re-entry count. */
let holder: { users: number; ready: Promise<() => Promise<void>> } | null = null;

async function acquireHeavyLock(): Promise<() => Promise<void>> {
  // `flock <file> sh -c ...` keeps the lock for as long as the helper lives; closing its stdin ends it.
  const proc = Bun.spawn(['flock', HEAVY_LOCK, 'sh', '-c', 'echo held; cat >/dev/null'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = proc.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (first.done) throw new Error('could not take the heavy lock');
  return async () => {
    proc.stdin.end();
    await proc.exited;
  };
}

/**
 * Runs `fn` holding the workstation's shared heavy lock when HSW_BANK_LOCK=1 (once for the whole
 * batch, not per child process, so parallel workers inside `fn` still run in parallel). A no-op when
 * the lock is not requested, flock is missing, or a parent already holds it (HSW_HEAVY_LOCK_HELD=1,
 * e.g. the whole pipeline was started as `flock /tmp/3d-cli-heavy.lock ...`).
 */
export async function withHeavyLock<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.HSW_BANK_LOCK !== '1' || PARENT_HOLDS_LOCK || !Bun.which('flock')) return fn();
  const mine = (holder ??= { users: 0, ready: acquireHeavyLock() });
  mine.users++;
  try {
    await mine.ready;
    return await fn();
  } finally {
    mine.users--;
    if (mine.users === 0) {
      if (holder === mine) holder = null;
      await (
        await mine.ready.catch(() => async () => {})
      )();
    }
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      ...(holder ? { [HEAVY_LOCK_HELD_ENV]: '1' } : {}),
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function pythonEnv(paths: BankPaths): Record<string, string> {
  return {
    UV_PROJECT_ENVIRONMENT: paths.venvDir,
    UV_CACHE_DIR: join(homedir(), '.cache/hsw-editor/uv-cache'),
  };
}

let venvReady: Promise<void> | null = null;

/** `uv sync` is idempotent and a no-op when the environment is current; concurrent callers share one run. */
function ensureVenv(paths: BankPaths): Promise<void> {
  venvReady ??= (async () => {
    const project = join(paths.repoRoot, 'scripts/bank/py');
    const result = await run(['uv', 'sync', '--project', project, '--quiet'], {
      env: pythonEnv(paths),
    });
    if (result.exitCode !== 0) throw new Error(`uv sync failed: ${result.stderr}`);
  })().catch((error: unknown) => {
    venvReady = null;
    throw error;
  });
  return venvReady;
}

/** Runs scripts/bank/py/mesh_tool.py on a job document and returns its JSON result. */
export function runMeshTool<T>(paths: BankPaths, job: object, name: string): Promise<T> {
  return runPythonScript<T>(paths, 'scripts/bank/py/mesh_tool.py', job, name);
}

/**
 * Runs a script that lives in the repository (path relative to the repo root) inside the bank venv
 * with a JSON job document and returns its JSON result file.
 */
export async function runPythonScript<T>(
  paths: BankPaths,
  script: string,
  job: object,
  name: string,
): Promise<T> {
  await ensureVenv(paths);
  // unique per call: concurrent runs (ingest + variant endpoint, parallel requests) never share job files
  const id = `${name}-${process.pid}-${crypto.randomUUID()}`;
  const jobFile = join(paths.cacheDir, 'jobs', `${id}.json`);
  const resultFile = join(paths.cacheDir, 'jobs', `${id}.result.json`);
  await Bun.write(jobFile, JSON.stringify(job));
  const project = join(paths.repoRoot, 'scripts/bank/py');
  const result = await withHeavyLock(() =>
    run(
      [
        ...heavyPrefix(),
        'uv',
        'run',
        '--project',
        project,
        '--no-sync',
        'python',
        join(paths.repoRoot, script),
        jobFile,
        resultFile,
      ],
      { env: pythonEnv(paths) },
    ),
  );
  try {
    if (result.exitCode !== 0)
      throw new Error(
        `${script} ${name} failed (${result.exitCode}): ${result.stderr.slice(-2000)}`,
      );
    return (await Bun.file(resultFile).json()) as T;
  } finally {
    await Promise.all([rm(jobFile, { force: true }), rm(resultFile, { force: true })]);
  }
}

export function openscadAvailable(): boolean {
  return Bun.which('openscad') !== null || existsSync(join(homedir(), '.local/bin/openscad'));
}
