/**
 * Consistency check of a built bank generation (or the seed): the index parses and its content hash
 * matches, every referenced file exists with the recorded size and sha256, GLB bounds equal the index.
 * It is the single gate behind `bank:verify`, the publish step of ingestion/seed export and the server's
 * health route.
 */
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { BankIndexSchema, type AssetRef, type BankElement, type BankIndex } from '../schema.ts';
import { validateBankIndex } from '../validate.ts';
import { indexContentHash, sha256Hex } from './hash.ts';
import { LOD1_BOUNDS_TOL_MM } from './compress.ts';

/** Meshopt position quantisation (14 bit) plus float slack, mm. */
const BOUNDS_TOLERANCE_MM = 0.08;

export type IssueKind = 'index' | 'missing' | 'size' | 'hash' | 'scene' | 'bounds';

/** One finding. `id` is the element it concerns, `null` for index-level problems. */
export interface VerifyIssue {
  id: string | null;
  kind: IssueKind;
  /** Asset path relative to the bank root, when the finding is about one file. */
  path?: string;
  detail: string;
}

export interface VerifyResult {
  checked: number;
  /** `issues` rendered one per line, for CLIs and logs. */
  problems: string[];
  issues: VerifyIssue[];
  /** `contentHash` of the verified index; absent when the index itself could not be read. */
  contentHash?: string;
  /** The parsed index (even when files are missing); absent when the index itself could not be read. */
  index?: BankIndex;
}

export interface VerifyOptions {
  /** Existence and size only: no hashing, no GLB decoding. Cheap enough for a request path. */
  quick?: boolean;
  /** Decode GLBs and compare their bounds with the index (default true; ignored when `quick`). */
  bounds?: boolean;
}

function sizeMismatch(path: string, actual: number, expected: number): string {
  return `${path} is ${actual} bytes, index says ${expected}`;
}

/** One line per finding, for CLIs, logs and health output. */
export function formatIssue(issue: VerifyIssue): string {
  return `${issue.id ?? '(index)'}: ${issue.detail}`;
}

function missing(id: string, path: string): VerifyIssue {
  return { id, kind: 'missing', path, detail: `missing ${path}` };
}

/** Existence and size only (no hashing, no decoding). */
async function checkAssetQuick(
  root: string,
  asset: AssetRef,
  issues: VerifyIssue[],
  id: string,
): Promise<void> {
  const info = await stat(join(root, asset.path)).catch(() => null);
  if (!info?.isFile()) {
    issues.push(missing(id, asset.path));
  } else if (info.size !== asset.bytes) {
    issues.push({
      id,
      kind: 'size',
      path: asset.path,
      detail: sizeMismatch(asset.path, info.size, asset.bytes),
    });
  }
}

/** Reads and hashes the file; returns its bytes (for GLB decoding) or null when it is missing. */
async function readAsset(
  root: string,
  asset: AssetRef,
  issues: VerifyIssue[],
  id: string,
): Promise<Uint8Array | null> {
  // A file deleted between the check and the read is reported as missing, never thrown.
  const bytes = await readFile(join(root, asset.path)).then(
    (buffer) => new Uint8Array(buffer),
    () => null,
  );
  if (bytes === null) {
    issues.push(missing(id, asset.path));
    return null;
  }
  if (bytes.length !== asset.bytes) {
    issues.push({
      id,
      kind: 'size',
      path: asset.path,
      detail: sizeMismatch(asset.path, bytes.length, asset.bytes),
    });
  }
  if (sha256Hex(bytes) !== asset.sha256) {
    issues.push({
      id,
      kind: 'hash',
      path: asset.path,
      detail: `${asset.path} content hash mismatch`,
    });
  }
  return bytes;
}

async function checkGlb(
  io: NodeIO,
  bytes: Uint8Array,
  element: BankElement,
  lod: string,
  path: string,
  issues: VerifyIssue[],
  slackMm: number,
): Promise<void> {
  const doc = await io.readBinary(bytes).catch((error: unknown) => {
    issues.push({
      id: element.id,
      kind: 'scene',
      path,
      detail: `${lod} is not a readable GLB: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  });
  if (!doc) return;
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) {
    issues.push({ id: element.id, kind: 'scene', path, detail: `${lod} has no scene` });
    return;
  }
  const { min, max } = getBounds(scene);
  const expected = element.bboxMm;
  const pairs: [string, number, number][] = [
    ['min.x', min[0], expected.min.x],
    ['min.y', min[1], expected.min.y],
    ['min.z', min[2], expected.min.z],
    ['max.x', max[0], expected.max.x],
    ['max.y', max[1], expected.max.y],
    ['max.z', max[2], expected.max.z],
  ];
  for (const [axis, actual, want] of pairs) {
    if (Math.abs(actual - want) > BOUNDS_TOLERANCE_MM + slackMm + Math.abs(want) * 1e-4) {
      issues.push({
        id: element.id,
        kind: 'bounds',
        path,
        detail: `${lod} ${axis} = ${actual.toFixed(3)}, index bboxMm says ${want}`,
      });
    }
  }
}

/** Reads and validates `index.json` of a root; null plus an issue when it cannot be trusted. */
async function readIndex(
  root: string,
  issues: VerifyIssue[],
): Promise<{ index: BankIndex; raw: object } | null> {
  const file = Bun.file(join(root, 'index.json'));
  if (!(await file.exists())) {
    issues.push({ id: null, kind: 'index', detail: `no index.json in ${root}` });
    return null;
  }
  let raw: unknown;
  try {
    raw = await file.json();
  } catch (error) {
    issues.push({
      id: null,
      kind: 'index',
      detail: `index.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
  const parsed = BankIndexSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 20)) {
      issues.push({
        id: null,
        kind: 'index',
        detail: `index.json ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      });
    }
    return null;
  }
  // The schema only accepts objects; the guard narrows `raw` for the hash without a cast.
  return typeof raw === 'object' && raw !== null ? { index: parsed.data, raw } : null;
}

export async function verifyBank(root: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const issues: VerifyIssue[] = [];
  const read = await readIndex(root, issues);
  if (!read) return { checked: 0, problems: issues.map(formatIssue), issues };
  const { index, raw } = read;
  if (indexContentHash(raw) !== index.contentHash) {
    issues.push({
      id: null,
      kind: 'index',
      detail: 'index.json content does not match its contentHash (edited or truncated)',
    });
  }
  const validation = validateBankIndex(index);
  if (!validation.ok) {
    for (const error of validation.errors) issues.push({ id: null, kind: 'index', detail: error });
  }
  const quick = options.quick === true;
  const bounds = !quick && options.bounds !== false;
  let io: NodeIO | null = null;
  if (bounds) {
    await MeshoptDecoder.ready;
    io = new NodeIO()
      .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  }
  let checked = 0;
  for (const element of index.elements) {
    const { lod0, lod1, thumbnail } = element.assets;
    const sameLod = lod1.path === lod0.path;
    if (quick) {
      await checkAssetQuick(root, lod0, issues, element.id);
      if (!sameLod) await checkAssetQuick(root, lod1, issues, element.id);
      await checkAssetQuick(root, thumbnail, issues, element.id);
    } else {
      const bytes0 = await readAsset(root, lod0, issues, element.id);
      const bytes1 = sameLod ? null : await readAsset(root, lod1, issues, element.id);
      await readAsset(root, thumbnail, issues, element.id);
      if (io && bytes0) await checkGlb(io, bytes0, element, 'lod0', lod0.path, issues, 0);
      if (io && bytes1)
        await checkGlb(io, bytes1, element, 'lod1', lod1.path, issues, LOD1_BOUNDS_TOL_MM);
    }
    checked++;
  }
  return {
    checked,
    problems: issues.map(formatIssue),
    issues,
    contentHash: index.contentHash,
    index,
  };
}

/** First file-level problem (missing, wrong size, wrong hash, bad GLB) of every element that has one. */
export function firstProblemByElement(issues: readonly VerifyIssue[]): Map<string, string> {
  const broken = new Map<string, string>();
  for (const issue of issues) {
    if (issue.id === null || issue.kind === 'index') continue;
    if (!broken.has(issue.id)) broken.set(issue.id, issue.detail);
  }
  return broken;
}
