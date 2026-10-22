/**
 * GLB post-processing: dedupe/prune, quantise, EXT_meshopt_compression, and a simplified LOD1.
 * Input is the plain GLB written by scripts/bank/py/mesh_tool.py (positions in mm, wall frame).
 */
import { Logger, NodeIO, type Document } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import {
  cloneDocument,
  dedup,
  getBounds,
  prune,
  quantize,
  simplify,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

/** Meshes at or below this triangle count share one file for LOD0 and LOD1. */
export const LOD1_MIN_TRIANGLES = 1500;
/** LOD1 keeps this fraction of the triangles and may deviate this much (fraction of mesh size). */
const LOD1_RATIO = 0.25;
const LOD1_ERRORS = [0.01, 0.004, 0.0015];
/** Largest bounding-box deviation of LOD1 from LOD0. */
export const LOD1_BOUNDS_TOL_MM = 0.15;
/** Positions are quantised to 14 bits: a 400 mm panel resolves 0.025 mm. */
const POSITION_BITS = 14;

export interface CompressedGlb {
  lod0: Uint8Array;
  lod1: Uint8Array;
  trianglesLod0: number;
  trianglesLod1: number;
}

async function createIo(): Promise<NodeIO> {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
  return new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
}

export function countTriangles(doc: Document): number {
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      triangles +=
        (indices ? indices.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0)) / 3;
    }
  }
  return triangles;
}

async function writeCompressed(io: NodeIO, doc: Document): Promise<Uint8Array> {
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  await doc.transform(quantize({ quantizePosition: POSITION_BITS, quantizeNormal: 8 }));
  return io.writeBinary(doc);
}

function boundsOf(doc: Document): { min: number[]; max: number[] } {
  const scene = doc.getRoot().listScenes()[0];
  if (!scene) throw new Error('GLB has no scene');
  return getBounds(scene);
}

/**
 * LOD1 by meshopt simplification. The simplifier trades silhouette for triangles, so the error budget
 * is tightened until the bounding box stays within LOD1_BOUNDS_TOL_MM of LOD0 (placement and collision
 * logic use bboxMm); when no budget keeps it, the element has no separate LOD1.
 */
async function simplifiedWithinBounds(doc: Document): Promise<Document | null> {
  const reference = boundsOf(doc);
  for (const error of LOD1_ERRORS) {
    const candidate = cloneDocument(doc);
    await candidate.transform(
      simplify({ simplifier: MeshoptSimplifier, ratio: LOD1_RATIO, error }),
      prune(),
    );
    const { min, max } = boundsOf(candidate);
    const drift = Math.max(
      ...min.map((v, i) => Math.abs(v - (reference.min[i] ?? 0))),
      ...max.map((v, i) => Math.abs(v - (reference.max[i] ?? 0))),
    );
    if (drift <= LOD1_BOUNDS_TOL_MM) return candidate;
  }
  return null;
}

export async function compressGlb(plain: Uint8Array): Promise<CompressedGlb> {
  const io = await createIo();
  const doc = await io.readBinary(plain);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  doc.getRoot().getAsset().generator = 'hsw-editor bank ingest';
  await doc.transform(dedup(), weld(), prune());
  const trianglesLod0 = countTriangles(doc);

  const lod1Doc = trianglesLod0 > LOD1_MIN_TRIANGLES ? await simplifiedWithinBounds(doc) : null;
  const trianglesLod1 = lod1Doc ? countTriangles(lod1Doc) : trianglesLod0;
  const lod0 = await writeCompressed(io, doc);
  const lod1 = lod1Doc ? await writeCompressed(io, lod1Doc) : lod0;
  return { lod0, lod1, trianglesLod0, trianglesLod1 };
}
