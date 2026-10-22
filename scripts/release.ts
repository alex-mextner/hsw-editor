/**
 * `bun run release [patch|minor|major|x.y.z] [--dry-run] [--skip-checks]`
 *
 * Gates (lint, typecheck, tests, web build) -> bump every package.json (the CLI's `--version` and the
 * daemon's `/api/health` read the root one at runtime) -> rotate CHANGELOG.md -> bundle the server as a
 * compile check -> commit `chore: release vX.Y.Z` -> annotated tag `vX.Y.Z`. Nothing is pushed.
 *
 * Re-runnable: when the version is already bumped (a commit hook or the tag step interrupted the last run) pass that
 * version explicitly; the bump and the changelog rotation are skipped and the run continues with the
 * build, the commit and the tag.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nextVersion, rotateChangelog } from './release-lib.ts';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipChecks = args.includes('--skip-checks');
const request = args.find((arg) => !arg.startsWith('--')) ?? 'patch';

function step(cmd: string[], what: string): void {
  console.info(`release: ${what}`);
  if (dryRun) return;
  const proc = Bun.spawnSync(cmd, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (proc.exitCode !== 0) {
    console.error(`release: "${cmd.join(' ')}" failed (exit ${proc.exitCode}); nothing was tagged`);
    process.exit(1);
  }
}

function capture(cmd: string[]): string {
  return new TextDecoder().decode(Bun.spawnSync(cmd, { cwd: root }).stdout).trim();
}

function manifests(): string[] {
  const files = ['package.json'];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(root, group))) {
      if (existsSync(join(root, group, name, 'package.json'))) {
        files.push(`${group}/${name}/package.json`);
      }
    }
  }
  return files;
}

const rootManifest: { version?: string } = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);
const current = rootManifest.version;
if (current === undefined) throw new Error('package.json has no version');
const alreadyBumped = request === current;
const version = alreadyBumped ? current : nextVersion(current, request);
const tag = `v${version}`;

if (capture(['git', 'tag', '--list', tag]) !== '') {
  console.error(`release: tag ${tag} already exists`);
  process.exit(1);
}
const pending = capture(['git', 'status', '--porcelain']);
if (pending !== '' && !alreadyBumped) {
  console.error(`release: the working tree must have no pending changes:\n${pending}`);
  process.exit(1);
}

console.info(`release: ${current} -> ${version}${dryRun ? ' (dry run)' : ''}`);
const changelogPath = join(root, 'CHANGELOG.md');
const today = new Date().toISOString().slice(0, 10);
// Rotating up front fails an empty or duplicate section before any gate runs or any file is touched.
const rotatedChangelog = alreadyBumped
  ? undefined
  : rotateChangelog(readFileSync(changelogPath, 'utf8'), version, today);
if (!skipChecks) {
  step(['bun', 'run', 'lint'], 'lint');
  step(['bun', 'run', 'typecheck'], 'typecheck');
  step(['bun', 'run', 'test'], 'tests');
}
step(['bun', 'run', 'build'], 'building the web app (apps/web/dist)');
step(
  ['bun', 'build', 'apps/server/src/index.ts', '--target=bun', '--outdir', 'apps/server/dist'],
  'bundling the server (apps/server/dist; a compile check, the daemon runs from source)',
);

if (rotatedChangelog !== undefined && !dryRun) {
  for (const file of manifests()) {
    const path = join(root, file);
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
    );
  }
  writeFileSync(changelogPath, rotatedChangelog);
  // the lockfile records every workspace version; a stale one breaks `bun install --frozen-lockfile`
  step(['bun', 'install'], 'refreshing bun.lock');
}
step(['git', 'add', 'CHANGELOG.md', 'bun.lock', ...manifests()], 'staging the version files');
// a re-run after a failed tag step finds the release commit already made: only tag
const releaseCommitted = capture(['git', 'log', '-1', '--format=%s']) === `chore: release ${tag}`;
if (!releaseCommitted) step(['git', 'commit', '-m', `chore: release ${tag}`], 'committing');
step(['git', 'tag', '-a', tag, '-m', `hsw-editor ${version}`], `tagging ${tag}`);
console.info('release: done. Publish with: git push origin main --follow-tags');
