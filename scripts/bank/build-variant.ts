/**
 * `bun run bank:build-variant <elementId> key=value ...`: renders a parametric element at the given
 * dimensions through OpenSCAD (cached by parameter hash) and prints the VariantResponse.
 */
import { join } from 'node:path';
import { BankIndexSchema } from '../../packages/bank/src/schema.ts';
import { bankPaths } from '../../packages/bank/src/node/paths.ts';
import { buildVariant, VariantError } from '../../packages/bank/src/node/variant.ts';

const [id, ...assignments] = process.argv.slice(2);
if (!id) {
  console.error('usage: bun run bank:build-variant <elementId> [key=value ...]');
  process.exit(2);
}
const params: Record<string, number> = {};
for (const assignment of assignments) {
  const [key, value] = assignment.split('=');
  if (!key || value === undefined || value.trim() === '' || !Number.isFinite(Number(value))) {
    console.error(`bad parameter "${assignment}", expected key=number`);
    process.exit(2);
  }
  params[key] = Number(value);
}

const paths = bankPaths();
const root = (await Bun.file(join(paths.bankDir, 'index.json')).exists())
  ? paths.bankDir
  : paths.seedDir;
const index = BankIndexSchema.parse(await Bun.file(join(root, 'index.json')).json());
const element = index.elements.find((e) => e.id === id);
if (!element) {
  console.error(`unknown element ${id}`);
  process.exit(2);
}
try {
  console.info(JSON.stringify(await buildVariant(paths, element, params), null, 2));
} catch (error) {
  if (error instanceof VariantError) {
    console.error(`${error.status}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
