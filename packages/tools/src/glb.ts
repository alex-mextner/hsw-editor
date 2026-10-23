/**
 * Binary glTF 2.0 export of a `ToolModel`: one node and mesh per named part, metallic-roughness
 * materials, millimetre units (same frame as the bank GLBs: Y up, no scale needed in a mm scene).
 * Holding interface and parameters travel in `extras` of the scene so the editor needs no second file.
 */
import { linearColor } from './materials.ts';
import { type ToolModel } from './model.ts';
import { shade } from './mesh.ts';

interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'VEC3' | 'SCALAR';
  min?: number[];
  max?: number[];
}

const FLOAT = 5126;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function pad4(n: number): number {
  return (n + 3) & ~3;
}

export function exportGlb(model: ToolModel, extras: Record<string, unknown> = {}): Uint8Array {
  const bufferViews: { buffer: 0; byteOffset: number; byteLength: number; target: number }[] = [];
  const accessors: GltfAccessor[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const pushView = (data: ArrayBufferView, target: number): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    const padded = new Uint8Array(pad4(bytes.byteLength));
    padded.set(bytes);
    chunks.push(padded);
    offset += padded.byteLength;
    return bufferViews.length - 1;
  };

  const materials: Record<string, unknown>[] = [];
  const materialIndex = new Map<string, number>();
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];

  for (const part of model.parts) {
    const s = shade(part.mesh, part.crease ?? 50);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = s.positions[i + k] ?? 0;
        if (v < (min[k] ?? 0)) min[k] = v;
        if (v > (max[k] ?? 0)) max[k] = v;
      }
    }
    const posAcc =
      accessors.push({
        bufferView: pushView(s.positions, ARRAY_BUFFER),
        componentType: FLOAT,
        count: s.positions.length / 3,
        type: 'VEC3',
        min,
        max,
      }) - 1;
    const nrmAcc =
      accessors.push({
        bufferView: pushView(s.normals, ARRAY_BUFFER),
        componentType: FLOAT,
        count: s.normals.length / 3,
        type: 'VEC3',
      }) - 1;
    const idxAcc =
      accessors.push({
        bufferView: pushView(s.indices, ELEMENT_ARRAY_BUFFER),
        componentType: UINT,
        count: s.indices.length,
        type: 'SCALAR',
      }) - 1;

    const m = part.material;
    const key = JSON.stringify([m.name, m.color, m.metallic, m.roughness, m.alpha]);
    let mi = materialIndex.get(key);
    if (mi === undefined) {
      mi = materials.length;
      materialIndex.set(key, mi);
      materials.push({
        name: m.name,
        pbrMetallicRoughness: {
          baseColorFactor: linearColor(m.color, m.alpha),
          metallicFactor: m.metallic,
          roughnessFactor: m.roughness,
        },
        alphaMode: m.alpha < 1 ? 'BLEND' : 'OPAQUE',
        doubleSided: false,
        extras: { kind: m.kind, color: m.color, ...(m.grip ? { grip: m.grip } : {}) },
      });
    }
    meshes.push({
      name: part.name,
      primitives: [
        {
          attributes: { POSITION: posAcc, NORMAL: nrmAcc },
          indices: idxAcc,
          material: mi,
          mode: 4,
        },
      ],
    });
    nodes.push({ name: part.name, mesh: meshes.length - 1, extras: { role: part.role } });
  }

  const root = {
    name: model.classId,
    children: nodes.map((_, i) => i),
  };
  nodes.push(root);
  const json = {
    asset: { version: '2.0', generator: '@hsw-editor/tools' },
    scene: 0,
    scenes: [
      {
        name: model.classId,
        nodes: [nodes.length - 1],
        extras: {
          units: 'mm',
          frame: 'tool: +Y butt to working end, +Z towards viewer, origin on axis at butt',
          classId: model.classId,
          lod: model.lod,
          params: model.params,
          holding: model.holding,
          ...extras,
        },
      },
    ],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = new Uint8Array(pad4(jsonBytes.byteLength)).fill(0x20);
  jsonPadded.set(jsonBytes);
  const total = 12 + 8 + jsonPadded.byteLength + 8 + offset;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded.byteLength, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonPadded, 20);
  let p = 20 + jsonPadded.byteLength;
  dv.setUint32(p, offset, true);
  dv.setUint32(p + 4, 0x004e4942, true);
  p += 8;
  for (const c of chunks) {
    out.set(c, p);
    p += c.byteLength;
  }
  return out;
}
