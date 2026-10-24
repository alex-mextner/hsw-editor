#!/usr/bin/env bun
/**
 * `hsw-editor draw <verb>` implementation (the Python CLI execs this file):
 *   status [--probe] [--json]   backend availability, quota state, one-time steps
 *   doctor                      status with live probes; exit 1 when no automatic backend is usable
 *   login chatgpt               one-time interactive login in the dedicated profile
 *   stop                        stop the dedicated automation browser
 *   settings [auto|draw-cli|omp|chatgpt-browser|manual]
 *   run [--backend <id>]        JSON DrawRequest on stdin -> one JSON DrawResult on stdout
 * `run` exit codes follow DRAW_ERROR_EXIT_CODES (0 ok).
 */
import {
  DRAW_ERROR_EXIT_CODES,
  type DrawBackendId,
  DrawError,
  parseBackendId,
  parseDrawRequest,
  parseDrawSettings,
  toFailure,
} from '@hsw-editor/draw';
import { probeChatgptLogin } from './backends/chatgpt-browser.ts';
import { loginBrowser, stopBrowser } from './browser-process.ts';
import { acquireOwnerLock } from './owner-lock.ts';
import { createDrawRuntime } from './runtime.ts';
import { getBackendStatuses } from './status.ts';

const [verb, ...rest] = process.argv.slice(2);
const has = (flag: string) => rest.includes(flag);
const option = (flag: string) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};

function usage(): never {
  console.error(
    'usage: hsw-editor draw status|doctor|login chatgpt|stop|settings [choice]|run [--backend id]',
  );
  process.exit(64);
}

async function printStatus(probe: boolean, asJson: boolean): Promise<number> {
  const runtime = createDrawRuntime();
  const statuses = await getBackendStatuses(runtime, { probe });
  if (asJson) {
    console.log(
      JSON.stringify({ settings: await runtime.getSettings(), backends: statuses }, null, 2),
    );
  } else {
    console.log(`selected backend: ${(await runtime.getSettings()).backend}`);
    for (const s of statuses) {
      const retry =
        s.retryAfterMs === undefined ? '' : ` (retry in ${Math.ceil(s.retryAfterMs / 60_000)} min)`;
      console.log(
        `${s.state === 'ready' || s.state === 'manual' ? 'ok  ' : 'TODO'} ${s.id}: ${s.state}${retry} - ${s.message}${s.verified ? '' : ' [not verified live]'}`,
      );
      for (const step of s.steps) console.log(`       -> ${step}`);
    }
  }
  const automatic = statuses.filter((s) => s.id !== 'manual');
  return automatic.some((s) => s.state === 'ready') ? 0 : 1;
}

async function run(): Promise<number> {
  const runtime = createDrawRuntime();
  const forced = option('--backend');
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  process.on('SIGTERM', () => ac.abort());
  let tag: string | undefined;
  let backend: DrawBackendId = 'manual';
  try {
    const forcedId = forced === undefined || forced === 'auto' ? undefined : parseBackendId(forced);
    if (forcedId) backend = forcedId;
    const req = parseDrawRequest(JSON.parse(await Bun.stdin.text()));
    tag = req.tag;
    const result = await runtime.run(req, ac.signal, forcedId);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : DRAW_ERROR_EXIT_CODES[result.error.code];
  } catch (error) {
    const failure =
      error instanceof DrawError
        ? error
        : new DrawError(
            'backend_unavailable',
            error instanceof Error ? error.message : String(error),
            {
              retryable: false,
            },
          );
    console.log(JSON.stringify(toFailure(backend, tag, failure)));
    return DRAW_ERROR_EXIT_CODES[failure.code];
  }
}

async function login(target: string | undefined): Promise<number> {
  if (target !== 'chatgpt') usage();
  const runtime = createDrawRuntime();
  const display = process.env['HSW_LOGIN_DISPLAY'] ?? process.env['DISPLAY'] ?? ':0';
  console.log(
    `Chrome opens on ${display} with the DEDICATED profile ${runtime.paths.chatgptProfileDir}.`,
  );
  console.log('Log in to chatgpt.com (solve any challenge yourself), then close the window.');
  const lock = await acquireOwnerLock(runtime.chatgpt.ownerLockFile, 'dedicated ChatGPT browser');
  try {
    await loginBrowser(runtime.chatgpt.browser, display);
  } finally {
    await lock.release();
  }
  console.log('Window closed; checking the login...');
  const result = await probeChatgptLogin(runtime.chatgpt);
  if (result.loggedIn) {
    await runtime.store.update('chatgpt-browser', (g) => ({
      ...g,
      loginRequiredAt: 0,
      challengeAt: 0,
      lastOkAt: Date.now(),
    }));
    console.log('chatgpt-browser: logged in.');
    return 0;
  }
  console.log(
    `chatgpt-browser: still not usable (${result.error?.code ?? 'unknown'}): ${result.error?.message ?? ''}`,
  );
  return 1;
}

async function dispatch(): Promise<number> {
  switch (verb) {
    case 'status':
      return printStatus(has('--probe'), has('--json'));
    case 'doctor':
      return printStatus(true, false);
    case 'login':
      return login(rest[0]);
    case 'stop': {
      const runtime = createDrawRuntime();
      await stopBrowser(runtime.chatgpt.browser);
      console.log('dedicated browser stopped');
      return 0;
    }
    case 'settings': {
      const runtime = createDrawRuntime();
      if (rest[0] !== undefined) await runtime.setSettings(parseDrawSettings({ backend: rest[0] }));
      console.log(JSON.stringify(await runtime.getSettings()));
      return 0;
    }
    case 'run':
      return run();
    default:
      return usage();
  }
}

process.exit(await dispatch());
