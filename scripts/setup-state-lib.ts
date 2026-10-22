/**
 * Builds the private @ultrabricks/state-lib pilot into vendor/state-lib (gitignored).
 *
 * The pilot is not on npm. We run the library's own tools/export-pilot.mjs against a scratch copy of
 * its runtime package (the exporter hard-codes `../site/node_modules/.bin/tsc` and a git checkout),
 * with our own tsc provided through that path. Source override: STATE_LIB_RUNTIME=<dir>.
 */
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const source =
  process.env['STATE_LIB_RUNTIME'] ??
  resolve(homedir(), 'work/state-site-release-20261013/packages/state-lib/runtime');
const target = resolve(root, 'vendor/state-lib');

if (!existsSync(resolve(source, 'tools/export-pilot.mjs'))) {
  console.error(
    `setup:state-lib: state-lib runtime not found at ${source}.\n` +
      'It is a private package. Set STATE_LIB_RUNTIME=<path to packages/state-lib/runtime> or skip: ' +
      'the app builds with the baseline store backend (VITE_STATE_BACKEND=baseline).',
  );
  process.exit(2);
}

const scratch = resolve(
  process.env['XDG_CACHE_HOME'] ?? resolve(homedir(), '.cache'),
  'hsw-editor/state-lib-build',
);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(resolve(scratch, 'site/node_modules/.bin'), { recursive: true });
cpSync(source, resolve(scratch, 'runtime'), {
  recursive: true,
  filter: (path) => !path.includes('node_modules'),
});
symlinkSync(resolve(root, 'node_modules/.bin/tsc'), resolve(scratch, 'site/node_modules/.bin/tsc'));

const run = (cmd: string[], cwd: string): void => {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed (${proc.exitCode})`);
};
// export-pilot records `git rev-parse HEAD` of the runtime dir, so the scratch copy needs a commit.
run(['git', 'init', '-q'], scratch);
run(['git', 'add', '-A'], scratch);
run(
  [
    'git',
    '-c',
    'user.name=hsw-editor',
    '-c',
    'user.email=noreply@invalid',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '--no-verify',
    '-m',
    'scratch',
  ],
  scratch,
);

rmSync(target, { recursive: true, force: true });
mkdirSync(resolve(root, 'vendor'), { recursive: true });
run(
  ['node', resolve(scratch, 'runtime/tools/export-pilot.mjs'), target],
  resolve(scratch, 'runtime'),
);

console.info(
  `setup:state-lib: built ${target} (apps/web aliases it from vite.config.ts and tsconfig.statelib.json)`,
);
