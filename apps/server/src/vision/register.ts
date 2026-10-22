/**
 * Registers the vision jobs on the default job registry and mounts the status module. Imported once for its side
 * effect by the daemon entry (`import './vision/register.ts'`); nothing starts until the first `vision.*` job runs.
 */
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type JsonValue } from '@hsw-editor/core';
import { loadConfig } from '../config.ts';
import { modules } from '../modules.ts';
import { HttpVisionClient } from './client.ts';
import { registerVisionJobs } from './jobs.ts';
import { createVisionModule } from './routes.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const BANK_TIMEOUT_MS = 3000;

const client = new HttpVisionClient({ repoRoot: REPO_ROOT });

registerVisionJobs({
  client,
  wallDir: (wallId) => join(loadConfig().home, 'walls', wallId),
  homeDir: () => loadConfig().home,
  async bankIndex(): Promise<JsonValue | null> {
    const { host, port } = loadConfig();
    try {
      const response = await fetch(`http://${host}:${port}/api/bank/index`, {
        signal: AbortSignal.timeout(BANK_TIMEOUT_MS),
      });
      return response.ok ? z.json().parse(await response.json()) : null;
    } catch {
      return null;
    }
  },
});
modules.push(createVisionModule(client));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void client.stop();
  });
}
