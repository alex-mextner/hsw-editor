/** The daemon's read of the `vision.segmentQuality` user setting (`<home>/settings.json`, namespace `settings`). */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTINGS_FILE } from '../settings.ts';
import { readSegmentQuality, SEGMENT_QUALITY_SETTING } from './settings.ts';

let home = '';
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hsw-vision-settings-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeSettings(data: Record<string, unknown>): void {
  writeFileSync(
    join(home, SETTINGS_FILE),
    JSON.stringify({ schema: 1, rev: 1, updatedAt: new Date(0).toISOString(), data }),
  );
}

describe('readSegmentQuality', () => {
  test('is the stored choice', async () => {
    writeSettings({ settings: { [SEGMENT_QUALITY_SETTING]: 'accurate' } });
    expect(await readSegmentQuality(home)).toBe('accurate');
    writeSettings({ settings: { [SEGMENT_QUALITY_SETTING]: 'fast', 'appearance.theme': 'light' } });
    expect(await readSegmentQuality(home)).toBe('fast');
  });

  test('is undefined (the sidecar default applies) without a file, a namespace, a key or a known value', async () => {
    expect(await readSegmentQuality(home)).toBeUndefined();
    writeSettings({ keymap: { a: 1 } });
    expect(await readSegmentQuality(home)).toBeUndefined();
    writeSettings({ settings: { 'appearance.theme': 'light' } });
    expect(await readSegmentQuality(home)).toBeUndefined();
    writeSettings({ settings: { [SEGMENT_QUALITY_SETTING]: 'turbo' } });
    expect(await readSegmentQuality(home)).toBeUndefined();
    writeSettings({ settings: [1, 2] });
    expect(await readSegmentQuality(home)).toBeUndefined();
  });

  test('a corrupt document does not throw', async () => {
    writeFileSync(join(home, SETTINGS_FILE), '{ not json');
    expect(await readSegmentQuality(home)).toBeUndefined();
  });
});
