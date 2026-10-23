/**
 * omp host configuration: `~/.config/hsw-editor/config.json` key `omp` (shared with the CLI), with
 * `HSW_EDITOR_OMP_*` environment overrides. Unknown keys are ignored; bad values fall back to defaults.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DestructiveOpsPolicy, OmpPublicConfig } from '@hsw-editor/omp-protocol';
import { defaultHome } from '../config.ts';

export type ApprovalMode = 'always-ask' | 'write' | 'yolo';

export interface OmpConfig {
  /** argv prefix that starts omp (default `['omp']`); tests point it at a scripted fake. */
  readonly command: readonly string[];
  readonly model?: string;
  readonly thinking?: string;
  /** omp tool approval mode (`yolo` auto-approves every tool, including bash: never the default). */
  readonly approvalMode: ApprovalMode;
  /** Extra argv appended after our own (power users: `--profile`, `--tools`, ...). */
  readonly extraArgs: readonly string[];
  /** Variables copied from the server environment to the child, in addition to the safe base set. */
  readonly envPassthrough: readonly string[];
  readonly destructiveOps: DestructiveOpsPolicy;
  /** Removing more than this many items in one agent call needs approval (policy `ask`). */
  readonly destructiveThreshold: number;
  /** Answer omp's own "Allow tool: wall_*" prompt for our host tools automatically. */
  readonly autoApproveWallTools: boolean;
  readonly maxChildren: number;
  readonly idleStopMs: number;
  /** Wall store root (`HSW_EDITOR_HOME`); omp session dirs live under `<dataDir>/omp/<wallId>`. */
  readonly dataDir: string;
  /** Working directory for omp when the wall directory does not exist yet. */
  readonly fallbackCwd: string;
}

export const DEFAULT_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
];

/** Where omp keeps one directory of conversation files per wall (`<dataDir>/omp/<wallId>`). */
export function sessionDirFor(config: Pick<OmpConfig, 'dataDir'>, wallId: string): string {
  return join(config.dataDir, 'omp', wallId);
}

function configPath(env: Record<string, string | undefined>): string {
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'hsw-editor', 'config.json');
}

type Raw = {
  [key: string]: string | number | boolean | null | Raw | (string | number | boolean | null)[];
};

function readRaw(path: string): Raw {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Raw | string | number | null;
    const omp = typeof parsed === 'object' && parsed !== null ? parsed['omp'] : undefined;
    return typeof omp === 'object' && omp !== null && !Array.isArray(omp) ? omp : {};
  } catch {
    return {};
  }
}

function stringArray(value: Raw[string] | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : undefined;
}

function oneOf<T extends string>(
  value: Raw[string] | string | undefined,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function nonNegativeInt(value: Raw[string] | string | undefined): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

function positiveInt(value: Raw[string] | string | undefined): number | undefined {
  const n = nonNegativeInt(value);
  return n !== undefined && n >= 1 ? n : undefined;
}

/** `HSW_EDITOR_OMP_COMMAND`: a JSON array (paths with spaces), else whitespace-separated words. */
function parseCommand(text: string): readonly string[] | undefined {
  if (!text.trimStart().startsWith('[')) return nonEmpty(text.split(/\s+/).filter(Boolean));
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((word) => typeof word === 'string')
      ? nonEmpty(parsed as string[])
      : undefined;
  } catch {
    return undefined;
  }
}

/** An empty argv cannot start anything: treat it as "not configured". */
function nonEmpty(words: readonly string[] | undefined): readonly string[] | undefined {
  return words !== undefined && words.length > 0 ? words : undefined;
}

export function loadOmpConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<OmpConfig> = {},
): OmpConfig {
  const raw = readRaw(configPath(env));
  const dataDir = overrides.dataDir ?? resolve(env['HSW_EDITOR_HOME'] ?? defaultHome(env));
  const model =
    env['HSW_EDITOR_OMP_MODEL'] ?? (typeof raw['model'] === 'string' ? raw['model'] : undefined);
  const thinking =
    env['HSW_EDITOR_OMP_THINKING'] ??
    (typeof raw['thinking'] === 'string' ? raw['thinking'] : undefined);
  const command = nonEmpty(stringArray(raw['command']));
  const envCommand = env['HSW_EDITOR_OMP_COMMAND'];
  const idleStopMinutes = nonNegativeInt(raw['idleStopMinutes']);
  return {
    command:
      overrides.command ??
      (envCommand ? parseCommand(envCommand) : undefined) ??
      command ??
      ['omp'],
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    approvalMode:
      oneOf(env['HSW_EDITOR_OMP_APPROVAL'], ['always-ask', 'write', 'yolo']) ??
      oneOf(raw['approvalMode'], ['always-ask', 'write', 'yolo']) ??
      'write',
    extraArgs: stringArray(raw['extraArgs']) ?? [],
    envPassthrough: [...DEFAULT_ENV_PASSTHROUGH, ...(stringArray(raw['envPassthrough']) ?? [])],
    destructiveOps: oneOf(raw['destructiveOps'], ['ask', 'allow', 'deny']) ?? 'ask',
    destructiveThreshold: nonNegativeInt(raw['destructiveThreshold']) ?? 5,
    autoApproveWallTools: raw['autoApproveWallTools'] !== false,
    maxChildren: positiveInt(raw['maxChildren']) ?? 3,
    idleStopMs: (idleStopMinutes ?? 10) * 60_000,
    dataDir,
    fallbackCwd: join(dataDir, 'omp-workspace'),
    ...overrides,
  };
}

export function publicConfig(config: OmpConfig): OmpPublicConfig {
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.thinking ? { thinking: config.thinking } : {}),
    approvalMode: config.approvalMode,
    destructiveOps: config.destructiveOps,
    destructiveThreshold: config.destructiveThreshold,
  };
}

/** Environment for the omp child: base variables, user allow-list, and `OMP_*` / `PI_*` knobs. */
export function childEnv(
  config: OmpConfig,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (config.envPassthrough.includes(key) || key.startsWith('OMP_') || key.startsWith('PI_')) {
      env[key] = value;
    }
  }
  return env;
}
