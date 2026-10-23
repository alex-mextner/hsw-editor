/**
 * Registers the vision jobs on the default job registry and mounts the status module. Imported once for its side
 * effect by the daemon entry (`import './vision/register.ts'`); nothing starts until the first `vision.*` job runs.
 */
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.ts';
import { modules } from '../modules.ts';
import { HttpVisionClient } from './client.ts';
import { readBankIndex } from './bank-index.ts';
import { registerVisionJobs } from './jobs.ts';
import { createVisionModule } from './routes.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');

const client = new HttpVisionClient({ repoRoot: REPO_ROOT });

registerVisionJobs({
  client,
  wallDir: (wallId) => join(loadConfig().home, 'walls', wallId),
  bankIndex: readBankIndex,
});
modules.push(createVisionModule(client));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void client.stop();
  });
}
