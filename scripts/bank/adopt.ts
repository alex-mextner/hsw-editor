/**
 * `bun run bank:adopt <dir>`: publishes the bank found in <dir> (a flat tree with index.json, glb/, thumb/:
 * a legacy bank, a copy of the seed, an export from another machine) as a new verified generation of the
 * bank dir. Elements whose files are missing or corrupt are withheld and listed as `unavailable`.
 *
 * Exit codes: 0 published (or identical to current), 1 refused or failed, 2 usage.
 */
import { BankVerificationError } from '../../packages/bank/src/node/generations.ts';
import { bankPaths } from '../../packages/bank/src/node/paths.ts';
import { adoptBank } from '../../packages/bank/src/node/publish.ts';

const source = process.argv[2];
if (!source) {
  console.error('usage: bun run bank:adopt <dir>');
  process.exit(2);
}
let adopted: Awaited<ReturnType<typeof adoptBank>>;
try {
  adopted = await adoptBank(bankPaths(), source);
} catch (error) {
  if (!(error instanceof BankVerificationError)) throw error;
  console.error(error.message);
  process.exit(1);
}
const { publish, withheld } = adopted;
console.info(
  `${publish.unchanged ? 'unchanged' : 'published'} generation ${publish.id}: ${publish.elements} elements, ${withheld.length} withheld` +
    (publish.pruned.length > 0 ? `; pruned ${publish.pruned.join(', ')}` : ''),
);
for (const w of withheld.slice(0, 20)) console.warn(`  withheld ${w.id}: ${w.reason}`);
