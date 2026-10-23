import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface BankPaths {
  /** Repository root (contains scripts/bank and packages/bank). */
  repoRoot: string;
  /** Built bank served by the server: index.json, search-index.json, glb/, thumb/, variant/. */
  bankDir: string;
  /** Scratch and caches of the pipeline. */
  cacheDir: string;
  /** Python virtualenv of scripts/bank/py (uv). */
  venvDir: string;
  /** The HSW project holding downloaded models, catalog and refit sources. */
  sourcesDir: string;
  /** Committed seed (redistributable subset). */
  seedDir: string;
  /** Directory with the OpenSCAD generators and families.json. */
  generatorsDir: string;
  /** Honeycomb lattice of the bank (mm). */
  grid: { colPitchMm: number; rowPitchMm: number };
}

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export function bankPaths(env: Record<string, string | undefined> = process.env): BankPaths {
  const home = homedir();
  // same resolution as the daemon's data home (apps/server config.ts): HSW_EDITOR_HOME, else $XDG_DATA_HOME/hsw-editor
  const data =
    env.HSW_EDITOR_HOME ?? join(env.XDG_DATA_HOME ?? join(home, '.local/share'), 'hsw-editor');
  const cache = env.HSW_EDITOR_CACHE_DIR ?? join(home, '.cache/hsw-editor');
  return {
    repoRoot: REPO_ROOT,
    bankDir: env.HSW_BANK_DIR ?? join(data, 'bank'),
    cacheDir: join(cache, 'bank-build'),
    venvDir: join(cache, 'bank-venv'),
    sourcesDir: env.HSW_SOURCES_DIR ?? join(home, 'dev/garage-band/projects/HSW'),
    seedDir: join(REPO_ROOT, 'packages/bank/seed'),
    generatorsDir: env.HSW_BANK_GENERATORS_DIR ?? join(REPO_ROOT, 'packages/bank/generators'),
    grid: { colPitchMm: 20.4382, rowPitchMm: 23.6 },
  };
}
