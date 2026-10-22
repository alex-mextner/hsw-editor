/**
 * Lifecycle of the DEDICATED ChatGPT browser (own profile dir, own loopback CDP port, own private
 * Xvfb). Plain ordinary Chrome: no --enable-automation, no stealth flags, nothing exported from
 * the profile. It must never be, or attach to, a chatgpt-guardian browser.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DrawError } from '@hsw-editor/draw';
import { cdpReachable } from './cdp.ts';
import { envInt } from './env.ts';
import { sleep } from './timing.ts';

export interface BrowserOptions {
  readonly profileDir: string;
  readonly cdpPort: number;
  /** Where pids are recorded, so `stop` kills only processes we started. */
  readonly pidFile: string;
  /** Private Xvfb display for automation runs, e.g. ':131'. */
  readonly xDisplay: string;
  /** Run without any display server (offline fixture tests, no Xvfb installed). */
  readonly headless: boolean;
  readonly startUrl: string;
}

export const DEFAULT_CDP_PORT = 9231;
export const DEFAULT_XDISPLAY = ':131';
export const CHATGPT_URL = 'https://chatgpt.com/';

export function browserOptions(
  profileDir: string,
  drawDir: string,
  env: NodeJS.ProcessEnv = process.env,
): BrowserOptions {
  return {
    profileDir,
    cdpPort: envInt(env, 'HSW_CHATGPT_CDP_PORT', DEFAULT_CDP_PORT, 1),
    pidFile: join(drawDir, 'browser.json'),
    xDisplay: env['HSW_CHATGPT_XDISPLAY'] ?? DEFAULT_XDISPLAY,
    headless: env['HSW_CHATGPT_HEADLESS'] === '1',
    startUrl: 'about:blank',
  };
}

function which(name: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    const candidate = join(dir, name);
    if (dir !== '' && existsSync(candidate)) return candidate;
  }
  return null;
}

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['HSW_CHATGPT_CHROME'];
  if (explicit) return existsSync(explicit) ? explicit : null;
  const local = join(homedir(), '.local/bin/google-chrome');
  if (existsSync(local)) return local;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = which(name);
    if (found) return found;
  }
  return null;
}

export function findXvfb(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['HSW_XVFB'];
  if (explicit) return existsSync(explicit) ? explicit : null;
  const onPath = which('Xvfb');
  if (onPath) return onPath;
  // Private Xvfb bundled by another local tool's GUI runtime (read-only use of the binary).
  const bundled = join(homedir(), '.local/share/chatgpt-native-ha/gui-runtime/root/usr/bin/Xvfb');
  return existsSync(bundled) ? bundled : null;
}

function assertDedicatedProfile(profileDir: string) {
  if (profileDir.includes('chatgpt-guardian')) {
    throw new DrawError('backend_unavailable', 'refusing to use a chatgpt-guardian profile', {
      retryable: false,
    });
  }
}

function chromeArgs(options: BrowserOptions, headless: boolean, url: string): string[] {
  return [
    `--user-data-dir=${options.profileDir}`,
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${options.cdpPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,1000',
    ...(headless ? ['--headless=new'] : []),
    url,
  ];
}

interface Recorded {
  chrome?: number;
  xvfb?: number;
}

async function readRecorded(file: string): Promise<Recorded> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Recorded;
  } catch {
    return {};
  }
}

async function cmdlineOf(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
  } catch {
    return '';
  }
}

export interface StartedBrowser {
  /** False when a browser already answered on the CDP port (not started by this call). */
  readonly started: boolean;
}

/** Start the automation browser (idempotent). Chrome's own profile singleton lock is the first
 * owner guard; our owner lock (see owner-lock.ts) serialises drivers on top of it. */
export async function startBrowser(options: BrowserOptions): Promise<StartedBrowser> {
  assertDedicatedProfile(options.profileDir);
  if (await cdpReachable(options.cdpPort)) return { started: false };
  const chrome = findChrome();
  if (!chrome) {
    throw new DrawError('backend_unavailable', 'Chrome not found (set HSW_CHATGPT_CHROME)', {
      retryable: false,
    });
  }
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(options.pidFile), { recursive: true });
  const recorded: Recorded = {};
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (!options.headless) {
    const xvfb = findXvfb();
    if (!xvfb) {
      throw new DrawError(
        'backend_unavailable',
        'Xvfb not found; install it or set HSW_XVFB (or HSW_CHATGPT_HEADLESS=1)',
        { retryable: false },
      );
    }
    const x = Bun.spawn(
      [xvfb, options.xDisplay, '-screen', '0', '1280x1000x24', '-nolisten', 'tcp', '-ac'],
      {
        stdout: 'ignore',
        stderr: 'ignore',
      },
    );
    x.unref();
    recorded.xvfb = x.pid;
    env['DISPLAY'] = options.xDisplay;
    delete env['WAYLAND_DISPLAY'];
    await sleep(1000);
  }
  const proc = Bun.spawn([chrome, ...chromeArgs(options, options.headless, options.startUrl)], {
    env,
    stdout: 'ignore',
    stderr: 'ignore',
  });
  proc.unref();
  recorded.chrome = proc.pid;
  await writeFile(options.pidFile, JSON.stringify(recorded), { mode: 0o600 });
  for (let i = 0; i < 40; i++) {
    if (await cdpReachable(options.cdpPort)) return { started: true };
    await sleep(500);
  }
  await stopBrowser(options);
  throw new DrawError(
    'backend_unavailable',
    `browser did not open CDP on 127.0.0.1:${options.cdpPort}`,
    {
      retryable: true,
    },
  );
}

/** Kill only the pids we recorded, and only if they still look like ours. */
export async function stopBrowser(options: BrowserOptions): Promise<void> {
  const recorded = await readRecorded(options.pidFile);
  if (recorded.chrome && (await cmdlineOf(recorded.chrome)).includes(options.profileDir)) {
    process.kill(recorded.chrome, 'SIGTERM');
  }
  if (recorded.xvfb && (await cmdlineOf(recorded.xvfb)).includes(options.xDisplay)) {
    process.kill(recorded.xvfb, 'SIGTERM');
  }
  await rm(options.pidFile, { force: true });
}

/** One-time interactive login: headed Chrome on the user's display, blocks until they close it. */
export async function loginBrowser(options: BrowserOptions, display: string): Promise<number> {
  assertDedicatedProfile(options.profileDir);
  if (await cdpReachable(options.cdpPort)) {
    throw new DrawError(
      'backend_unavailable',
      'the dedicated browser is running; run `hsw-editor draw stop` first',
      { retryable: false },
    );
  }
  const chrome = findChrome();
  if (!chrome) {
    throw new DrawError('backend_unavailable', 'Chrome not found (set HSW_CHATGPT_CHROME)', {
      retryable: false,
    });
  }
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DISPLAY: display,
  };
  delete env['WAYLAND_DISPLAY'];
  const proc = Bun.spawn([chrome, ...chromeArgs(options, false, CHATGPT_URL)], {
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exited;
}
