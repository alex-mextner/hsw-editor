/**
 * What the editor reads back from a tool GLB without a glTF loader: the bounding box (from the position
 * accessors) and the holding summary (scene `extras.holding`, written by `exportGlb`). It also checks the container, so
 * the asset store can tell a truncated or foreign file from a tool model. Pure: no Node, no DOM.
 */
import type { HoldingSummary } from './dims.ts';

const MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export interface GlbMeta {
  /** x width, y length, z thickness of the box, and its centre, in the tool frame (mm). */
  dims: { x: number; y: number; z: number };
  centre: { x: number; y: number; z: number };
  triangles: number;
  holding: HoldingSummary | null;
}

interface GltfAccessorLike {
  type?: string;
  count?: number;
  min?: number[];
  max?: number[];
}

interface GltfLike {
  accessors?: GltfAccessorLike[];
  meshes?: { primitives?: { attributes?: Record<string, number>; indices?: number }[] }[];
  scenes?: { extras?: { holding?: RawHolding } }[];
}

/** `HoldingInterface` as `exportGlb` wrote it; only the summary fields are read. */
interface RawHolding {
  lengthMm?: number;
  hang?: HoldingSummary['hang'];
  maxSection?: { w?: number; t?: number; r?: number };
  dims?: Record<string, number>;
}

function summaryOf(raw: RawHolding | undefined): HoldingSummary | null {
  if (raw?.lengthMm === undefined || !raw.maxSection) return null;
  const { w, t, r } = raw.maxSection;
  if (w === undefined || t === undefined || r === undefined) return null;
  return {
    lengthMm: raw.lengthMm,
    hang: raw.hang ?? null,
    maxSection: { w, t, r },
    dims: { ...raw.dims },
  };
}

function fail(message: string): never {
  throw new Error(`not a tool GLB: ${message}`);
}

/** Parses and checks a binary glTF produced by `exportGlb`; throws a readable error when it is not one. */
export function readGlbMeta(bytes: Uint8Array): GlbMeta {
  if (bytes.byteLength < 28) fail('shorter than a GLB header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) fail('bad magic');
  if (view.getUint32(4, true) !== 2) fail('not glTF 2');
  if (view.getUint32(8, true) !== bytes.byteLength)
    fail('length differs from the header (truncated?)');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON) fail('first chunk is not JSON');
  const binHeader = 20 + jsonLength;
  if (binHeader + 8 > bytes.byteLength) fail('no binary chunk');
  if (view.getUint32(binHeader + 4, true) !== CHUNK_BIN) fail('second chunk is not BIN');
  if (binHeader + 8 + view.getUint32(binHeader, true) > bytes.byteLength)
    fail('binary chunk overruns the file');
  let gltf: GltfLike;
  try {
    gltf = JSON.parse(new TextDecoder().decode(bytes.subarray(20, binHeader))) as GltfLike;
  } catch {
    return fail('JSON chunk does not parse');
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let indices = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const position = gltf.accessors?.[primitive.attributes?.['POSITION'] ?? -1];
      if (!position?.min || !position.max) fail('a mesh has no position bounds');
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis] ?? Infinity, position.min[axis] ?? Infinity);
        max[axis] = Math.max(max[axis] ?? -Infinity, position.max[axis] ?? -Infinity);
      }
      indices += gltf.accessors?.[primitive.indices ?? -1]?.count ?? 0;
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) fail('no geometry');
  const [x0 = 0, y0 = 0, z0 = 0] = min;
  const [x1 = 0, y1 = 0, z1 = 0] = max;
  return {
    dims: { x: x1 - x0, y: y1 - y0, z: z1 - z0 },
    centre: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    triangles: Math.round(indices / 3),
    holding: summaryOf(gltf.scenes?.[0]?.extras?.holding),
  };
}
