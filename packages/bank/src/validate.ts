import { getCategory } from './categories.ts';
import { BankIndexSchema, type BankElement, type BankIndex } from './schema.ts';
import { getToolClass } from './toolClasses.ts';

export type ValidationResult = { ok: true; index: BankIndex } | { ok: false; errors: string[] };

const NON_REDISTRIBUTABLE_LICENSES = new Set([
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
  'LicenseRef-Standard-Digital-File',
  'LicenseRef-Unknown',
]);

const DIM_TOLERANCE_MM = 0.01;

function checkElement(e: BankElement, errors: string[]): void {
  const at = (msg: string): void => {
    errors.push(`${e.id}: ${msg}`);
  };
  if (!getCategory(e.category)) at(`unknown category ${e.category}`);
  for (const t of e.toolClasses) if (!getToolClass(t)) at(`unknown tool class ${t}`);
  for (const f of e.fitsTool) {
    if (!getToolClass(f.toolClass)) at(`fitsTool references unknown class ${f.toolClass}`);
    for (const [key, range] of Object.entries(f.dims ?? {})) {
      if (range.min > range.max) at(`fitsTool ${f.toolClass}.${key} has min > max`);
    }
  }

  const keys = new Set(e.footprint.cells.map((c) => `${c.dCol},${c.dRow2}`));
  if (keys.size !== e.footprint.cells.length) at('footprint has duplicate cells');
  if (!keys.has('0,0')) at('footprint must contain the anchor cell {0,0}');
  for (const c of e.mounting.cells)
    if (!keys.has(`${c.dCol},${c.dRow2}`)) at('mounting cell outside footprint');
  if (e.mounting.kind !== 'none' && e.mounting.cells.length === 0)
    at('mounting kind set but no mounting cells');
  const cols =
    Math.max(...e.footprint.cells.map((c) => c.dCol)) -
    Math.min(...e.footprint.cells.map((c) => c.dCol)) +
    1;
  const dRows = e.footprint.cells.map((c) => c.dRow2);
  const rows = Math.ceil((Math.max(...dRows) - Math.min(...dRows)) / 2) + 1;
  if (rows !== e.footprint.rows)
    at(`footprint.rows ${e.footprint.rows} != ${rows} derived from cells`);
  if (cols !== e.footprint.cols)
    at(`footprint.cols ${e.footprint.cols} != ${cols} derived from cells`);

  for (const axis of ['x', 'y', 'z'] as const) {
    const extent = e.bboxMm.max[axis] - e.bboxMm.min[axis];
    if (extent <= 0) at(`bboxMm has no extent on ${axis}`);
    if (Math.abs(extent - e.dimsMm[axis]) > DIM_TOLERANCE_MM)
      at(`dimsMm.${axis} disagrees with bboxMm`);
  }
  if (e.bboxMm.min.z < -DIM_TOLERANCE_MM)
    at('element protrudes behind the wall face (bboxMm.min.z < 0)');

  if (e.generated !== (e.provenance.origin === 'generated'))
    at('generated flag disagrees with provenance.origin');
  if (e.provenance.origin === 'generated') {
    if (!e.provenance.generator) at('generated element without provenance.generator');
  } else if (!e.provenance.source) {
    at('non-generated element without provenance.source');
  }
  if (NON_REDISTRIBUTABLE_LICENSES.has(e.license.spdx) && e.license.redistributable) {
    at(`licence ${e.license.spdx} must not be marked redistributable`);
  }
  if (e.params) {
    const paramKeys = new Set<string>();
    for (const p of e.params) {
      if (paramKeys.has(p.key)) at(`duplicate param ${p.key}`);
      paramKeys.add(p.key);
    }
    if (e.provenance.generator) {
      for (const key of Object.keys(e.provenance.generator.values)) {
        if (!paramKeys.has(key)) at(`generator value ${key} has no ParamDef`);
      }
    }
  }
}

/** Schema validation plus the cross-field invariants the schema alone cannot express. */
export function validateBankIndex(raw: unknown): ValidationResult {
  const parsed = BankIndexSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const index = parsed.data;
  const errors: string[] = [];

  const ids = new Set<string>();
  for (const e of index.elements) {
    if (ids.has(e.id)) errors.push(`${e.id}: duplicate element id`);
    ids.add(e.id);
    checkElement(e, errors);
  }
  const hashes = new Map<string, string>();
  for (const e of index.elements) {
    const owner = hashes.get(e.provenance.geometryHash);
    // Generated rungs may legitimately reproduce a source geometry; only source elements must be unique.
    if (owner !== undefined && !e.generated) {
      errors.push(`${e.id}: same geometry hash as ${owner} (duplicate element)`);
    }
    if (!e.generated) hashes.set(e.provenance.geometryHash, e.id);
  }
  const categoryIds = new Set(index.categories.map((c) => c.id));
  for (const c of index.categories) {
    if (c.parent !== undefined && !categoryIds.has(c.parent))
      errors.push(`category ${c.id}: unknown parent ${c.parent}`);
  }
  const generated = index.elements.filter((e) => e.generated).length;
  const expected = {
    total: index.elements.length,
    generated,
    fromSources: index.elements.length - generated,
    redistributable: index.elements.filter((e) => e.license.redistributable).length,
  };
  for (const [key, value] of Object.entries(expected)) {
    const actual = index.counts[key as keyof typeof expected];
    if (actual !== value) errors.push(`counts.${key} is ${actual}, expected ${value}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, index };
}
