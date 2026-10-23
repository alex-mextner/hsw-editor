import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOmpConfig } from './config.ts';

function envWithConfig(omp: object): Record<string, string> {
  const root = mkdtempSync(join(tmpdir(), 'hsw-omp-config-'));
  mkdirSync(join(root, 'hsw-editor'));
  writeFileSync(join(root, 'hsw-editor', 'config.json'), JSON.stringify({ omp }));
  return { XDG_CONFIG_HOME: root, HSW_EDITOR_HOME: join(root, 'home') };
}

describe('loadOmpConfig', () => {
  test('defaults', () => {
    const config = loadOmpConfig(envWithConfig({}));
    expect(config.command).toEqual(['omp']);
    expect(config.approvalMode).toBe('write');
    expect(config.maxChildren).toBe(3);
    expect(config.idleStopMs).toBe(10 * 60_000);
    expect(config.destructiveThreshold).toBe(5);
  });

  test('the fallback working directory follows the data directory override', () => {
    const config = loadOmpConfig(envWithConfig({}), { dataDir: '/srv/hsw' });
    expect(config.dataDir).toBe('/srv/hsw');
    expect(config.fallbackCwd).toBe('/srv/hsw/omp-workspace');
  });

  test('maxChildren of 0 is refused (it would reject every session); 0 idle minutes disables idle stop', () => {
    const config = loadOmpConfig(envWithConfig({ maxChildren: 0, idleStopMinutes: 0 }));
    expect(config.maxChildren).toBe(3);
    expect(config.idleStopMs).toBe(0);
  });

  test('environment overrides win over the file; invalid values fall back', () => {
    const env = {
      ...envWithConfig({ approvalMode: 'always-ask', model: 'file-model', destructiveOps: 'nope' }),
      HSW_EDITOR_OMP_APPROVAL: 'yolo',
      HSW_EDITOR_OMP_MODEL: 'env-model',
    };
    const config = loadOmpConfig(env);
    expect(config.approvalMode).toBe('yolo');
    expect(config.model).toBe('env-model');
    expect(config.destructiveOps).toBe('ask');
  });

  test('HSW_EDITOR_OMP_COMMAND accepts words or a JSON array (paths with spaces)', () => {
    const base = envWithConfig({});
    expect(loadOmpConfig({ ...base, HSW_EDITOR_OMP_COMMAND: 'bun run x.ts' }).command).toEqual([
      'bun',
      'run',
      'x.ts',
    ]);
    expect(
      loadOmpConfig({ ...base, HSW_EDITOR_OMP_COMMAND: '["/opt/my omp/omp","--x"]' }).command,
    ).toEqual(['/opt/my omp/omp', '--x']);
    expect(loadOmpConfig({ ...base, HSW_EDITOR_OMP_COMMAND: '[oops' }).command).toEqual(['omp']);
    expect(loadOmpConfig({ ...base, HSW_EDITOR_OMP_COMMAND: '[]' }).command).toEqual(['omp']);
    expect(loadOmpConfig(envWithConfig({ command: [] })).command).toEqual(['omp']);
  });
});
