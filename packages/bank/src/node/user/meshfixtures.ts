/** Test-only: tiny STL / GLB / 3MF files built in memory (millimetres, Z-up like real CAD output). */
import { Document, NodeIO } from '@gltf-transform/core';

type Vec = [number, number, number];

interface Box {
  vertices: Vec[];
  triangles: [number, number, number][];
}

/** Outward-facing box with its minimum corner at `origin`. */
export function box(size: Vec, origin: Vec = [0, 0, 0]): Box {
  const [w, d, h] = size;
  const [ox, oy, oz] = origin;
  const vertices: Vec[] = [];
  for (const z of [0, h])
    for (const y of [0, d]) for (const x of [0, w]) vertices.push([ox + x, oy + y, oz + z]);
  // vertex index = x + 2y + 4z
  const triangles: [number, number, number][] = [
    [0, 2, 3],
    [0, 3, 1], // bottom (-z)
    [4, 5, 7],
    [4, 7, 6], // top (+z)
    [0, 1, 5],
    [0, 5, 4], // front (-y)
    [2, 6, 7],
    [2, 7, 3], // back (+y)
    [0, 4, 6],
    [0, 6, 2], // left (-x)
    [1, 3, 7],
    [1, 7, 5], // right (+x)
  ];
  return { vertices, triangles };
}

/** Binary STL of a box; `open` leaves the top out (not watertight). */
export function boxStl(size: Vec, options: { open?: boolean; origin?: Vec } = {}): Uint8Array {
  return boxesStl([{ size, ...(options.origin ? { origin: options.origin } : {}) }], options.open);
}

/**
 * Binary STL of several boxes in one mesh. Two boxes that only touch along an edge make an edge shared by
 * four faces: not watertight, and no hole filling can fix it.
 */
export function boxesStl(boxes: { size: Vec; origin?: Vec }[], open = false): Uint8Array {
  const tris: Vec[][] = [];
  for (const { size, origin } of boxes) {
    const { vertices, triangles } = box(size, origin);
    for (const [i, tri] of triangles.entries()) {
      if (open && i >= 2 && i <= 3) continue;
      tris.push(tri.map((v) => vertices[v] ?? [0, 0, 0]));
    }
  }
  const out = new Uint8Array(84 + tris.length * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, tris.length, true);
  for (const [i, tri] of tris.entries()) {
    const base = 84 + i * 50;
    for (const [k, p] of tri.entries())
      for (let c = 0; c < 3; c++) view.setFloat32(base + 12 + k * 12 + c * 4, p[c] ?? 0, true);
  }
  return out;
}

/** GLB of a box whose numbers are in `unitScale` metres per unit (0.001: millimetre numbers; 1: a metre scene). */
export async function boxGlb(size: Vec, unitScale: number): Promise<Uint8Array> {
  const { vertices, triangles } = box(size);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const position = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(vertices.flat().map((v) => v * unitScale)))
    .setBuffer(buffer);
  const indices = doc
    .createAccessor()
    .setType('SCALAR')
    .setArray(new Uint16Array(triangles.flat()))
    .setBuffer(buffer);
  const primitive = doc.createPrimitive().setAttribute('POSITION', position).setIndices(indices);
  const mesh = doc.createMesh().addPrimitive(primitive);
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  return new NodeIO().writeBinary(doc);
}

const encoder = new TextEncoder();

/** A ZIP with stored (uncompressed) entries: enough for a 3MF package. */
function zip(entries: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const crc = Bun.hash.crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const header = new Uint8Array(46 + nameBytes.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 20, true);
    hv.setUint32(16, crc, true);
    hv.setUint32(20, data.length, true);
    hv.setUint32(24, data.length, true);
    hv.setUint16(28, nameBytes.length, true);
    hv.setUint32(42, offset, true);
    header.set(nameBytes, 46);
    chunks.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...chunks, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A 3MF with one build item per box (millimetres). */
export function boxes3mf(boxes: { size: Vec; origin?: Vec }[]): Uint8Array {
  const objects = boxes
    .map(({ size, origin }, index) => {
      const { vertices, triangles } = box(size, origin);
      const v = vertices.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('');
      const t = triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('');
      return `<object id="${index + 1}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
    })
    .join('');
  const items = boxes.map((_, index) => `<item objectid="${index + 1}"/>`).join('');
  return zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    '3D/3dmodel.model': `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${items}</build></model>`,
  });
}
