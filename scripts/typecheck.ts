/**
 * Runs tsc for every workspace. The state-lib backend module is type-checked only when
 * `bun run setup:state-lib` has produced vendor/state-lib (it is private and absent in CI).
 *
 * apps/web runs in build mode (`tsc -b`): the vendored omp renderer (apps/web/src/features/omp/vendor)
 * is its own composite project with the flags upstream compiles under, and the strict web projects
 * consume its emitted declarations (see tsconfig.omp-vendor.json).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const projects = [
  '.',
  'packages/core',
  'packages/bank',
  'packages/compat',
  'packages/commands',
  'packages/draw',
  'packages/user-settings',
  'packages/overlay',
  'packages/tools',
  'apps/server',
  'apps/web',
];
if (existsSync(resolve(root, 'vendor/state-lib/dist/index.d.ts'))) {
  projects.push('apps/web/tsconfig.statelib.json');
} else {
  console.info('typecheck: vendor/state-lib absent, skipping the state-lib backend project');
}

let failed = false;
for (const project of projects) {
  const args = project.startsWith('apps/web') ? ['-b', project] : ['--noEmit', '-p', project];
  const proc = Bun.spawn([resolve(root, 'node_modules/.bin/tsc'), ...args], {
    cwd: root,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await proc.exited) !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
