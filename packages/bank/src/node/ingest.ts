/**
 * The bank ingestion pipeline: sources + generators -> normalised GLB (LOD0/LOD1) + thumbnails +
 * `index.json` / `search-index.json` / `report.json` as a new verified generation of the bank dir
 * (see generations.ts): nothing is served until the whole tree has been verified.
 *
 * Idempotent and incremental: every element has a content key (source hash, part, orientation, tool
 * versions); built artefacts live under `<cache>/elements/<key>/` and are reused. A fingerprint over
 * all inputs makes an unchanged rerun a no-op that only stats the source files.
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { SOURCE_CURATION, SOURCE_SKIPS, type CurationEntry } from '../../curation/sources.ts';
import { BANK_CATEGORIES } from '../categories.ts';
import { expandFamily, FamilyFileSchema, type FamilySpec, type Rung } from '../families.ts';
import {
  BankIndexSchema,
  type AssetRef,
  type BankElement,
  type BankIndex,
  type CellOffset,
  type FitsTool,
  type License,
  type Provenance,
  type UnavailableElement,
} from '../schema.ts';
import { TOOL_CLASSES } from '../toolClasses.ts';
import { compressGlb } from './compress.ts';
import { clusterParts, type Candidate, type Cluster } from './dedupe.ts';
import { runMeshTool } from './exec.ts';
import {
  createStaging,
  currentGeneration,
  publishGeneration,
  type PublishResult,
} from './generations.ts';
import { normalizeLicense } from './license.ts';
import type { AnchorMode, BuildItem, BuildResult, Orientation } from './meshTool.ts';
import type { BankPaths } from './paths.ts';
import { composeVerified, copyInto, migrateFlatBank } from './publish.ts';
import { renderMissing, scadKey, type ScadJob } from './scad.ts';
import { MESH_TOOL_VERSION, scanSources, type SourceFile } from './sources.ts';
import { sha256Hex } from './hash.ts';
import { verifyBank } from './verify.ts';

/** Thickness of the wall-facing slab whose silhouette defines the footprint. */
const BACK_SLAB_MM = 1;
const BUILD_BATCH = 24;
const GENERATOR_ORIENT: Orientation = { out: '+z', up: '+y' };

const CATEGORY_COLORS: Record<string, string> = {
  holders: '#4f7fb0',
  hooks: '#c27a3a',
  bins: '#4f9a6b',
  shelves: '#8a6bb0',
  inserts: '#7d8793',
  accessories: '#3f9aa3',
  panels: '#a8b0ba',
};

/** What `.fingerprint` records: the inputs of the last ingest and the generation it published. */
const FingerprintSchema = z.object({ inputs: z.string(), contentHash: z.string() });

const REPORT_LISTS = [
  'ingested',
  'skipped',
  'failed',
  'uncurated',
  'orphans',
  'unreadable',
  'notRedistributable',
] as const;

/** `report.json` written by ingest (adopt writes a different shape into the same slot). */
function isIngestReport(value: unknown): value is IngestReport {
  if (typeof value !== 'object' || value === null) return false;
  return (
    REPORT_LISTS.every((key) => Array.isArray(Reflect.get(value, key))) &&
    typeof Reflect.get(value, 'counts') === 'object' &&
    typeof Reflect.get(value, 'bytes') === 'object'
  );
}

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
  /** Ids published before that this run no longer lists (look here first when a model disappears). */
  removed: string[];
  /** The generation this run published; absent for an up-to-date no-op. */
  published?: PublishResult;
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

/** Hash of the given files/directories (non-recursive, test files excluded). */
async function codeFingerprint(paths: BankPaths, roots: string[]): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const root of roots) {
    const target = join(paths.repoRoot, root);
    const info = await stat(target).catch(() => null);
    if (info === null) continue;
    const names = info.isDirectory() ? (await readdir(target)).sort() : [''];
    for (const name of names) {
      if (name !== '' && (!/\.(ts|py|scad|json|toml)$/.test(name) || name.endsWith('.test.ts')))
        continue;
      hasher.update(`${root}/${name}\0`);
      hasher.update(await Bun.file(join(target, name)).arrayBuffer());
    }
  }
  return hasher.digest('hex');
}

function toCells(pairs: [number, number][]): CellOffset[] {
  return pairs.map(([dCol, dRow2]) => ({ dCol, dRow2 }));
}

function footprintOf(cells: CellOffset[]): BankElement['footprint'] {
  const cols = cells.map((c) => c.dCol);
  const rows2 = cells.map((c) => c.dRow2);
  return {
    cells,
    cols: Math.max(...cols) - Math.min(...cols) + 1,
    rows: Math.ceil((Math.max(...rows2) - Math.min(...rows2)) / 2) + 1,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function loadFamilies(paths: BankPaths): Promise<{ spec: FamilySpec; rungs: Rung[] }[]> {
  const file = Bun.file(join(paths.generatorsDir, 'families.json'));
  if (!(await file.exists())) return [];
  const parsed = FamilyFileSchema.parse(await file.json());
  return parsed.families.map((spec) => ({ spec, rungs: expandFamily(spec) }));
}

export async function ingest(paths: BankPaths, options: IngestOptions = {}): Promise<IngestReport> {
  const { only } = options;
  /** `--only` narrows the run to elements whose id contains the text. */
  const inSelection = (id: string): boolean =>
    only === undefined || only === '' || id.includes(only);
  const log = options.log ?? ((line: string) => console.info(line));
  await mkdir(paths.cacheDir, { recursive: true });
  // Per-element artefacts depend only on the mesh tool and the compressor; the fingerprint on everything.
  const buildCode = await codeFingerprint(paths, [
    'scripts/bank/py',
    'packages/bank/src/node/compress.ts',
  ]);
  const code = await codeFingerprint(paths, [
    'packages/bank/src/node',
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
    removed: [],
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
      key: sha256Hex(
        JSON.stringify(['src', buildCode, rep.file.sha256, rep.partId, orient, anchor]),
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
  const renderFailures: UnavailableElement[] = [];
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
        const reason = rendered.failed.get(scadHash) ?? 'OpenSCAD produced no STL';
        report.failed.push({ id: plan.id, reason });
        // Listed as unavailable (not silently dropped) so clients can say why the element has no model.
        if (inSelection(plan.id))
          renderFailures.push({
            id: plan.id,
            name: plan.name,
            reason: 'OpenSCAD render failed (see the ingest report)',
          });
        continue;
      }
      plan.provenance.geometryHash = sha256Hex(
        await Bun.file(stl)
          .arrayBuffer()
          .then((b) => new Uint8Array(b)),
      );
      plans.push({
        ...plan,
        key: sha256Hex(JSON.stringify(['gen', buildCode, scadHash, GENERATOR_ORIENT, anchor])),
        build: { path: stl, partId: '0', orient: GENERATOR_ORIENT, anchor },
      });
    }
  }

  const selected = plans.filter((p) => inSelection(p.id));
  const ids = new Set<string>();
  for (const plan of selected) {
    if (ids.has(plan.id)) throw new Error(`duplicate element id ${plan.id}`);
    ids.add(plan.id);
  }

  // ---- 3. fast path: nothing changed since the last successful run
  const fingerprint = sha256Hex(
    JSON.stringify([code, generatorsCode, selected.map((p) => p.key).sort(), options.only ?? null]),
  );
  const fingerprintFile = join(paths.bankDir, '.fingerprint');
  // Up to date only when the inputs are unchanged AND the published generation is the one this ingest
  // produced and is intact: a deleted or truncated file, or a different generation adopted since, must
  // trigger a rebuild.
  const published = await currentGeneration(paths);
  if (!options.force && published) {
    const stored = FingerprintSchema.safeParse(
      await Bun.file(fingerprintFile)
        .json()
        .catch(() => null),
    );
    const check = await verifyBank(published.root, { quick: true });
    if (
      stored.success &&
      stored.data.inputs === fingerprint &&
      stored.data.contentHash === check.contentHash &&
      check.issues.length === 0
    ) {
      const existing: unknown = await Bun.file(join(published.root, 'report.json'))
        .json()
        .catch(() => null);
      // `removed` described the run that published this generation; a no-op run removes nothing.
      if (isIngestReport(existing)) return { ...existing, removed: [], upToDate: true };
    }
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
      backSlabMm: BACK_SLAB_MM,
      glb: join(dirOf(p), 'raw.glb'),
      thumbnail: join(dirOf(p), 'thumb.webp'),
      views: ['iso'],
      color: CATEGORY_COLORS[p.category.split('/')[0] ?? ''] ?? '#4f7fb0',
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

  // ---- 5. assemble the index in a private staging tree (published only after full verification)
  // A flat bank from before generations is adopted as the first generation (old asset names stay
  // resolvable for open tabs) and its files are removed; a no-op once migrated.
  await migrateFlatBank(paths);
  const staging = await createStaging(paths);
  const elements: BankElement[] = [];
  const unavailable: UnavailableElement[] = [...renderFailures];
  try {
    const withhold = (plan: Plan, reason: string): void => {
      unavailable.push({ id: plan.id, name: plan.name, reason });
    };
    const failedIds = new Set(report.failed.flatMap((f) => (f.id ? [f.id] : [])));
    for (const plan of selected) {
      if (failedIds.has(plan.id)) {
        // The detail (tool stderr, paths, timings) stays in the report: the index text must be
        // deterministic, otherwise every run would hash differently and publish a new generation.
        withhold(plan, 'mesh build failed (see the ingest report)');
        continue;
      }
      const doneFile = Bun.file(join(dirOf(plan), 'done.json'));
      if (!(await doneFile.exists())) {
        report.failed.push({ id: plan.id, reason: 'no build artefacts' });
        withhold(plan, 'no build artefacts');
        continue;
      }
      const build = (await doneFile.json()) as ElementBuild;
      const asset = async (kind: 'glb' | 'thumb', name: string, ext: string) => {
        const source = join(dirOf(plan), name);
        const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
        const hash = sha256Hex(bytes);
        const path = `${kind}/${hash.slice(0, 16)}.${ext}` as const;
        await copyInto(staging, path, source);
        return { path, bytes: bytes.length, sha256: hash };
      };
      let lod0: AssetRef;
      let lod1: AssetRef;
      let thumbnail: AssetRef;
      try {
        lod0 = await asset('glb', build.lod0, 'glb');
        lod1 =
          build.trianglesLod1 === build.trianglesLod0
            ? lod0
            : await asset('glb', build.lod1, 'glb');
        thumbnail = await asset('thumb', build.thumbnail, 'webp');
      } catch (error) {
        // A cached artefact that vanished or cannot be read must not make a listed element undrawable.
        report.failed.push({
          id: plan.id,
          reason: `unreadable build artefact: ${error instanceof Error ? error.message : String(error)}`,
        });
        withhold(plan, 'unreadable build artefact');
        continue;
      }
      const bbox = build.result.bboxMm!;
      const footprintCells = toCells(build.result.cells ?? [[0, 0]]);
      const mountingCells =
        plan.mountKind === 'none'
          ? []
          : plan.mountKind === 'm3-screw' && (build.result.mountingCells?.length ?? 0) > 0
            ? toCells(build.result.mountingCells ?? [])
            : footprintCells;
      elements.push({
        id: plan.id,
        name: plan.name,
        category: plan.category,
        tags: plan.tags,
        toolClasses: plan.toolClasses,
        fitsTool: plan.fitsTool,
        footprint: footprintOf(footprintCells),
        bboxMm: {
          min: {
            x: round3(bbox.min[0]),
            y: round3(bbox.min[1]),
            z: Math.max(0, round3(bbox.min[2])),
          },
          max: { x: round3(bbox.max[0]), y: round3(bbox.max[1]), z: round3(bbox.max[2]) },
        },
        dimsMm: {
          x: round3(bbox.max[0] - bbox.min[0]),
          y: round3(bbox.max[1] - bbox.min[1]),
          z: round3(bbox.max[2] - Math.max(0, bbox.min[2])),
        },
        mounting: { kind: plan.mountKind, cells: mountingCells },
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

    // Everything is built in `staging`; nothing is visible to the server until the whole tree verifies.
    const index = await composeVerified(staging, {
      grid: paths.grid,
      categories: [...BANK_CATEGORIES],
      toolClasses: [...TOOL_CLASSES],
      elements,
      unavailable,
    });
    // Elements withheld by the verification (corrupt file, bounds drift) are failures of this run too.
    for (const u of index.unavailable ?? [])
      if (!report.failed.some((f) => f.id === u.id))
        report.failed.push({ id: u.id, reason: u.reason });
    report.ingested = index.elements.map((e) => e.id);
    report.counts = { ...report.counts, ...index.counts };
    report.notRedistributable = index.elements
      .filter((e) => !e.license.redistributable)
      .map((e) => ({ id: e.id, license: e.license.spdx }));
    for (const e of index.elements) {
      report.bytes.glb +=
        e.assets.lod0.bytes + (e.assets.lod1.path === e.assets.lod0.path ? 0 : e.assets.lod1.bytes);
      report.bytes.thumbnails += e.assets.thumbnail.bytes;
    }
    // Elements that were published before and are gone now: the first thing to look at when a wall item
    // suddenly has no model.
    const previous = published
      ? BankIndexSchema.safeParse(
          await Bun.file(join(published.root, 'index.json'))
            .json()
            .catch(() => null),
        )
      : null;
    const kept = new Set(report.ingested);
    // A partial (`--only`) index drops everything else by design: nothing is "removed" then.
    report.removed =
      previous?.success && !only
        ? previous.data.elements.map((e) => e.id).filter((id) => !kept.has(id))
        : [];
    await Bun.write(join(staging, 'report.json'), JSON.stringify(report, null, 2));
    // A partial `--only` bank must not push the last full generation out of the retention window.
    report.published = await publishGeneration(paths, staging, {
      fullVerify: false,
      prune: !only,
    });
  } catch (error) {
    // A throw anywhere between staging and publish must not leave a full copy of the bank behind.
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  if (report.failed.length === 0)
    await Bun.write(
      fingerprintFile,
      JSON.stringify({ inputs: fingerprint, contentHash: report.published.contentHash }),
    );
  return report;
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
  section(
    'Removed since the previous generation',
    report.removed.map((id) => ({ id, reason: 'no longer in the bank' })),
  );
  return lines.join('\n');
}
