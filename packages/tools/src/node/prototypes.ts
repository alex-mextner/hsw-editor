/**
 * Loading of the recognition prototype index written by `scripts/prototypes.ts` + `scripts/py/embed.py`
 * (`<dir>/{manifest.json,meta.json,prototypes.f32,text.f32,classes.json}`) and of `.npy` float32 matrices
 * (the sidecar writes the crop embeddings of an analysis as `embeddings.npy`).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type PrototypeIndex, buildPrototypeIndex, readF32 } from '../recognize/fuse.ts';

export async function readFloat32(path: string, dim: number): Promise<Float32Array> {
  const b = await readFile(path);
  return readF32(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, dim);
}

/**
 * The prototype index, or null when it has not been built or does not match the registered classes (a class was
 * added since: `bun run tools:prototypes` has to be run again). A broken index is reported, never silently used.
 */
export async function loadPrototypeIndex(
  dir: string,
  expectedClassIds: readonly string[],
  warn: (message: string) => void = console.warn,
): Promise<PrototypeIndex | null> {
  let metaRaw: string;
  try {
    metaRaw = await readFile(join(dir, 'meta.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const meta = JSON.parse(metaRaw) as { dim: number; dinoDim?: number; classes: string[] };
    const missing = expectedClassIds.filter((id) => !meta.classes.includes(id));
    if (missing.length > 0) {
      warn(
        `tool prototypes in ${dir} are stale (no ${missing.join(', ')}); rebuild: bun run tools:prototypes`,
      );
      return null;
    }
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      classId: string;
    }[];
    const withImages = new Set(manifest.map((m) => m.classId));
    const bare = expectedClassIds.filter((id) => !withImages.has(id));
    if (bare.length > 0) {
      // a class without prototype images would score -1 against every crop and vanish from the suggestions
      warn(
        `tool prototypes in ${dir} have no images for ${bare.join(', ')}; rebuild: bun run tools:prototypes`,
      );
      return null;
    }
    const dino = await readDinoPrototypes(dir, meta.dinoDim, manifest.length, warn);
    const text = await readFloat32(join(dir, 'text.f32'), meta.dim);
    const protos = await readFloat32(join(dir, 'prototypes.f32'), meta.dim);
    if (
      text.length !== meta.classes.length * meta.dim ||
      protos.length !== manifest.length * meta.dim
    ) {
      // files from different runs of tools:prototypes / embed.py would label embeddings with the wrong classes
      warn(
        `tool prototypes in ${dir} do not match their manifest (rebuild: bun run tools:prototypes, then embed.py)`,
      );
      return null;
    }
    return buildPrototypeIndex({
      dim: meta.dim,
      classIds: meta.classes,
      text,
      protos,
      protoClassIds: manifest.map((m) => m.classId),
      ...(dino ?? {}),
    });
  } catch (error) {
    warn(
      `tool prototypes in ${dir} are unreadable (${String(error)}); using text recognition only`,
    );
    return null;
  }
}

/** DINOv2 prototypes (`dino-prototypes.f32`, `dinoDim` in meta.json) when present and consistent with the manifest. */
async function readDinoPrototypes(
  dir: string,
  dinoDim: number | undefined,
  prototypes: number,
  warn: (message: string) => void,
): Promise<{ dinoDim: number; dinoProtos: Float32Array } | null> {
  if (!dinoDim) return null;
  try {
    const dinoProtos = await readFloat32(join(dir, 'dino-prototypes.f32'), dinoDim);
    if (dinoProtos.length === prototypes * dinoDim) return { dinoDim, dinoProtos };
    warn(
      `tool prototypes in ${dir}: dino-prototypes.f32 does not match the manifest; DINOv2 retrieval is off`,
    );
  } catch (error) {
    warn(
      `tool prototypes in ${dir}: dino-prototypes.f32 is unreadable (${String(error)}); DINOv2 retrieval is off`,
    );
  }
  return null;
}

export interface NpyMatrix {
  rows: number;
  dim: number;
  data: Float32Array;
}

/** Rows of a 2-D little-endian float32 `.npy` file. */
export async function readNpyFloat32(path: string): Promise<NpyMatrix> {
  const b = await readFile(path);
  const bytes = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== 'NUMPY') {
    throw new Error(`${path} is not an .npy file`);
  }
  const major = bytes[6] ?? 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = (major === 1 ? 10 : 12) + headerLen;
  const header = new TextDecoder().decode(bytes.subarray(major === 1 ? 10 : 12, start));
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) {
    throw new Error(`${path}: only C-order little-endian float32 is supported`);
  }
  const shape = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(header);
  if (!shape) throw new Error(`${path}: expected a 2-D array`);
  const rows = Number(shape[1]);
  const dim = Number(shape[2]);
  const data = new Float32Array(bytes.slice(start, start + rows * dim * 4).buffer);
  return { rows, dim, data };
}
