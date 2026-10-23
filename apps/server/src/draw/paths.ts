import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface DrawPaths {
  /** `~/.local/share/hsw-editor`; `HSW_EDITOR_DATA_DIR` wins, else the daemon's `HSW_EDITOR_HOME` (so the CLI and the daemon agree). */
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

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/** The daemon's `HSW_EDITOR_HOME` read the way `cli/hsw_editor.py` reads it (empty = unset, a leading `~` is the home dir). */
function daemonHome(env: NodeJS.ProcessEnv, userHome: string): string | undefined {
  const raw = nonEmpty(env['HSW_EDITOR_HOME']);
  if (raw === undefined) return undefined;
  return resolve(raw === '~' || raw.startsWith('~/') ? join(userHome, raw.slice(1)) : raw);
}

export function resolveDrawPaths(env: NodeJS.ProcessEnv = process.env): DrawPaths {
  const dataDir =
    nonEmpty(env['HSW_EDITOR_DATA_DIR']) ??
    daemonHome(env, env['HOME'] ?? homedir()) ??
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
