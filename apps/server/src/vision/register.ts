/**
 * Registers the vision jobs on the default job registry and mounts the status module. Imported once for its side
 * effect by the daemon entry (`import './vision/register.ts'`); nothing starts until the first `vision.*` job runs.
 */
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { modules } from '../modules.ts';
import { readBankIndex } from './bank-index.ts';
import { registerVisionJobs } from './jobs.ts';
import { createVisionModule } from './routes.ts';
import { visionClient as client } from './shared.ts';

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
