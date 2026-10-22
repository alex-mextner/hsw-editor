/**
 * `bun run bank:verify [--seed] [--root <dir>] [--all] [--quick] [--no-bounds] [--json]`
 *
 * Verifies the built bank (the current generation; legacy flat bank when nothing was published), the
 * committed seed (`--seed`), one directory (`--root`) or every retained generation (`--all`): index parses
 * and matches its contentHash, every glb/thumbnail exists with the recorded size and sha256, GLB bounds
 * equal the index. This is the gate behind CI and the pre-ship check.
 *
 * Exit codes: 0 consistent, 1 problems found, 3 nothing to verify (no bank built).
 */
import { bankPaths } from '../../packages/bank/src/node/paths.ts';
import { builtBankRoot, listGenerations } from '../../packages/bank/src/node/generations.ts';
import { verifyBank, type VerifyResult } from '../../packages/bank/src/node/verify.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const rootFlag = args.indexOf('--root');
const rootArg = rootFlag >= 0 ? args[rootFlag + 1] : undefined;
if (rootFlag >= 0 && (rootArg === undefined || rootArg.startsWith('--'))) {
  console.error('usage: --root <dir>');
  process.exit(2);
}
const paths = bankPaths();

const roots: string[] = [];
if (rootArg) roots.push(rootArg);
else if (flag('--seed')) roots.push(paths.seedDir);
else if (flag('--all')) roots.push(...(await listGenerations(paths)).map((g) => g.root));
else {
  const built = await builtBankRoot(paths);
  if (built) roots.push(built);
}
if (roots.length === 0) {
  console.error(
    `no built bank in ${paths.bankDir}: run \`bun run bank:ingest\` (the seed is served until then)`,
  );
  process.exit(3);
}

const results: { root: string; result: VerifyResult }[] = [];
for (const root of roots) {
  results.push({
    root,
    result: await verifyBank(root, { quick: flag('--quick'), bounds: !flag('--no-bounds') }),
  });
}
const failed = results.some((r) => r.result.problems.length > 0);

if (flag('--json')) {
  console.info(
    JSON.stringify({
      ok: !failed,
      roots: results.map((r) => ({
        root: r.root,
        checked: r.result.checked,
        contentHash: r.result.contentHash ?? null,
        problems: r.result.problems,
      })),
    }),
  );
} else {
  for (const { root, result } of results) {
    console.info(
      `verified ${result.checked} elements in ${root}: ${result.problems.length} problems`,
    );
    for (const problem of result.problems.slice(0, 50)) console.error(`  ${problem}`);
    if (result.problems.length > 50) console.error(`  ... and ${result.problems.length - 50} more`);
  }
}
process.exit(failed ? 1 : 0);
