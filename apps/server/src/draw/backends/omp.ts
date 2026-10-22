/**
 * omp backend: a throwaway `omp -p --mode json` run with generate_image enabled through a per-run
 * --config overlay (the user's omp config is never modified). A cheap driver model makes exactly
 * one tool call; the tool_execution_end event carries the image paths. Success shape
 * (details.imagePaths) is from omp://tools/generate_image.md; it has not been seen live because
 * omp holds no image-capable credentials on this machine yet (login_required is proven instead).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_TIMEOUT_MS,
  type DrawBackend,
  type DrawBackendId,
  DrawError,
  type DrawImage,
  type DrawRequest,
  type DrawResult,
} from '@hsw-editor/draw';
import { safeStem, saveImage } from '../image.ts';
import { type GuardConfig, type GuardStore } from '../guard.ts';
import { envInt } from '../env.ts';
import { paceSend } from '../pacing.ts';

interface ToolEnd {
  readonly type: 'tool_execution_end';
  readonly toolName: string;
  readonly isError?: boolean;
  readonly result: {
    readonly content?: ReadonlyArray<{ type: string; text?: string }>;
    readonly details?: { imagePaths?: string[]; model?: string };
  };
}

function isToolEnd(value: unknown): value is ToolEnd {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'tool_execution_end' &&
    'toolName' in value &&
    'result' in value
  );
}

/** A second omp run needs at least this much of the request budget left to be worth spawning. */
const MIN_RETRY_BUDGET_MS = 15_000;

export const OMP_LOGIN_STEPS = [
  'omp login openai-codex   # ChatGPT Plus/Pro (headless: openai-codex-device)',
  'or export one of OPENROUTER_API_KEY / GEMINI_API_KEY / XAI_API_KEY',
] as const;

export function mapOmpError(text: string): DrawError {
  if (
    /exhausted the resolved image chain|did not match an available image model|credentials unavailable|hosted chat carrier unavailable|no models available/i.test(
      text,
    )
  ) {
    return new DrawError(
      'login_required',
      'omp has no image-capable credentials. One-time: `omp login openai-codex` (ChatGPT Plus/Pro) or set OPENROUTER_API_KEY / GEMINI_API_KEY / XAI_API_KEY',
      { retryable: false, detail: { omp: text.slice(0, 200) } },
    );
  }
  if (/429|rate.?limit|quota|usage limit/i.test(text)) {
    return new DrawError('quota_exhausted', text.slice(0, 300));
  }
  if (/timed? ?out|timeout/i.test(text)) return new DrawError('timeout', text.slice(0, 300));
  return new DrawError('refused', text.slice(0, 300), { retryable: false });
}

export interface OmpConfig {
  readonly bin: string;
  /** Cheap model that only has to emit one tool call. */
  readonly driverModel: string;
  readonly guard: GuardConfig;
}

export function ompConfig(env: NodeJS.ProcessEnv = process.env): OmpConfig {
  return {
    bin: env['HSW_OMP_BIN'] ?? 'omp',
    driverModel: env['HSW_DRAW_OMP_MODEL'] ?? 'haiku',
    guard: { minIntervalMs: 0, dailyCap: envInt(env, 'HSW_DRAW_OMP_DAILY_CAP', 200, 1) },
  };
}

export class OmpBackend implements DrawBackend {
  readonly id: DrawBackendId = 'omp';
  constructor(
    private readonly store: GuardStore,
    private readonly config: OmpConfig = ompConfig(),
  ) {}

  async draw(req: DrawRequest, signal: AbortSignal): Promise<DrawResult> {
    const started = Date.now();
    const deadline = started + (req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await mkdir(req.outDir, { recursive: true });
    const overlay = join(req.outDir, '.omp-draw-overlay.yml');
    await Bun.write(overlay, 'generate_image:\n  enabled: true\n');
    const images: DrawImage[] = [];
    let model: string | undefined;
    for (let i = 0; i < req.n; i++) {
      await paceSend(this.store, this.id, this.config.guard, signal);
      const subject = req.refs.length
        ? `${req.refs.map((ref, k) => `Image ${k + 1} is a ${ref.role ?? 'reference'} photo.`).join(' ')} ${req.prompt}`
        : req.prompt;
      const args = {
        subject,
        ...(req.refs.length
          ? { changes: [req.prompt], input: req.refs.map((ref) => ({ path: ref.path })) }
          : {}),
        image_size: req.size,
      };
      const instruction = `Call the generate_image tool exactly once with these JSON arguments, unchanged, then stop: ${JSON.stringify(args)}`;
      // The driver model occasionally answers in prose instead of calling the tool; one retry.
      let end: ToolEnd | undefined;
      for (let attempt = 0; attempt < 2 && !end; attempt++) {
        if (attempt > 0 && deadline - Date.now() < MIN_RETRY_BUDGET_MS) break;
        end = await this.runOnce(req, overlay, instruction, signal, deadline);
      }
      if (!end && Date.now() >= deadline - 1000) {
        throw new DrawError('timeout', 'omp did not finish generate_image before the deadline');
      }
      if (!end) {
        throw new DrawError(
          'backend_unavailable',
          'omp finished without calling generate_image (twice)',
          {
            retryable: false,
          },
        );
      }
      const text = end.result.content?.map((c) => c.text ?? '').join(' ') ?? '';
      if (end.isError) throw mapOmpError(text);
      const paths = end.result.details?.imagePaths ?? [];
      if (paths.length === 0) {
        throw new DrawError('refused', `generate_image returned no image: ${text.slice(0, 200)}`, {
          retryable: false,
        });
      }
      model = end.result.details?.model ?? model;
      for (const [k, path] of paths.entries()) {
        const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
        images.push(
          await saveImage(
            req.outDir,
            `${safeStem(req.tag, 'draw')}-${Date.now()}-${i + 1}-${k + 1}`,
            bytes,
          ),
        );
      }
    }
    return {
      ok: true,
      backend: this.id,
      ...(req.tag === undefined ? {} : { tag: req.tag }),
      images,
      meta: { elapsedMs: Date.now() - started, ...(model === undefined ? {} : { model }) },
    };
  }

  private async runOnce(
    req: DrawRequest,
    overlay: string,
    instruction: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<ToolEnd | undefined> {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'ignore'>;
    try {
      proc = Bun.spawn(
        [
          this.config.bin,
          '--config',
          overlay,
          '--mode',
          'json',
          '--no-session',
          '--no-extensions',
          '--no-skills',
          '--no-rules',
          '--no-lsp',
          '--tools',
          'generate_image',
          '--auto-approve',
          '--model',
          this.config.driverModel,
          '-p',
          instruction,
        ],
        {
          cwd: req.outDir,
          stdout: 'pipe',
          stderr: 'ignore', // never piped: an undrained pipe would block the child
          signal,
          timeout: Math.max(1000, deadline - Date.now()),
        },
      );
    } catch {
      throw new DrawError('backend_unavailable', `cannot start ${this.config.bin}`, {
        retryable: false,
      });
    }
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    let end: ToolEnd | undefined;
    for (const line of out.split('\n')) {
      if (!line.startsWith('{')) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (isToolEnd(event) && event.toolName === 'generate_image') end = event;
    }
    return end;
  }
}
