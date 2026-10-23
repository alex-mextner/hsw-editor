/**
 * Inventory of the HSW sources: finds every STL/3MF/STEP file, hashes it (cached by size+mtime),
 * resolves provenance + licence, and probes the geometry (cached by content hash).
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { License, SourceRef } from '../schema.ts';
import { runMeshTool } from './exec.ts';
import { normalizeLicense } from './license.ts';
import type { ProbeFile, ProbeResult } from './meshTool.ts';
import type { BankPaths } from './paths.ts';

/** Must equal TOOL_VERSION in scripts/bank/py/mesh_tool.py; probe and build results are checked against it. */
export const MESH_TOOL_VERSION = 5;

export type SourceKind = 'stl' | '3mf' | 'step';

/** Directories (relative to the HSW project) that hold model files. */
const SOURCE_ROOTS = ['sources/catalog', 'sources/downloaded-library', 'refit/geometry', 'models'];

export interface SourceOrigin {
  origin: 'source-file' | 'project-original';
  site: SourceRef['site'];
  modelId?: string;
  title?: string;
  author?: string;
  url?: string;
  license: License;
}

export interface SourceFile {
  /** Path relative to the HSW project dir. */
  rel: string;
  abs: string;
  kind: SourceKind;
  sha256: string;
  origin: SourceOrigin;
  probe: ProbeFile;
}

interface CatalogModel {
  source: { site: SourceRef['site']; id: string; url: string };
  title: string;
  author: { name: string; url?: string };
  license: string;
}

/**
 * Provenance the files themselves do not carry. Path prefix -> origin; first match wins. Everything
 * not listed falls back to the catalog model.json, the embedded 3MF metadata, or "unknown".
 */
const ORIGIN_OVERRIDES: {
  prefix: string;
  title: string;
  author: string;
  licenseObserved: string;
  site: SourceRef['site'];
  url?: string;
}[] = [
  {
    prefix: 'sources/downloaded-library/libs/HSW+Attach+Anything+Tutorial',
    title: 'HSW Attach Anything Tutorial - No CAD Required (KYZ-H / KYZ-V remix bases)',
    author: 'KYZ Design',
    licenseObserved: '',
    site: 'unknown',
  },
  {
    prefix: 'models/reinforced-',
    title: 'Universal Tool Holders for HWS, reinforced by the HSW project (derivative)',
    author: 'Artur (original), HSW project (reinforcement)',
    licenseObserved: 'Standard Digital File License',
    site: 'makerworld',
  },
  {
    prefix: 'models/existing-accessories',
    title: 'Accessories extracted from the downloaded library',
    author: 'see sources/downloaded-library',
    licenseObserved: '',
    site: 'unknown',
  },
];

function kindOf(name: string): SourceKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.3mf')) return '3mf';
  if (lower.endsWith('.step') || lower.endsWith('.stp')) return 'step';
  return null;
}

async function walk(dir: string, out: string[]): Promise<void> {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (kindOf(entry.name)) out.push(full);
  }
}

interface HashCacheEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

async function sha256Of(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest('hex');
}

async function loadJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as T) : null;
}

async function loadCatalog(sourcesDir: string): Promise<Map<string, CatalogModel>> {
  const catalog = new Map<string, CatalogModel>();
  const root = join(sourcesDir, 'sources/catalog');
  if (!existsSync(root)) return catalog;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const model = await loadJson<CatalogModel>(join(root, entry.name, 'model.json'));
    if (model) catalog.set(`sources/catalog/${entry.name}/`, model);
  }
  return catalog;
}

function resolveOrigin(
  rel: string,
  probe: ProbeFile,
  catalog: Map<string, CatalogModel>,
): SourceOrigin {
  for (const [prefix, model] of catalog) {
    if (!rel.startsWith(prefix)) continue;
    return {
      origin: 'source-file',
      site: model.source.site,
      modelId: model.source.id,
      title: model.title,
      author: model.author.name,
      url: model.source.url,
      license: normalizeLicense({
        observed: model.license,
        attribution: `${model.title} by ${model.author.name} (${model.source.url}), ${model.license}`,
        url: model.source.url,
      }),
    };
  }
  if (rel.startsWith('refit/geometry/')) {
    return {
      origin: 'project-original',
      site: 'hsw-project',
      title: 'HSW refit holders',
      author: 'HSW project',
      license: normalizeLicense({
        observed: 'project-original',
        attribution: 'HSW project (alex-mextner/hsw-editor contributors), MIT',
      }),
    };
  }
  const override = ORIGIN_OVERRIDES.find((o) => rel.startsWith(o.prefix));
  if (override) {
    return {
      origin: 'source-file',
      site: override.site,
      title: override.title,
      author: override.author,
      license: normalizeLicense({
        observed: override.licenseObserved,
        attribution: `${override.title} by ${override.author}`,
      }),
    };
  }
  const meta = probe.meta;
  const title = meta.Title && meta.Title.length > 0 ? meta.Title : undefined;
  const author = meta.Designer && meta.Designer.length > 0 ? meta.Designer : undefined;
  const link = meta.SourceLink;
  const site: SourceRef['site'] = link?.includes('printables')
    ? 'printables'
    : link?.includes('makerworld')
      ? 'makerworld'
      : 'unknown';
  const observed = meta.License ?? '';
  const license = normalizeLicense({
    observed,
    attribution: [
      title ?? rel,
      author ? `by ${author}` : 'author not recorded',
      observed ? observed : 'licence not recorded',
    ].join(', '),
    ...(link ? { url: link } : {}),
  });
  // A remix carries its author's licence, but the work it remixes may be more restricted (the 3MF lists
  // upstream links, not their terms): keep such files out of the public repo until verified.
  const remix = meta.Origin === 'remix';
  return {
    origin: 'source-file',
    site,
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(link ? { url: link } : {}),
    license:
      remix && license.redistributable
        ? {
            ...license,
            observed: `${license.observed} (remix; upstream licence not verified)`,
            redistributable: false,
          }
        : license,
  };
}

export interface Inventory {
  files: SourceFile[];
  /** Files that could not be loaded, with the reason. */
  unreadable: { rel: string; error: string }[];
}

const IO_CHUNK = 32;

/** `fn` over `items` with at most IO_CHUNK calls in flight; results keep the input order. */
async function mapChunked<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += IO_CHUNK) {
    out.push(...(await Promise.all(items.slice(i, i + IO_CHUNK).map(fn))));
  }
  return out;
}

export async function scanSources(paths: BankPaths): Promise<Inventory> {
  const abs: string[] = [];
  for (const root of SOURCE_ROOTS) await walk(join(paths.sourcesDir, root), abs);
  abs.sort();

  const hashCachePath = join(paths.cacheDir, 'hashes.json');
  const hashCache = (await loadJson<Record<string, HashCacheEntry>>(hashCachePath)) ?? {};
  const hashes = new Map<string, string>();
  let hashCacheDirty = false;
  const hashed = await mapChunked(abs, async (file) => {
    const rel = relative(paths.sourcesDir, file);
    const info = await stat(file);
    const cached = hashCache[rel];
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return { rel, entry: cached, fresh: false };
    }
    const entry = { size: info.size, mtimeMs: info.mtimeMs, sha256: await sha256Of(file) };
    return { rel, entry, fresh: true };
  });
  for (const { rel, entry, fresh } of hashed) {
    hashes.set(rel, entry.sha256);
    if (fresh) {
      hashCache[rel] = entry;
      hashCacheDirty = true;
    }
  }
  if (hashCacheDirty) await Bun.write(hashCachePath, JSON.stringify(hashCache));

  const probes = new Map<string, ProbeFile>();
  const missing: { path: string }[] = [];
  const cachedProbes = await mapChunked(abs, async (file) => ({
    file,
    cached: await loadJson<ProbeFile>(
      probeCachePath(paths, hashes.get(relative(paths.sourcesDir, file)) ?? ''),
    ),
  }));
  for (const { file, cached } of cachedProbes) {
    if (cached) probes.set(relative(paths.sourcesDir, file), { ...cached, path: file });
    else missing.push({ path: file });
  }
  if (missing.length > 0) {
    const result = await runMeshTool<ProbeResult>(paths, { op: 'probe', files: missing }, 'probe');
    if (result.toolVersion !== MESH_TOOL_VERSION) {
      throw new Error(`mesh_tool version ${result.toolVersion} != expected ${MESH_TOOL_VERSION}`);
    }
    for (const probe of result.files) {
      const rel = relative(paths.sourcesDir, probe.path);
      probes.set(rel, probe);
      if (!probe.error) await Bun.write(probeCachePath(paths, probe.sha256), JSON.stringify(probe));
    }
  }

  const catalog = await loadCatalog(paths.sourcesDir);
  const files: SourceFile[] = [];
  const unreadable: Inventory['unreadable'] = [];
  for (const file of abs) {
    const rel = relative(paths.sourcesDir, file);
    const probe = probes.get(rel);
    const kind = kindOf(file);
    if (!probe || !kind) continue;
    if (probe.error) {
      unreadable.push({ rel, error: probe.error });
      continue;
    }
    files.push({
      rel,
      abs: file,
      kind,
      sha256: probe.sha256,
      origin: resolveOrigin(rel, probe, catalog),
      probe,
    });
  }
  return { files, unreadable };
}

function probeCachePath(paths: BankPaths, sha256: string): string {
  return join(paths.cacheDir, 'probe', `${sha256}-v${MESH_TOOL_VERSION}.json`);
}
