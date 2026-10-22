import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_DRAW_SETTINGS, type DrawSettings, parseDrawSettings } from '@hsw-editor/draw';

export async function loadSettings(file: string): Promise<DrawSettings> {
  try {
    return parseDrawSettings(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return DEFAULT_DRAW_SETTINGS;
  }
}

export async function saveSettings(file: string, settings: DrawSettings): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const partial = `${file}.${process.pid}.part`;
  await writeFile(partial, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
  await rename(partial, file);
}
