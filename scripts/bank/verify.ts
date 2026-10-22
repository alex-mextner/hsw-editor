/** `bun run bank:verify [--seed]`: checks the built bank (default) or the committed seed. */
import { bankPaths } from '../../packages/bank/src/node/paths.ts';
import { verifyBank } from '../../packages/bank/src/node/verify.ts';

const paths = bankPaths();
const root = process.argv.includes('--seed') ? paths.seedDir : paths.bankDir;
const result = await verifyBank(root);
console.info(`verified ${result.checked} elements in ${root}: ${result.problems.length} problems`);
for (const problem of result.problems.slice(0, 50)) console.error(`  ${problem}`);
process.exit(result.problems.length > 0 ? 1 : 0);
