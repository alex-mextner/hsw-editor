/**
 * `bun run bank:ingest [--force] [--only <text>] [--generated-only] [--report] [--seed] [--json]`
 *
 * Builds ~/.local/share/hsw-editor/bank (GLB + thumbnails + index + search index) from the HSW sources
 * and the parametric families. `--seed` then refreshes the committed packages/bank/seed from it.
 */
import { ingest, reportMarkdown } from '../../packages/bank/src/node/ingest.ts';
import { bankPaths } from '../../packages/bank/src/node/paths.ts';
import { exportSeed } from '../../packages/bank/src/node/seed.ts';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(name);
const valueOf = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const paths = bankPaths();
const started = performance.now();
const only = valueOf('--only');
const report = await ingest(paths, {
  force: flag('--force'),
  generatedOnly: flag('--generated-only'),
  ...(only ? { only } : {}),
});
const seconds = ((performance.now() - started) / 1000).toFixed(1);

if (flag('--json')) {
  console.info(JSON.stringify(report, null, 2));
} else {
  const c = report.counts;
  console.info(
    `${report.upToDate ? 'up to date' : 'ingested'} in ${seconds}s: ${c.total} elements ` +
      `(${c.fromSources} from sources, ${c.generated} generated, ${c.redistributable} redistributable); ` +
      `failed ${report.failed.length}, skipped ${report.skipped.length}, uncurated ${report.uncurated.length}`,
  );
  if (flag('--report')) console.info(reportMarkdown(report));
}
if (flag('--seed')) {
  const seed = await exportSeed(paths);
  console.info(
    `seed: ${seed.elements} elements, ${(seed.bytes / 1024).toFixed(0)} KiB (${seed.excluded} elements left out: non-redistributable licences or over the size budget)`,
  );
}
process.exit(report.failed.length > 0 ? 1 : 0);
