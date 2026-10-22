/** Consistency check of a built bank (or the seed): files exist, hashes match, GLB bounds equal the index. */
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { join } from 'node:path';
import { BankIndexSchema, type AssetRef, type BankElement } from '../schema.ts';
import { validateBankIndex } from '../validate.ts';
import { LOD1_BOUNDS_TOL_MM } from './compress.ts';

/** Meshopt position quantisation (14 bit) plus float slack, mm. */
const BOUNDS_TOLERANCE_MM = 0.08;

export interface VerifyResult {
  checked: number;
  problems: string[];
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

async function readAsset(
  root: string,
  asset: AssetRef,
  problems: string[],
  id: string,
): Promise<Uint8Array | null> {
  const file = Bun.file(join(root, asset.path));
  if (!(await file.exists())) {
    problems.push(`${id}: missing ${asset.path}`);
    return null;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== asset.bytes)
    problems.push(`${id}: ${asset.path} is ${bytes.length} bytes, index says ${asset.bytes}`);
  if (sha256(bytes) !== asset.sha256) problems.push(`${id}: ${asset.path} content hash mismatch`);
  return bytes;
}

async function checkGlb(
  io: NodeIO,
  bytes: Uint8Array,
  element: BankElement,
  lod: string,
  problems: string[],
  slackMm: number,
): Promise<void> {
  const doc = await io.readBinary(bytes);
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) {
    problems.push(`${element.id}: ${lod} has no scene`);
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
      problems.push(
        `${element.id}: ${lod} ${axis} = ${actual.toFixed(3)}, index bboxMm says ${want}`,
      );
    }
  }
}

export async function verifyBank(
  root: string,
  options: { glbSample?: number } = {},
): Promise<VerifyResult> {
  const problems: string[] = [];
  const parsed = BankIndexSchema.parse(await Bun.file(join(root, 'index.json')).json());
  const validation = validateBankIndex(parsed);
  if (!validation.ok) problems.push(...validation.errors);
  await MeshoptDecoder.ready;
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const step =
    options.glbSample && options.glbSample > 0
      ? Math.max(1, Math.floor(parsed.elements.length / options.glbSample))
      : 1;
  let checked = 0;
  for (const [i, element] of parsed.elements.entries()) {
    const lod0 = await readAsset(root, element.assets.lod0, problems, element.id);
    const lod1 =
      element.assets.lod1.path === element.assets.lod0.path
        ? lod0
        : await readAsset(root, element.assets.lod1, problems, element.id);
    await readAsset(root, element.assets.thumbnail, problems, element.id);
    if (i % step === 0) {
      if (lod0) await checkGlb(io, lod0, element, 'lod0', problems, 0);
      if (lod1 && lod1 !== lod0)
        await checkGlb(io, lod1, element, 'lod1', problems, LOD1_BOUNDS_TOL_MM);
    }
    checked++;
  }
  return { checked, problems };
}
