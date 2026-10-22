/**
 * GLB post-processing: dedupe/prune, quantise, EXT_meshopt_compression, and a simplified LOD1.
 * Input is the plain GLB written by scripts/bank/py/mesh_tool.py (positions in mm, wall frame).
 */
import { Logger, NodeIO, type Document } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { cloneDocument, dedup, prune, quantize, simplify, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

/** Meshes at or below this triangle count share one file for LOD0 and LOD1. */
export const LOD1_MIN_TRIANGLES = 1500;
/** LOD1 keeps this fraction of the triangles and may deviate this much (fraction of mesh size). */
const LOD1_RATIO = 0.25;
const LOD1_ERROR = 0.01;
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

export async function compressGlb(plain: Uint8Array): Promise<CompressedGlb> {
  const io = await createIo();
  const doc = await io.readBinary(plain);
  doc.setLogger(new Logger(Logger.Verbosity.WARN));
  doc.getRoot().getAsset().generator = 'hsw-editor bank ingest';
  await doc.transform(dedup(), weld(), prune());
  const trianglesLod0 = countTriangles(doc);

  let lod1Doc: Document | null = null;
  if (trianglesLod0 > LOD1_MIN_TRIANGLES) {
    lod1Doc = cloneDocument(doc);
    await lod1Doc.transform(
      simplify({ simplifier: MeshoptSimplifier, ratio: LOD1_RATIO, error: LOD1_ERROR }),
      prune(),
    );
  }
  const trianglesLod1 = lod1Doc ? countTriangles(lod1Doc) : trianglesLod0;
  const lod0 = await writeCompressed(io, doc);
  const lod1 = lod1Doc ? await writeCompressed(io, lod1Doc) : lod0;
  return { lod0, lod1, trianglesLod0, trianglesLod1 };
}
