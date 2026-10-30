/**
 * Runs tsc for every workspace.
 *
 * apps/web runs in build mode (`tsc -b`): the vendored omp renderer (apps/web/src/features/omp/vendor)
 * is its own composite project with the flags upstream compiles under, and the strict web projects
 * consume its emitted declarations (see tsconfig.omp-vendor.json).
 */
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const projects = [
  '.',
  'packages/core',
  'packages/bank',
  'packages/compat',
  'packages/commands',
  'packages/draw',
  'packages/omp-protocol',
  'packages/user-settings',
  'packages/overlay',
  'packages/tools',
  'apps/server',
  'apps/web',
  // The service worker is compiled with the WebWorker lib (the DOM lib of apps/web clashes with it).
  'apps/web/tsconfig.sw.json',
];

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
