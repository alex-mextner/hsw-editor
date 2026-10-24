/**
 * draw-cli backend: shells out to the user's `draw` (alex-mextner/draw-cli) with `--backend chatgpt`, i.e. the ChatGPT
 * plan signed in to the local Codex CLI. The editor holds NO credentials of its own for it: whether it can run is
 * asked of draw-cli itself (`draw --backend chatgpt --check`, local, spends nothing) on every status call, and a
 * generation just runs `draw` and maps its failure text, so a login done once for draw-cli is the login for the editor.
 * Reference images go through `-i` in the request's order (the photo.clean mask is the second one); the draw-cli
 * chatgpt backend has no size or seed controls, so `req.size` is a hint the model may ignore.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
import { QUOTA_PATTERN, parseRetryAfterMs } from './chatgpt-browser.ts';

export const DRAW_CLI_INSTALL_STEP =
  'uv tool install git+https://github.com/alex-mextner/draw-cli   # or: pipx install git+https://github.com/alex-mextner/draw-cli';
export const DRAW_CLI_LOGIN_STEPS = [
  'codex login   # choose "Sign in with ChatGPT" (API-key login is not accepted by draw-cli)',
] as const;
export const DRAW_CLI_CODEX_STEP = 'npm install -g @openai/codex@latest';

/** draw-cli stops its own Codex child at this budget; the process is killed shortly after as a backstop. */
const KILL_GRACE_MS = 20_000;

export interface DrawCliConfig {
  readonly bin: string;
  readonly guard: GuardConfig;
}

export function drawCliConfig(env: NodeJS.ProcessEnv = process.env): DrawCliConfig {
  return {
    bin: env['HSW_DRAW_CLI_BIN'] ?? 'draw',
    guard: { minIntervalMs: 0, dailyCap: envInt(env, 'HSW_DRAW_CLI_DAILY_CAP', 200, 1) },
  };
}

/** What `draw --backend chatgpt --check` says: draw-cli itself, its Codex, and the ChatGPT login behind it. */
export type DrawCliProbe =
  | { readonly state: 'ready'; readonly detail: string }
  | {
      readonly state: 'login_required' | 'unavailable';
      readonly message: string;
      readonly steps: readonly string[];
    };

/** Classifies draw-cli's own words (its `CodexError` texts) into the contract's failure classes. */
export function classifyDrawCliText(text: string): {
  readonly code:
    | 'login_required'
    | 'quota_exhausted'
    | 'timeout'
    | 'backend_unavailable'
    | 'refused';
  readonly message: string;
} {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^draw:\s*/, '').trim())
      .filter((l) => l !== '' && !/^using ChatGPT subscription/i.test(l))
      .at(-1) ?? 'draw failed without a message';
  const message = line.slice(0, 300);
  if (/login required/i.test(text)) return { code: 'login_required', message };
  if (
    /Codex CLI not found|cannot start Codex|command not found|lacks one or more isolated exec|does not advertise native image_generation|Pillow is required/i.test(
      text,
    )
  ) {
    return { code: 'backend_unavailable', message };
  }
  if (/timed out/i.test(text)) return { code: 'timeout', message };
  if (QUOTA_PATTERN.test(text) || /\b429\b|rate.?limit|usage limit/i.test(text)) {
    return { code: 'quota_exhausted', message };
  }
  return { code: 'refused', message };
}

function spawnDraw(
  bin: string,
  args: readonly string[],
  stdin: string | undefined,
  signal: AbortSignal,
  timeoutMs: number,
  cwd: string | undefined,
) {
  return Bun.spawn([bin, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
    timeout: timeoutMs,
    killSignal: 'SIGINT', // draw-cli stops its Codex child on SIGINT; SIGTERM would orphan it
  });
}

async function runDraw(
  bin: string,
  args: readonly string[],
  stdin: string | undefined,
  signal: AbortSignal,
  timeoutMs: number,
  cwd?: string,
): Promise<{ readonly code: number; readonly out: string }> {
  let proc: ReturnType<typeof spawnDraw>;
  try {
    proc = spawnDraw(bin, args, stdin, signal, timeoutMs, cwd);
  } catch {
    throw new DrawError(
      'backend_unavailable',
      `cannot start \`${bin}\` (draw-cli not installed?)`,
      {
        retryable: false,
      },
    );
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${stdout}\n${stderr}` };
}

/** Local preflight only: no generation, no quota spent (draw-cli's own words, see README "--check"). */
export async function probeDrawCli(bin: string): Promise<DrawCliProbe> {
  let result: { code: number; out: string };
  try {
    result = await runDraw(
      bin,
      ['--backend', 'chatgpt', '--check'],
      undefined,
      AbortSignal.timeout(30_000),
      30_000,
    );
  } catch {
    return {
      state: 'unavailable',
      message: `cannot run \`${bin}\`: draw-cli is not installed`,
      steps: [DRAW_CLI_INSTALL_STEP],
    };
  }
  if (result.code === 0)
    return { state: 'ready', detail: 'draw-cli + Codex signed in with ChatGPT' };
  const failure = classifyDrawCliText(result.out);
  if (failure.code === 'login_required') {
    return { state: 'login_required', message: failure.message, steps: DRAW_CLI_LOGIN_STEPS };
  }
  const missingCodex =
    /Codex CLI not found|cannot start Codex|lacks one or more|does not advertise/i.test(result.out);
  return {
    state: 'unavailable',
    message: failure.message,
    steps: missingCodex ? [DRAW_CLI_CODEX_STEP, ...DRAW_CLI_LOGIN_STEPS] : [],
  };
}

export class DrawCliBackend implements DrawBackend {
  readonly id: DrawBackendId = 'draw-cli';
  constructor(
    private readonly store: GuardStore,
    private readonly config: DrawCliConfig = drawCliConfig(),
  ) {}

  async draw(req: DrawRequest, signal: AbortSignal): Promise<DrawResult> {
    const started = Date.now();
    const deadline = started + (req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    await mkdir(req.outDir, { recursive: true });
    const images: DrawImage[] = [];
    for (let i = 0; i < req.n; i++) {
      await paceSend(this.store, this.id, this.config.guard, signal);
      const budgetMs = deadline - Date.now();
      if (budgetMs < 1000) {
        throw new DrawError('timeout', 'the request budget ran out before draw-cli finished');
      }
      // A private scratch dir per run: two draws into the same outDir never share, overwrite or delete a file.
      const scratch = await mkdtemp(join(req.outDir, '.draw-cli-'));
      const raw = join(scratch, 'out.png');
      const args = [
        '--backend',
        'chatgpt',
        ...req.refs.flatMap((ref) => ['-i', ref.path]),
        '--timeout',
        String(Math.max(1, Math.floor(budgetMs / 1000))),
        '-o',
        raw,
      ];
      try {
        const { code, out } = await runDraw(
          this.config.bin,
          args,
          req.prompt,
          signal,
          budgetMs + KILL_GRACE_MS,
          req.outDir,
        );
        if (code !== 0) {
          if (code === 130) {
            throw new DrawError('backend_unavailable', 'draw was cancelled', { retryable: false });
          }
          const failure = classifyDrawCliText(out);
          const retryAfterMs =
            failure.code === 'quota_exhausted' ? parseRetryAfterMs(out) : undefined;
          throw new DrawError(failure.code, failure.message, {
            retryable: failure.code === 'quota_exhausted' || failure.code === 'timeout',
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          });
        }
        const bytes = new Uint8Array(await Bun.file(raw).arrayBuffer());
        const stem = `${safeStem(req.tag, 'draw')}-${basename(scratch).slice('.draw-cli-'.length)}-${i + 1}`;
        images.push(await saveImage(req.outDir, stem, bytes));
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    return {
      ok: true,
      backend: this.id,
      ...(req.tag === undefined ? {} : { tag: req.tag }),
      images,
      meta: {
        elapsedMs: Date.now() - started,
        model: 'chatgpt-images via draw-cli (Codex-managed)',
      },
    };
  }
}
