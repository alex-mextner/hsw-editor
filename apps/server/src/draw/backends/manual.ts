/**
 * manual-upload backend: the human is the image generator. The first call writes a job
 * (prompt.txt + copies of the refs) and fails with manual_pending; the UI shows the prompt and
 * refs, the user puts generated files into <jobDir>/inbox/ (or uploads them through the API), and
 * the SAME request called again collects them. Job id = hash(tag|prompt|refs), so retries find it.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type DrawBackend,
  type DrawBackendId,
  DrawError,
  type DrawImage,
  type DrawRequest,
  type DrawResult,
} from '@hsw-editor/draw';
import { IMAGE_FILE_PATTERN, safeStem, saveImage } from '../image.ts';

export function manualJobId(req: DrawRequest): string {
  // `view` refs are earlier DRAWN views (chained for consistency): their paths change run to run and with the backend that drew
  // them, so they are not part of the job's identity; the subject/style refs and the prompt are.
  const key = JSON.stringify([
    req.tag,
    req.prompt,
    req.refs.filter((ref) => ref.role !== 'view').map((ref) => ref.path),
  ]);
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function manualJobDir(req: DrawRequest): string {
  return join(req.outDir, `manual-${manualJobId(req)}`);
}

/**
 * The inbox files oldest first by when they arrived (the later of the modification and the inode change time, so a file moved
 * in with `mv`/`cp -p` counts from the move; name as the tie-break): the NEWEST upload wins, whatever it is called.
 */
async function newestLast(inbox: string, names: readonly string[]): Promise<string[]> {
  const stamped = await Promise.all(
    names.map(async (name) => {
      const { mtimeMs, ctimeMs } = await stat(join(inbox, name));
      return { name, at: Math.max(mtimeMs, ctimeMs) };
    }),
  );
  return stamped.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name)).map((f) => f.name);
}

export class ManualBackend implements DrawBackend {
  readonly id: DrawBackendId = 'manual';

  async draw(req: DrawRequest): Promise<DrawResult> {
    const started = Date.now();
    const id = manualJobId(req);
    const jobDir = manualJobDir(req);
    const inbox = join(jobDir, 'inbox');
    await mkdir(inbox, { recursive: true });
    const have = await newestLast(
      inbox,
      (await readdir(inbox)).filter((name) => IMAGE_FILE_PATTERN.test(name)),
    );
    if (have.length === 0) {
      await writeFile(join(jobDir, 'prompt.txt'), `${req.prompt}\n`);
      // the job is shared by every run of the request, whose chained `view` refs differ: show only the current refs
      for (const old of (await readdir(jobDir)).filter((name) => name.startsWith('ref-'))) {
        await rm(join(jobDir, old));
      }
      for (const [index, ref] of req.refs.entries()) {
        await copyFile(ref.path, join(jobDir, `ref-${index + 1}-${basename(ref.path)}`));
      }
      throw new DrawError(
        'manual_pending',
        `Generate ${req.n} image(s) with the prompt in ${jobDir}/prompt.txt (refs alongside) and put them into ${inbox}`,
        { retryable: true, jobDir },
      );
    }
    const images: DrawImage[] = [];
    // the NEWEST uploads: a rejected or wrong first upload must be replaceable by uploading another one
    for (const [index, name] of have.slice(-req.n).entries()) {
      const bytes = new Uint8Array(await Bun.file(join(inbox, name)).arrayBuffer());
      images.push(
        await saveImage(
          req.outDir,
          `${safeStem(req.tag, 'draw')}-manual-${id}-${index + 1}`,
          bytes,
        ),
      );
    }
    return {
      ok: true,
      backend: this.id,
      ...(req.tag === undefined ? {} : { tag: req.tag }),
      images,
      meta: { elapsedMs: Date.now() - started },
    };
  }
}
