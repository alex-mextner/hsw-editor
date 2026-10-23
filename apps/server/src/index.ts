import { loadConfig } from './config.ts';
import { startServer } from './server.ts';
// Registers the vision jobs and the status module; nothing starts until the first `vision.*` job runs.
import './vision/register.ts';
// Registers photo.clean (the cleaned background under the board) and the /api/draw routes.
import './photo-clean/register.ts';

const config = loadConfig();
const running = await startServer(config);
console.info(`hsw-editor listening on ${running.url} (home ${config.home})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.stop().finally(() => process.exit(0));
  });
}
