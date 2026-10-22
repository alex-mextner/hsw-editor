import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BankPaths } from './paths.ts';

const HEAVY_LOCK = '/tmp/3d-cli-heavy.lock';

/** Prefix that serialises heavy work behind the workstation's shared lock with a memory/CPU cap. */
export function heavyPrefix(): string[] {
  if (process.env.HSW_BANK_NO_WRAPPER === '1') return [];
  if (!Bun.which('flock') || !Bun.which('systemd-run')) return [];
  return [
    'flock',
    HEAVY_LOCK,
    'systemd-run',
    '--user',
    '--scope',
    '-q',
    '-p',
    'MemoryMax=6G',
    '-p',
    'MemorySwapMax=0',
    '-p',
    'CPUQuota=600%',
    'nice',
    '-n',
    '10',
  ];
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
    env: { ...process.env, ...options.env },
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
    UV_PROJECT_ENVIRONMENT: join(paths.cacheDir, '../bank-venv'),
    UV_CACHE_DIR: join(homedir(), '.cache/hsw-editor/uv-cache'),
  };
}

let venvReady = false;

/** `uv sync` is idempotent and a no-op when the environment is current. */
async function ensureVenv(paths: BankPaths): Promise<void> {
  if (venvReady) return;
  const project = join(paths.repoRoot, 'scripts/bank/py');
  const result = await run(['uv', 'sync', '--project', project, '--quiet'], {
    env: pythonEnv(paths),
  });
  if (result.exitCode !== 0) throw new Error(`uv sync failed: ${result.stderr}`);
  venvReady = true;
}

/** Runs scripts/bank/py/mesh_tool.py on a job document and returns its JSON result. */
export async function runMeshTool<T>(paths: BankPaths, job: object, name: string): Promise<T> {
  await ensureVenv(paths);
  const jobFile = join(paths.cacheDir, 'jobs', `${name}.json`);
  await Bun.write(jobFile, JSON.stringify(job));
  const project = join(paths.repoRoot, 'scripts/bank/py');
  const result = await run(
    [
      ...heavyPrefix(),
      'uv',
      'run',
      '--project',
      project,
      '--no-sync',
      'python',
      join(project, 'mesh_tool.py'),
      jobFile,
    ],
    { env: pythonEnv(paths) },
  );
  if (result.exitCode !== 0)
    throw new Error(`mesh_tool ${name} failed (${result.exitCode}): ${result.stderr.slice(-2000)}`);
  return JSON.parse(result.stdout) as T;
}

export function openscadAvailable(): boolean {
  return Bun.which('openscad') !== null || existsSync(join(homedir(), '.local/bin/openscad'));
}
