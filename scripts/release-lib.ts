/** Pure helpers of the release script: semver bumping and changelog rotation. */

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(version: string): [number, number, number] {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error(`not a plain x.y.z version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isGreater(candidate: readonly number[], base: readonly number[]): boolean {
  for (const [index, part] of candidate.entries()) {
    const other = base[index] ?? 0;
    if (part !== other) return part > other;
  }
  return false;
}

/** `patch|minor|major` bump of `current`, or an explicit `x.y.z` that must be greater than it. */
export function nextVersion(current: string, request: string): string {
  const [major, minor, patch] = parseVersion(current);
  if (request === 'major') return `${major + 1}.0.0`;
  if (request === 'minor') return `${major}.${minor + 1}.0`;
  if (request === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (!isGreater(parseVersion(request), [major, minor, patch])) {
    throw new Error(`version ${request} is not greater than the current ${current}`);
  }
  return request;
}

const UNRELEASED = /^## \[Unreleased\][ \t]*\r?\n/m;
const NEXT_SECTION = /^## \[/m;

/**
 * Moves the body of `## [Unreleased]` under a new `## [version] - date` heading and leaves an empty
 * Unreleased section on top. Fails when there is nothing to release: the changelog is part of the release.
 */
export function rotateChangelog(changelog: string, version: string, date: string): string {
  const heading = UNRELEASED.exec(changelog);
  if (heading === null) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const bodyStart = heading.index + heading[0].length;
  const next = NEXT_SECTION.exec(changelog.slice(bodyStart));
  const bodyEnd = next === null ? changelog.length : bodyStart + next.index;
  const body = changelog.slice(bodyStart, bodyEnd).trim();
  if (body === '') {
    throw new Error(
      'the [Unreleased] section of CHANGELOG.md is empty: describe the release first',
    );
  }
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const rotated = `${changelog.slice(0, bodyStart)}\n## [${version}] - ${date}\n\n${body}\n\n${changelog.slice(bodyEnd)}`;
  return rotated.replace(/\n{3,}/g, '\n\n');
}
