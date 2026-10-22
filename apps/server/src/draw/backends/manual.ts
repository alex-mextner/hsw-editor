/**
 * manual-upload backend: the human is the image generator. The first call writes a job
 * (prompt.txt + copies of the refs) and fails with manual_pending; the UI shows the prompt and
 * refs, the user puts generated files into <jobDir>/inbox/ (or uploads them through the API), and
 * the SAME request called again collects them. Job id = hash(tag|prompt|refs), so retries find it.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
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
  const key = JSON.stringify([req.tag, req.prompt, req.refs.map((ref) => ref.path)]);
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function manualJobDir(req: DrawRequest): string {
  return join(req.outDir, `manual-${manualJobId(req)}`);
}

export class ManualBackend implements DrawBackend {
  readonly id: DrawBackendId = 'manual';

  async draw(req: DrawRequest): Promise<DrawResult> {
    const started = Date.now();
    const id = manualJobId(req);
    const jobDir = manualJobDir(req);
    const inbox = join(jobDir, 'inbox');
    await mkdir(inbox, { recursive: true });
    const have = (await readdir(inbox)).filter((name) => IMAGE_FILE_PATTERN.test(name)).sort();
    if (have.length === 0) {
      await writeFile(join(jobDir, 'prompt.txt'), `${req.prompt}\n`);
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
    for (const [index, name] of have.slice(0, req.n).entries()) {
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
