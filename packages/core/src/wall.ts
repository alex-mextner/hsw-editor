/** Parsing and versioning of stored wall documents. */
import { z } from 'zod';
import { isJsonObject, type JsonValue } from './json.ts';
import { checkIntegrity } from './ops.ts';
import { OpSchema, type Op, WALL_SCHEMA_VERSION, WallSchema, type Wall } from './schema.ts';

/** Upgrades a document of schemaVersion `n` to `n + 1`. Keyed by the version it upgrades *from*. */
export type WallMigrations = Readonly<
  Record<number, (doc: { [key: string]: JsonValue }) => { [key: string]: JsonValue }>
>;

/** Registered migrations. Empty while schemaVersion 1 is the only version; add `1: (doc) => ...` with the next bump. */
export const WALL_MIGRATIONS: WallMigrations = {};

export class WallParseError extends Error {
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message}: ${issues.join('; ')}` : message);
    this.name = 'WallParseError';
    this.issues = issues;
  }
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
}

/** Runs the migration chain from the document's `schemaVersion` up to the current one. */
export function migrateWall(
  raw: JsonValue,
  migrations: WallMigrations = WALL_MIGRATIONS,
  target: number = WALL_SCHEMA_VERSION,
): { [key: string]: JsonValue } {
  if (!isJsonObject(raw)) throw new WallParseError('wall document must be a JSON object');
  let doc = raw;
  let version = doc['schemaVersion'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new WallParseError('wall document has no integer schemaVersion');
  }
  if (version > target) {
    throw new WallParseError(
      `wall schemaVersion ${version} is newer than this build supports (${target}); upgrade hsw-editor`,
    );
  }
  while (version < target) {
    const migrate = migrations[version];
    if (migrate === undefined)
      throw new WallParseError(`no migration from schemaVersion ${version}`);
    doc = migrate(doc);
    version += 1;
    doc = { ...doc, schemaVersion: version };
  }
  return doc;
}

/** Migrates, validates against the schema and checks id uniqueness. */
export function parseWall(raw: JsonValue): Wall {
  const parsed = WallSchema.safeParse(migrateWall(raw));
  if (!parsed.success) throw new WallParseError('invalid wall', formatIssues(parsed.error));
  const problems = checkIntegrity(parsed.data);
  if (problems.length > 0) throw new WallParseError('inconsistent wall', problems);
  return parsed.data;
}

export function parseOp(raw: JsonValue): Op {
  const parsed = OpSchema.safeParse(raw);
  if (!parsed.success) throw new WallParseError('invalid op', formatIssues(parsed.error));
  return parsed.data;
}

/** JSON Schema of the op union, for agent tool definitions (omp `wall_apply`). */
export function opJsonSchema() {
  return z.toJSONSchema(OpSchema, { io: 'input' });
}
