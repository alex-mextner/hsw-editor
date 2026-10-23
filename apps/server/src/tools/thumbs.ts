/**
 * Thumbnails of built-in tool classes, rendered on demand with the software renderer and cached twice: in-process
 * (rendering is shared by concurrent requests) and on disk under `<home>/cache/tool-thumbs/<key>.webp`.
 *
 * The key hashes the class id, the resolved parameters and the bytes of the generated GLB, so a generator change
 * invalidates old thumbnails by itself; stale files are never read, only left behind.
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ToolModel, exportGlb } from '@hsw-editor/tools';
import { renderThumbWebp } from '@hsw-editor/tools/node';

const MEMO_SIZE = 256;
/** Bump when `renderThumbWebp` / the rasteriser change how a model looks: it is part of every cache key. */
const RENDER_VERSION = 1;
const memo = new Map<string, Promise<Uint8Array>>();

export function thumbKey(model: ToolModel): string {
  const params = JSON.stringify(
    Object.entries(model.params).sort(([a], [b]) => a.localeCompare(b)),
  );
  const glb = createHash('sha256').update(exportGlb(model)).digest('hex');
  return createHash('sha256')
    .update(`${RENDER_VERSION}\n${model.classId}\n${params}\n${glb}`)
    .digest('hex')
    .slice(0, 32);
}

async function fromDisk(file: string): Promise<Uint8Array | null> {
  const f = Bun.file(file);
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
}

async function renderAndStore(
  dir: string,
  key: string,
  model: ToolModel,
  persist: boolean,
): Promise<Uint8Array> {
  const file = join(dir, `${key}.webp`);
  const cached = await fromDisk(file);
  if (cached && cached.byteLength > 0) return cached;
  const bytes = await renderThumbWebp(model);
  if (!persist) return bytes;
  // the cache is best effort: an unwritable data directory must not turn a rendered thumbnail into an error
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, bytes);
    await rename(tmp, file);
  } catch {
    await rm(tmp, { force: true });
  }
  return bytes;
}

/**
 * WebP bytes of the model's thumbnail; concurrent calls for one key render once. `persist` writes the result to disk:
 * only for the default and preset builds, a free-form `p` has unboundedly many keys and stays in the bounded memo.
 */
export function classThumb(
  home: string,
  model: ToolModel,
  persist: boolean,
): { key: string; bytes: Promise<Uint8Array> } {
  const key = thumbKey(model);
  // per data directory and persistence mode: a memoised render must have been written where this request expects it
  const dir = join(home, 'cache', 'tool-thumbs');
  const memoKey = `${dir}\0${key}\0${persist}`;
  let bytes = memo.get(memoKey);
  if (!bytes) {
    bytes = renderAndStore(dir, key, model, persist);
    memo.set(memoKey, bytes);
    bytes.then(
      () => {
        if (memo.size > MEMO_SIZE) {
          const oldest = memo.keys().next();
          if (!oldest.done) memo.delete(oldest.value);
        }
      },
      () => memo.delete(memoKey),
    );
  }
  return { key, bytes };
}
