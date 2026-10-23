/** Writes packages/bank/schema/bank-index.schema.json from the zod schema (`--check` verifies it is current). */
import { resolve } from 'node:path';
import { bankIndexJsonSchema } from '../../packages/bank/src/schema.ts';

const target = resolve(import.meta.dir, '../../packages/bank/schema/bank-index.schema.json');
const text = `${JSON.stringify(bankIndexJsonSchema(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  // compare as data: the committed file is formatted by oxfmt, the generated text is not
  const current = (await Bun.file(target).exists()) ? await Bun.file(target).text() : '';
  if (JSON.stringify(JSON.parse(current || 'null')) !== JSON.stringify(JSON.parse(text))) {
    console.error('bank-index.schema.json is stale: run `bun run bank:schema`');
    process.exit(1);
  }
} else {
  await Bun.write(target, text);
  // keep the committed file in the repo's formatting so `format:check` accepts it
  const formatter = Bun.spawnSync([
    resolve(import.meta.dir, '../../node_modules/.bin/oxfmt'),
    '--write',
    target,
  ]);
  if (formatter.exitCode !== 0) {
    console.error(formatter.stderr.toString());
    process.exit(1);
  }
  console.info(`wrote ${target}`);
}
