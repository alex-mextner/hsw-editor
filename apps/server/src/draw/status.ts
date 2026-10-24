/** `/api/draw/backends`, `hsw-editor draw status`, `hsw-editor doctor draw`: one source of truth. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type DrawBackendId, type DrawBackendStatus, DrawError } from '@hsw-editor/draw';
import { CHATGPT_LOGIN_STEPS, probeChatgptLogin } from './backends/chatgpt-browser.ts';
import { type DrawCliProbe, probeDrawCli } from './backends/draw-cli.ts';
import { OMP_LOGIN_STEPS } from './backends/omp.ts';
import { findChrome, findXvfb } from './browser-process.ts';
import {
  DAY_MS,
  type BackendGuard,
  applyFailure,
  gate,
  recordHealthy,
  recordLoginRequired,
} from './guard.ts';
import type { DrawRuntime } from './runtime.ts';

export interface StatusOptions {
  /** Run live checks (omp model list; ChatGPT page load in the dedicated browser). */
  readonly probe: boolean;
}

/** Does omp list at least one image-capable model? Cheap, no tokens spent. */
export type OmpProbe = 'ready' | 'login_required' | 'unavailable';

export async function probeOmpImageModels(bin: string): Promise<OmpProbe> {
  try {
    const proc = Bun.spawn([bin, 'models', 'ls', '--kind', 'image'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const out = `${stdout}${stderr}`;
    const code = await proc.exited;
    if (/no models available/i.test(out) || (code === 0 && out.trim() === ''))
      return 'login_required';
    return code === 0 ? 'ready' : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

const OMP_PROBE_TTL_MS = 60_000;
let ompProbeCache: { at: number; bin: string; result: OmpProbe } | null = null;

/** `omp models ls --kind image` is cheap and spends nothing, so it runs on every status call (TTL-cached). */
async function cachedOmpProbe(bin: string, force: boolean): Promise<OmpProbe> {
  const now = Date.now();
  if (
    !force &&
    ompProbeCache &&
    ompProbeCache.bin === bin &&
    now - ompProbeCache.at < OMP_PROBE_TTL_MS
  ) {
    return ompProbeCache.result;
  }
  const result = await probeOmpImageModels(bin);
  ompProbeCache = { at: now, bin, result };
  return result;
}

const DRAW_CLI_PROBE_TTL_MS = 60_000;
let drawCliProbeCache: { at: number; bin: string; result: DrawCliProbe } | null = null;

/** `draw --backend chatgpt --check` is local and spends nothing, so it runs on every status call (TTL-cached). */
async function cachedDrawCliProbe(bin: string, force: boolean): Promise<DrawCliProbe> {
  const now = Date.now();
  if (
    !force &&
    drawCliProbeCache &&
    drawCliProbeCache.bin === bin &&
    now - drawCliProbeCache.at < DRAW_CLI_PROBE_TTL_MS
  ) {
    return drawCliProbeCache.result;
  }
  const result = await probeDrawCli(bin);
  drawCliProbeCache = { at: now, bin, result };
  return result;
}

function sendsLast24h(guard: BackendGuard, now: number): number {
  return guard.sends.filter((t) => now - t < DAY_MS).length;
}

/** draw-cli: ready exactly when draw-cli itself says its Codex is signed in with ChatGPT; no login of the editor's own. */
async function drawCliStatus(
  runtime: DrawRuntime,
  options: StatusOptions,
): Promise<DrawBackendStatus> {
  const now = Date.now();
  const probe = await cachedDrawCliProbe(runtime.drawCli.bin, options.probe);
  if (probe.state === 'unavailable') {
    const guard = await runtime.store.get('draw-cli');
    return {
      id: 'draw-cli',
      state: 'unavailable',
      message: probe.message,
      steps: probe.steps,
      verified: true,
      sendsLast24h: sendsLast24h(guard, now),
      dailyCap: runtime.drawCli.guard.dailyCap,
    };
  }
  const guard = await runtime.store.update('draw-cli', (g) =>
    probe.state === 'ready' ? recordHealthy(g, now) : recordLoginRequired(g, now),
  );
  const status = fromGuard('draw-cli', guard, runtime.drawCli.guard, now, {
    loginMessage: probe.state === 'login_required' ? probe.message : 'draw-cli is not signed in',
    loginSteps: probe.state === 'login_required' ? probe.steps : [],
    neverVerifiedIsLogin: false,
    verified: true,
  });
  return status.state === 'ready' && probe.state === 'ready'
    ? { ...status, message: `ready: ${probe.detail}` }
    : status;
}

async function ompStatus(runtime: DrawRuntime, options: StatusOptions): Promise<DrawBackendStatus> {
  const now = Date.now();
  const result = await cachedOmpProbe(runtime.omp.bin, options.probe);
  if (result === 'unavailable') {
    const guard = await runtime.store.get('omp');
    return {
      id: 'omp',
      state: 'unavailable',
      message: `cannot run \`${runtime.omp.bin} models ls --kind image\``,
      steps: ['install omp, or set HSW_OMP_BIN'],
      verified: true,
      sendsLast24h: sendsLast24h(guard, now),
      dailyCap: runtime.omp.guard.dailyCap,
    };
  }
  const guard = await runtime.store.update('omp', (g) =>
    result === 'ready' ? recordHealthy(g, now) : recordLoginRequired(g, now),
  );
  return fromGuard('omp', guard, runtime.omp.guard, now, {
    loginMessage: 'omp has no image-capable credentials',
    loginSteps: OMP_LOGIN_STEPS,
    neverVerifiedIsLogin: false,
    verified: true,
  });
}

async function chatgptStatus(
  runtime: DrawRuntime,
  options: StatusOptions,
): Promise<DrawBackendStatus> {
  const now = Date.now();
  const config = runtime.chatgpt;
  if (!findChrome()) {
    return {
      id: 'chatgpt-browser',
      state: 'unavailable',
      message: 'Chrome not found',
      steps: ['install Google Chrome/Chromium, or set HSW_CHATGPT_CHROME'],
      verified: true,
      sendsLast24h: 0,
      dailyCap: config.guard.dailyCap,
    };
  }
  if (!config.browser.headless && !findXvfb()) {
    return {
      id: 'chatgpt-browser',
      state: 'unavailable',
      message: 'Xvfb not found (the automation browser runs on a private virtual display)',
      steps: ['install Xvfb, or set HSW_XVFB'],
      verified: true,
      sendsLast24h: 0,
      dailyCap: config.guard.dailyCap,
    };
  }
  let probed = false;
  if (options.probe && existsSync(join(config.browser.profileDir, 'Default'))) {
    try {
      // Fails fast with 'already in use' when a draw (or another probe) owns the browser.
      const result = await probeChatgptLogin(config);
      probed = true;
      await runtime.store.update('chatgpt-browser', (g) =>
        result.loggedIn
          ? recordHealthy(g, now)
          : result.error
            ? applyFailure(g, result.error, now)
            : g,
      );
    } catch (error) {
      if (!(error instanceof DrawError)) throw error;
      return {
        id: 'chatgpt-browser',
        state: 'unavailable',
        message: error.message,
        steps: [],
        verified: true,
        sendsLast24h: 0,
        dailyCap: config.guard.dailyCap,
      };
    }
  } else if (options.probe) {
    // Profile never created: certainly logged out, no need to start a browser to learn that.
    await runtime.store.update('chatgpt-browser', (g) => recordLoginRequired(g, now));
    probed = true;
  }
  const guard = await runtime.store.get('chatgpt-browser');
  return fromGuard('chatgpt-browser', guard, config.guard, now, {
    loginMessage: 'the dedicated ChatGPT profile is not logged in',
    loginSteps: CHATGPT_LOGIN_STEPS,
    neverVerifiedIsLogin: true,
    verified: probed || guard.lastOkAt > 0 || guard.loginRequiredAt > 0,
  });
}

interface GuardView {
  readonly loginMessage: string;
  readonly loginSteps: readonly string[];
  /** Backends with no live probe are reported logged-out until a run/probe proved otherwise. */
  readonly neverVerifiedIsLogin: boolean;
  readonly verified: boolean;
}

function fromGuard(
  id: DrawBackendId,
  guard: BackendGuard,
  config: { minIntervalMs: number; dailyCap: number },
  now: number,
  view: GuardView,
): DrawBackendStatus {
  const base = {
    id,
    sendsLast24h: sendsLast24h(guard, now),
    dailyCap: config.dailyCap,
    verified: view.verified,
  };
  if (guard.challengeAt > 0) {
    return {
      ...base,
      state: 'challenge',
      message: 'ChatGPT asked for human verification; solve it yourself in the dedicated browser',
      steps: CHATGPT_LOGIN_STEPS,
    };
  }
  const decision = gate({ ...guard, loginRequiredAt: 0 }, config, now, 1);
  if (decision.kind === 'blocked' && decision.code === 'quota_exhausted') {
    return {
      ...base,
      state: 'quota_exhausted',
      message: decision.message,
      steps: [],
      ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
    };
  }
  const loggedOut =
    guard.loginRequiredAt > 0 || (view.neverVerifiedIsLogin && guard.lastOkAt === 0);
  if (loggedOut) {
    return { ...base, state: 'login_required', message: view.loginMessage, steps: view.loginSteps };
  }
  return { ...base, state: 'ready', message: 'ready', steps: [] };
}

export async function getBackendStatuses(
  runtime: DrawRuntime,
  options: StatusOptions = { probe: false },
): Promise<DrawBackendStatus[]> {
  const [drawCli, omp, chatgpt] = await Promise.all([
    drawCliStatus(runtime, options),
    ompStatus(runtime, options),
    chatgptStatus(runtime, options),
  ]);
  return [
    drawCli,
    omp,
    chatgpt,
    {
      id: 'manual',
      state: 'manual',
      message: 'you generate the image yourself and upload it',
      steps: [],
      verified: true,
      sendsLast24h: 0,
      dailyCap: 0, // 0 = no cap
    },
  ];
}
