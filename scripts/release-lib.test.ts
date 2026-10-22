import { describe, expect, test } from 'bun:test';
import { nextVersion, rotateChangelog } from './release-lib.ts';

describe('nextVersion', () => {
  test('bumps by kind and accepts only greater explicit versions', () => {
    expect(nextVersion('0.1.9', 'patch')).toBe('0.1.10');
    expect(nextVersion('0.1.9', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.1.9', 'major')).toBe('1.0.0');
    expect(nextVersion('0.1.9', '0.3.0')).toBe('0.3.0');
    expect(() => nextVersion('0.1.9', '0.1.9')).toThrow(/not greater/);
    expect(() => nextVersion('0.2.0', '0.1.9')).toThrow(/not greater/);
    expect(() => nextVersion('0.1.0', 'banana')).toThrow(/x\.y\.z/);
  });
});

describe('rotateChangelog', () => {
  const log =
    '# Changelog\n\n## [Unreleased]\n\n### Added\n- wall CLI\n\n## [0.1.0] - 2026-10-22\n\n- skeleton\n';

  test('moves the unreleased body under the new version and leaves an empty section', () => {
    expect(rotateChangelog(log, '0.2.0', '2026-11-01')).toBe(
      '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-01\n\n### Added\n- wall CLI\n\n## [0.1.0] - 2026-10-22\n\n- skeleton\n',
    );
  });

  test('refuses an empty Unreleased section, duplicate versions and a missing section', () => {
    expect(() =>
      rotateChangelog('# C\n\n## [Unreleased]\n\n## [0.1.0] - x\n', '0.2.0', 'd'),
    ).toThrow(/empty/);
    expect(() => rotateChangelog(log, '0.1.0', 'd')).toThrow(/already has/);
    expect(() => rotateChangelog('# C\n', '0.2.0', 'd')).toThrow(/Unreleased/);
  });

  test('works when Unreleased is the last section', () => {
    expect(rotateChangelog('# C\n\n## [Unreleased]\n\n- one\n', '1.0.0', 'd')).toBe(
      '# C\n\n## [Unreleased]\n\n## [1.0.0] - d\n\n- one\n\n',
    );
  });
});
