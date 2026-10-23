/**
 * "Draw the missing views of this object": plans one request per view, runs them one at a time
 * through the chosen backend (global single-flight, human pace), gates every image with the CV
 * quality check and hands accepted ones to the wall via `attach`. Generated views are hints for
 * the fitter, never ground truth: candidates always carry `source: 'generated'`.
 */
import { basename } from 'node:path';
import {
  type DrawBackendId,
  type DrawCandidate,
  type DrawObjectSpec,
  type DrawSize,
  type DrawView,
  type DrawViewsOutcome,
  PROMPT_TEMPLATE_VERSION,
  analyzeImage,
  chainRefs,
  planViews,
} from '@hsw-editor/draw';
import { decodeRaw } from './image.ts';
import type { DrawRuntime } from './runtime.ts';
import { SerialQueue } from '../serial-queue.ts';

/** One draw request at a time for the whole server (quota safety, one browser tab). */
const drawQueue = new SerialQueue();

export interface ViewsInput {
  /** Correlation prefix, e.g. `<wallId>/<itemId>`. */
  readonly tag: string;
  readonly object: DrawObjectSpec;
  readonly views: readonly DrawView[];
  /** Absolute paths of the subject photo(s) (already resolved server-side from wall photo ids). */
  readonly subjectPaths: readonly string[];
  readonly size?: DrawSize;
  readonly backend?: DrawBackendId;
  /** Width/height of the object's silhouette in these views when known; enables proportion check. */
  readonly objectAspectByView?: Partial<Record<DrawView, number>>;
}

export interface ViewsHooks {
  readonly signal: AbortSignal;
  progress(done: number, total: number, message: string): void;
  log(message: string): void;
  /** Called for each ACCEPTED candidate; the integration copies it into the wall + adds the op. */
  attach(candidate: DrawCandidate): Promise<void>;
}

export async function generateViews(
  runtime: DrawRuntime,
  input: ViewsInput,
  hooks: ViewsHooks,
): Promise<DrawViewsOutcome> {
  const steps = planViews({
    object: input.object,
    views: input.views,
    ...(input.size === undefined ? {} : { size: input.size }),
  });
  const candidates: DrawCandidate[] = [];
  const acceptedPaths: string[] = [];
  const subject = input.subjectPaths.map((path) => ({ path }));
  for (const [index, step] of steps.entries()) {
    hooks.progress(index, steps.length, `view ${step.view}`);
    const refs = chainRefs(subject, step.useGeneratedRefs ? acceptedPaths : []);
    const result = await drawQueue.run(() =>
      runtime.run(
        {
          version: 1,
          prompt: step.prompt,
          refs,
          n: 1,
          size: step.size,
          outDir: runtime.paths.workDir,
          tag: `${input.tag}/${step.view}`,
        },
        hooks.signal,
        input.backend,
      ),
    );
    if (!result.ok) {
      const { error } = result;
      if (error.code === 'manual_pending' && error.jobDir) {
        return {
          status: 'manual_pending',
          candidates,
          view: step.view,
          manualJobId: basename(error.jobDir).replace(/^manual-/, ''),
          prompt: step.prompt,
          refPaths: refs.map((ref) => ref.path),
        };
      }
      hooks.log(`draw ${step.view} failed: ${error.code}`);
      return {
        status: 'failed',
        candidates,
        view: step.view,
        code: error.code,
        message: error.message,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      };
    }
    for (const image of result.images) {
      const expectedObjectAspect = input.objectAspectByView?.[step.view];
      const quality = analyzeImage(await decodeRaw(image.path), {
        aspect: step.aspect,
        ...(expectedObjectAspect === undefined ? {} : { objectAspect: expectedObjectAspect }),
      });
      const candidate: DrawCandidate = {
        source: 'generated',
        view: step.view,
        backend: result.backend,
        sha256: image.sha256,
        width: image.width,
        height: image.height,
        mime: image.mime,
        path: image.path,
        promptTemplateVersion: PROMPT_TEMPLATE_VERSION,
        prompt: step.prompt,
        quality,
        accepted: quality.ok,
      };
      candidates.push(candidate);
      if (candidate.accepted) {
        acceptedPaths.push(image.path);
        await hooks.attach(candidate);
      } else {
        hooks.log(`draw ${step.view} rejected: ${quality.issues.map((i) => i.code).join(',')}`);
      }
    }
  }
  hooks.progress(steps.length, steps.length, 'done');
  return { status: 'done', candidates };
}
