import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DrawPaths {
  /** `~/.local/share/hsw-editor` (or HSW_EDITOR_DATA_DIR). */
  readonly dataDir: string;
  /** Persisted settings, per-backend guard state, manual jobs, owner locks. */
  readonly drawDir: string;
  readonly settingsFile: string;
  readonly guardFile: string;
  readonly chatgptLockFile: string;
  /** DEDICATED ChatGPT browser profile. Never a chatgpt-guardian profile. */
  readonly chatgptProfileDir: string;
  /** Generated images and manual-upload job dirs (`manual-<id>/`). */
  readonly workDir: string;
}

export function resolveDrawPaths(env: NodeJS.ProcessEnv = process.env): DrawPaths {
  const dataDir =
    env['HSW_EDITOR_DATA_DIR'] ??
    join(env['XDG_DATA_HOME'] ?? join(env['HOME'] ?? homedir(), '.local/share'), 'hsw-editor');
  const drawDir = join(dataDir, 'draw');
  return {
    dataDir,
    drawDir,
    settingsFile: join(drawDir, 'settings.json'),
    guardFile: join(drawDir, 'guard.json'),
    chatgptLockFile: join(drawDir, 'chatgpt-owner.lock'),
    chatgptProfileDir: env['HSW_CHATGPT_PROFILE'] ?? join(dataDir, 'chatgpt-profile'),
    workDir: join(drawDir, 'work'),
  };
}
