import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface BankPaths {
  /** Repository root (contains scripts/bank and packages/bank). */
  repoRoot: string;
  /** Built bank served by the server: index.json, search-index.json, glb/, thumb/, variant/. */
  bankDir: string;
  /** Scratch and caches of the pipeline. */
  cacheDir: string;
  /** The HSW project holding downloaded models, catalog and refit sources. */
  sourcesDir: string;
  /** Committed seed (redistributable subset). */
  seedDir: string;
}

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

export function bankPaths(env: Record<string, string | undefined> = process.env): BankPaths {
  const home = homedir();
  const data = env.HSW_EDITOR_DATA_DIR ?? join(home, '.local/share/hsw-editor');
  const cache = env.HSW_EDITOR_CACHE_DIR ?? join(home, '.cache/hsw-editor');
  return {
    repoRoot: REPO_ROOT,
    bankDir: env.HSW_BANK_DIR ?? join(data, 'bank'),
    cacheDir: join(cache, 'bank-build'),
    sourcesDir: env.HSW_SOURCES_DIR ?? join(home, 'dev/garage-band/projects/HSW'),
    seedDir: join(REPO_ROOT, 'packages/bank/seed'),
  };
}
