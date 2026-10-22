/**
 * The bank ingestion pipeline: sources + generators -> normalised GLB (LOD0/LOD1) + thumbnails +
 * `index.json` / `search-index.json` / `report.json` in the bank dir.
 *
 * Idempotent and incremental: every element has a content key (source hash, part, orientation, tool
 * versions); built artefacts live under `<cache>/elements/<key>/` and are reused. A fingerprint over
 * all inputs makes an unchanged rerun a no-op that only stats the source files.
 */
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { SOURCE_CURATION, SOURCE_SKIPS, type CurationEntry } from '../../curation/sources.ts';
import { BANK_CATEGORIES } from '../categories.ts';
import { expandFamily, FamilyFileSchema, type FamilySpec, type Rung } from '../families.ts';
import {
  BANK_SCHEMA_VERSION,
  type BankElement,
  type BankIndex,
  type FitsTool,
  type License,
  type Provenance,
} from '../schema.ts';
import { categoryVocabulary } from '../categories.ts';
import { toolClassVocabulary } from '../toolClasses.ts';
import { buildSearchIndex, serializeSearchIndex } from '../search.ts';
import { TOOL_CLASSES } from '../toolClasses.ts';
import { validateBankIndex } from '../validate.ts';
import { compressGlb } from './compress.ts';
import { clusterParts, type Candidate, type Cluster } from './dedupe.ts';
import { runMeshTool } from './exec.ts';
import { normalizeLicense } from './license.ts';
import type { AnchorMode, BuildItem, BuildResult, Orientation } from './meshTool.ts';
import type { BankPaths } from './paths.ts';
import { buildCodeHash, codeFingerprint } from './fingerprint.ts';
import { artefactInputs, geometryOf } from './geometry.ts';
import { collectVariantGarbage } from './variant.ts';
import { renderMissing, scadKey, stlHash, type ScadJob } from './scad.ts';
import { MESH_TOOL_VERSION, scanSources, type SourceFile } from './sources.ts';

const BUILD_BATCH = 24;
const GENERATOR_ORIENT: Orientation = { out: '+z', up: '+y' };

export interface IngestOptions {
  /** Rebuild every element even when cached. */
  force?: boolean;
  /** Only elements whose id contains this text (for quick iterations); the index then is partial. */
  only?: string;
  /** Skip the HSW source tree: build the generated families only (fast iteration on generators). */
  generatedOnly?: boolean;
  log?: (line: string) => void;
}

export interface ReportEntry {
  id?: string;
  source?: string;
  reason: string;
}

export interface IngestReport {
  upToDate: boolean;
  counts: BankIndex['counts'] & { distinctSourceGeometries: number; duplicateSourceFiles: number };
  ingested: string[];
  skipped: ReportEntry[];
  failed: ReportEntry[];
  /** Distinct geometries without a curation entry (not ingested). */
  uncurated: ReportEntry[];
  /** Curation entries that match no geometry in the sources. */
  orphans: ReportEntry[];
  unreadable: ReportEntry[];
  notRedistributable: { id: string; license: string }[];
  /** Sizes of the built bank, bytes. */
  bytes: { glb: number; thumbnails: number };
}

interface Plan {
  id: string;
  key: string;
  category: string;
  name: BankElement['name'];
  tags: BankElement['tags'];
  toolClasses: string[];
  fitsTool: FitsTool[];
  mountKind: CurationEntry['mount'];
  family?: string;
  variantLabel?: BankElement['variantLabel'];
  params?: FamilySpec['params'];
  printNotes?: BankElement['printNotes'];
  build: Pick<BuildItem, 'path' | 'partId' | 'orient' | 'anchor'>;
  orientation: Provenance['orientation'];
  provenance: Omit<Provenance, 'geometryHash' | 'orientation'> & { geometryHash: string };
  license: License;
}

interface ElementBuild {
  key: string;
  result: NonNullable<BuildResult['items'][number]>;
  lod0: string;
  lod1: string;
  thumbnail: string;
  trianglesLod0: number;
  trianglesLod1: number;
}

type PartCandidate = Candidate & { file: SourceFile; partId: string };

function sha256(text: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

function priorityOf(file: SourceFile): number {
  let priority = file.kind === 'stl' ? -30 : file.kind === '3mf' ? -20 : -10;
  if (file.rel.startsWith('sources/catalog')) priority -= 5;
  if (file.rel.startsWith('refit/')) priority -= 3;
  if (file.rel.startsWith('models/')) priority += 50;
  return priority;
}

/** Most restrictive licence of a duplicate cluster: geometry shared with a restricted file stays restricted. */
function clusterLicense(members: PartCandidate[]): License {
  const restricted = members.find((m) => !m.file.origin.license.redistributable);
  return (restricted ?? members[0])!.file.origin.license;
}

async function loadFamilies(paths: BankPaths): Promise<{ spec: FamilySpec; rungs: Rung[] }[]> {
  const file = Bun.file(join(paths.generatorsDir, 'families.json'));
  if (!(await file.exists())) return [];
  const parsed = FamilyFileSchema.parse(await file.json());
  return parsed.families.map((spec) => ({ spec, rungs: expandFamily(spec) }));
}

export async function ingest(paths: BankPaths, options: IngestOptions = {}): Promise<IngestReport> {
  const log = options.log ?? ((line: string) => console.info(line));
  await mkdir(paths.cacheDir, { recursive: true });
  // Per-element artefacts depend only on the mesh tool and the compressor; the fingerprint on everything.
  const buildCode = await buildCodeHash(paths);
  const code = await codeFingerprint(paths, [
    'packages/bank/src',
    'packages/bank/curation',
    'scripts/bank/py',
  ]);
  const generatorsCode = await codeFingerprint(paths, [
    relative(paths.repoRoot, paths.generatorsDir),
  ]);

  // ---- 1. plans from sources
  const sourcesAvailable =
    !options.generatedOnly &&
    (await stat(paths.sourcesDir).then(
      (s) => s.isDirectory(),
      () => false,
    ));
  const inventory = sourcesAvailable ? await scanSources(paths) : { files: [], unreadable: [] };
  if (!sourcesAvailable && !options.generatedOnly)
    log(`sources dir ${paths.sourcesDir} not found: only generated elements are built`);

  const candidates: PartCandidate[] = [];
  for (const file of inventory.files) {
    for (const part of file.probe.parts) {
      candidates.push({
        key: `${file.rel}#${part.partId}`,
        priority: priorityOf(file),
        part,
        file,
        partId: part.partId,
      });
    }
  }
  const clusters: Cluster<PartCandidate>[] = clusterParts(candidates);

  const curationByKey = new Map<string, CurationEntry>();
  for (const entry of SOURCE_CURATION) {
    const key = `${entry.file}#${entry.part}`;
    if (curationByKey.has(key)) throw new Error(`duplicate curation entry for ${key}`);
    curationByKey.set(key, entry);
  }
  const skipByKey = new Map(SOURCE_SKIPS.map((s) => [`${s.file}#${s.part}`, s.reason]));

  const report: IngestReport = {
    upToDate: false,
    counts: {
      total: 0,
      fromSources: 0,
      generated: 0,
      redistributable: 0,
      distinctSourceGeometries: clusters.length,
      duplicateSourceFiles: 0,
    },
    ingested: [],
    skipped: [],
    failed: [],
    uncurated: [],
    orphans: [],
    unreadable: inventory.unreadable.map((u) => ({ source: u.rel, reason: u.error })),
    notRedistributable: [],
    bytes: { glb: 0, thumbnails: 0 },
  };

  const plans: Plan[] = [];
  const usedEntries = new Set<string>();
  for (const cluster of clusters) {
    const members = [cluster.representative, ...cluster.duplicates];
    report.counts.duplicateSourceFiles += cluster.duplicates.length;
    const entryKey = members.map((m) => m.key).find((k) => curationByKey.has(k));
    const skipKey = members.map((m) => m.key).find((k) => skipByKey.has(k));
    if (entryKey === undefined) {
      if (skipKey !== undefined)
        report.skipped.push({ source: skipKey, reason: skipByKey.get(skipKey) ?? '' });
      else
        report.uncurated.push({
          source: cluster.representative.key,
          reason: 'no curation entry for this geometry',
        });
      continue;
    }
    const entry = curationByKey.get(entryKey)!;
    usedEntries.add(entryKey);
    const rep = cluster.representative;
    const guess = rep.file.probe.parts.find((p) => p.partId === rep.partId)!.guess;
    const orient: Orientation = entry.orient ?? { out: guess.out, up: guess.up };
    const anchor: AnchorMode = entry.anchor ?? 'back-bbox';
    const license = clusterLicense(members);
    const origin = rep.file.origin;
    const provenance: Plan['provenance'] = {
      origin: origin.origin,
      source: {
        site: origin.site,
        ...(origin.modelId ? { modelId: origin.modelId } : {}),
        ...(origin.title ? { title: origin.title } : {}),
        ...(origin.author ? { author: origin.author } : {}),
        ...(origin.url ? { url: origin.url } : {}),
        file: rep.file.rel,
        ...(rep.partId !== '0' ? { partId: rep.partId } : {}),
        sourceSha256: rep.file.sha256,
      },
      geometryHash: rep.part.geometryHash,
      duplicates: cluster.duplicates.map((d) => d.key),
    };
    const fitsTool: FitsTool[] = entry.toolClasses.map((toolClass) => ({
      toolClass,
      ...(entry.capacity ? { capacity: entry.capacity } : {}),
    }));
    plans.push({
      id: entry.id,
      key: sha256(
        JSON.stringify([
          'src',
          buildCode,
          rep.file.sha256,
          rep.partId,
          orient,
          anchor,
          artefactInputs(entry.category),
        ]),
      ),
      category: entry.category,
      name: { ru: entry.ru, en: entry.en },
      tags: { ru: entry.tagsRu, en: entry.tagsEn },
      toolClasses: entry.toolClasses,
      fitsTool,
      mountKind: entry.mount,
      ...(entry.family ? { family: entry.family } : {}),
      ...(entry.variant ? { variantLabel: entry.variant } : {}),
      ...(entry.printNotes ? { printNotes: entry.printNotes } : {}),
      build: { path: rep.file.abs, partId: rep.partId, orient, anchor },
      orientation: entry.orient ? 'curated' : 'auto',
      provenance,
      license,
    });
  }
  for (const key of curationByKey.keys()) {
    if (!usedEntries.has(key) && sourcesAvailable)
      report.orphans.push({
        source: key,
        reason: 'curation entry matches no source geometry (file missing or geometry changed)',
      });
  }

  // ---- 2. plans from generator families
  const families = await loadFamilies(paths);
  const scadJobs: { plan: Omit<Plan, 'build' | 'key'>; job: ScadJob; anchor: AnchorMode }[] = [];
  for (const { spec, rungs } of families) {
    for (const rung of rungs) {
      const job: ScadJob = {
        generator: spec.generator,
        part: spec.part,
        version: spec.version,
        values: rung.values,
      };
      scadJobs.push({
        job,
        anchor: spec.anchor,
        plan: {
          id: rung.id,
          category: spec.category,
          name: rung.name,
          tags: spec.tags,
          toolClasses: spec.toolClasses,
          fitsTool: rung.fitsTool,
          mountKind: spec.mounting.kind,
          family: spec.id,
          variantLabel: rung.variantLabel,
          params: spec.params,
          ...(spec.printNotes ? { printNotes: spec.printNotes } : {}),
          orientation: 'generator',
          provenance: {
            origin: 'generated',
            generator: {
              generator: spec.generator,
              part: spec.part,
              version: spec.version,
              values: rung.values,
            },
            geometryHash: '',
            duplicates: [],
          },
          license: normalizeLicense({
            observed: 'project-original',
            attribution: 'HSW project parametric generator (alex-mextner/hsw-editor), MIT',
          }),
        },
      });
    }
  }
  if (scadJobs.length > 0) {
    const rendered = await renderMissing(
      paths,
      scadJobs.map((s) => s.job),
    );
    for (const { plan, job, anchor } of scadJobs) {
      const scadHash = await scadKey(paths, job);
      const stl = rendered.stl.get(scadHash);
      if (stl === undefined) {
        report.failed.push({
          id: plan.id,
          reason: rendered.failed.get(scadHash) ?? 'OpenSCAD produced no STL',
        });
        continue;
      }
      plan.provenance.geometryHash = await stlHash(stl);
      plans.push({
        ...plan,
        key: sha256(
          JSON.stringify([
            'gen',
            buildCode,
            scadHash,
            GENERATOR_ORIENT,
            anchor,
            artefactInputs(plan.category),
          ]),
        ),
        build: { path: stl, partId: '0', orient: GENERATOR_ORIENT, anchor },
      });
    }
  }

  const selected = options.only ? plans.filter((p) => p.id.includes(options.only!)) : plans;
  const ids = new Set<string>();
  for (const plan of selected) {
    if (ids.has(plan.id)) throw new Error(`duplicate element id ${plan.id}`);
    ids.add(plan.id);
  }

  // ---- 3. fast path: nothing changed since the last successful run
  const fingerprint = sha256(
    JSON.stringify([code, generatorsCode, selected.map((p) => p.key).sort(), options.only ?? null]),
  );
  const fingerprintFile = join(paths.bankDir, '.fingerprint');
  if (
    !options.force &&
    (await Bun.file(fingerprintFile).exists()) &&
    (await Bun.file(fingerprintFile).text()) === fingerprint
  ) {
    const existing = JSON.parse(
      await Bun.file(join(paths.bankDir, 'report.json')).text(),
    ) as IngestReport;
    return { ...existing, upToDate: true };
  }

  // ---- 4. build missing elements
  const elementsDir = join(paths.cacheDir, 'elements');
  const dirOf = (plan: Plan): string => join(elementsDir, plan.key.slice(0, 32));
  const states = await Promise.all(
    selected.map(async (p) => ({
      p,
      done: !options.force && (await Bun.file(join(dirOf(p), 'done.json')).exists()),
    })),
  );
  const missing = states.filter((d) => !d.done).map((d) => d.p);
  log(`${selected.length} elements, ${missing.length} to build`);
  for (let i = 0; i < missing.length; i += BUILD_BATCH) {
    const batch = missing.slice(i, i + BUILD_BATCH);
    const items: BuildItem[] = batch.map((p) => ({
      key: p.key.slice(0, 32),
      path: p.build.path,
      partId: p.build.partId,
      orient: p.build.orient,
      anchor: p.build.anchor,
      glb: join(dirOf(p), 'raw.glb'),
      thumbnail: join(dirOf(p), 'thumb.webp'),
      ...artefactInputs(p.category),
    }));
    const result = await runMeshTool<BuildResult>(
      paths,
      { op: 'build', grid: paths.grid, items },
      `build-${i}`,
    );
    if (result.toolVersion !== MESH_TOOL_VERSION)
      throw new Error(`mesh_tool version ${result.toolVersion} != ${MESH_TOOL_VERSION}`);
    for (const [index, built] of result.items.entries()) {
      const plan = batch[index]!;
      if (!built.ok) {
        report.failed.push({ id: plan.id, reason: built.error ?? 'unknown build error' });
        continue;
      }
      const raw = new Uint8Array(await Bun.file(join(dirOf(plan), 'raw.glb')).arrayBuffer());
      const compressed = await compressGlb(raw);
      await Bun.write(join(dirOf(plan), 'lod0.glb'), compressed.lod0);
      await Bun.write(join(dirOf(plan), 'lod1.glb'), compressed.lod1);
      await rm(join(dirOf(plan), 'raw.glb'));
      const meta: ElementBuild = {
        key: plan.key.slice(0, 32),
        result: built,
        lod0: 'lod0.glb',
        lod1: 'lod1.glb',
        thumbnail: 'thumb.webp',
        trianglesLod0: compressed.trianglesLod0,
        trianglesLod1: compressed.trianglesLod1,
      };
      await Bun.write(join(dirOf(plan), 'done.json'), JSON.stringify(meta));
    }
    log(`built ${Math.min(i + BUILD_BATCH, missing.length)}/${missing.length}`);
  }

  // ---- 5. assemble the index
  await mkdir(join(paths.bankDir, 'glb'), { recursive: true });
  await mkdir(join(paths.bankDir, 'thumb'), { recursive: true });
  const elements: BankElement[] = [];
  const referenced = new Set<string>();
  const failedIds = new Set(report.failed.map((f) => f.id));
  for (const plan of selected) {
    if (failedIds.has(plan.id)) continue;
    const doneFile = Bun.file(join(dirOf(plan), 'done.json'));
    if (!(await doneFile.exists())) {
      report.failed.push({ id: plan.id, reason: 'no build artefacts' });
      continue;
    }
    const build = (await doneFile.json()) as ElementBuild;
    const asset = async (kind: 'glb' | 'thumb', name: string, ext: string) => {
      const bytes = new Uint8Array(await Bun.file(join(dirOf(plan), name)).arrayBuffer());
      const hash = sha256(bytes);
      const path = `${kind}/${hash.slice(0, 16)}.${ext}` as const;
      referenced.add(path);
      const target = join(paths.bankDir, path);
      if (!(await Bun.file(target).exists())) await copyFile(join(dirOf(plan), name), target);
      return { path, bytes: bytes.length, sha256: hash };
    };
    const lod0 = await asset('glb', build.lod0, 'glb');
    const lod1 =
      build.trianglesLod1 === build.trianglesLod0 ? lod0 : await asset('glb', build.lod1, 'glb');
    const thumbnail = await asset('thumb', build.thumbnail, 'webp');
    const geometry = geometryOf(build.result, plan.mountKind);
    elements.push({
      id: plan.id,
      name: plan.name,
      category: plan.category,
      tags: plan.tags,
      toolClasses: plan.toolClasses,
      fitsTool: plan.fitsTool,
      footprint: geometry.footprint,
      bboxMm: geometry.bboxMm,
      dimsMm: geometry.dimsMm,
      mounting: { kind: plan.mountKind, cells: geometry.mountingCells },
      ...(plan.params ? { params: plan.params } : {}),
      ...(plan.family ? { family: plan.family } : {}),
      ...(plan.variantLabel ? { variantLabel: plan.variantLabel } : {}),
      generated: plan.provenance.origin === 'generated',
      assets: {
        lod0,
        lod1,
        thumbnail,
        triangles: { lod0: build.trianglesLod0, lod1: build.trianglesLod1 },
      },
      ...(plan.printNotes ? { printNotes: plan.printNotes } : {}),
      provenance: { ...plan.provenance, orientation: plan.orientation },
      license: plan.license,
    });
  }
  elements.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));

  const generated = elements.filter((e) => e.generated).length;
  const base = {
    version: BANK_SCHEMA_VERSION,
    grid: paths.grid,
    counts: {
      total: elements.length,
      fromSources: elements.length - generated,
      generated,
      redistributable: elements.filter((e) => e.license.redistributable).length,
    },
    categories: [...BANK_CATEGORIES],
    toolClasses: [...TOOL_CLASSES],
    elements,
  };
  const index: BankIndex = { ...base, contentHash: sha256(JSON.stringify(base)) };
  const validation = validateBankIndex(index);
  if (!validation.ok)
    throw new Error(`generated index is invalid:\n${validation.errors.slice(0, 30).join('\n')}`);

  await Bun.write(join(paths.bankDir, 'index.json'), JSON.stringify(index));
  await Bun.write(
    join(paths.bankDir, 'search-index.json'),
    serializeSearchIndex(
      buildSearchIndex(elements, {
        categories: categoryVocabulary(index.categories),
        toolClasses: toolClassVocabulary(index.toolClasses),
      }),
      index.contentHash,
    ),
  );
  await collectGarbage(paths, referenced);

  report.ingested = elements.map((e) => e.id);
  report.counts = { ...report.counts, ...index.counts };
  report.notRedistributable = elements
    .filter((e) => !e.license.redistributable)
    .map((e) => ({ id: e.id, license: e.license.spdx }));
  for (const e of elements) {
    report.bytes.glb +=
      e.assets.lod0.bytes + (e.assets.lod1.path === e.assets.lod0.path ? 0 : e.assets.lod1.bytes);
    report.bytes.thumbnails += e.assets.thumbnail.bytes;
  }
  await Bun.write(join(paths.bankDir, 'report.json'), JSON.stringify(report, null, 2));
  if (report.failed.length === 0) await Bun.write(fingerprintFile, fingerprint);
  return report;
}

/** Removes asset files no longer referenced by the index, and stale on-demand variants. */
async function collectGarbage(paths: BankPaths, referenced: Set<string>): Promise<void> {
  for (const kind of ['glb', 'thumb'] as const) {
    const dir = join(paths.bankDir, kind);
    for (const name of await readdir(dir)) {
      if (!referenced.has(`${kind}/${name}`)) await rm(join(dir, name));
    }
  }
  await collectVariantGarbage(paths);
}

export function reportMarkdown(report: IngestReport): string {
  const lines = [
    '# HSW bank ingest report',
    '',
    `- elements: ${report.counts.total} (from sources: ${report.counts.fromSources}, generated: ${report.counts.generated})`,
    `- distinct source geometries: ${report.counts.distinctSourceGeometries}; duplicate source files folded: ${report.counts.duplicateSourceFiles}`,
    `- redistributable (seed-eligible): ${report.counts.redistributable}`,
    `- failed: ${report.failed.length}, skipped: ${report.skipped.length}, uncurated: ${report.uncurated.length}`,
    '',
  ];
  const section = (title: string, entries: ReportEntry[]): void => {
    if (entries.length === 0) return;
    lines.push(
      `## ${title}`,
      '',
      ...entries.map((e) => `- ${e.id ?? e.source ?? '?'}: ${e.reason}`),
      '',
    );
  };
  section('Failed', report.failed);
  section('Skipped (deliberate)', report.skipped);
  section('Uncurated geometries', report.uncurated);
  section('Curation entries without geometry', report.orphans);
  section('Unreadable source files', report.unreadable);
  return lines.join('\n');
}
