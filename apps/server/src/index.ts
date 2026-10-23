import { loadConfig } from './config.ts';
import { startServer } from './server.ts';

const config = loadConfig();
const running = await startServer(config);
console.info(`hsw-editor listening on ${running.url} (home ${config.home})`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void running.stop().finally(() => process.exit(0));
  });
}
