/**
 * chatgpt-browser backend: drives the DEDICATED hsw-editor Chrome profile over loopback CDP.
 * Rules: one owner per profile (owner lock), own tab only, human pacing (persisted guard),
 * no stealth, stop at login wall / captcha, never export cookies, never attach to a guardian browser.
 *
 * Selector provenance:
 *   VERIFIED  (agent-tools live_dom.js/dom.js, exercised against the real logged-in UI there):
 *     composer, send, stop, turn key, turn state, profile menu, login link, [role=alert], attachment marker.
 *   OBSERVED  (logged-out chatgpt.com, 2026-10-22): input[type=file] image inputs, "Log in" button.
 *   UNVERIFIED (needs the first logged-in calibration run): which file input receives uploads,
 *     the generated <img> shape, image-quota alert wording.
 */
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
import { Cdp, type Page } from '../cdp.ts';
import { type BrowserOptions, startBrowser, stopBrowser } from '../browser-process.ts';
import { type GuardConfig, type GuardStore } from '../guard.ts';
import { safeStem, saveImage } from '../image.ts';
import { acquireOwnerLock } from '../owner-lock.ts';
import { paceSend } from '../pacing.ts';
import { abortableSleep, jitter, sleep } from '../timing.ts';

export const SEL = {
  composer:
    '[contenteditable="true"][data-composer-markdown][role="textbox"][aria-label="Ask ChatGPT"]',
  send: 'button[aria-label="Send"]',
  stop: 'button[aria-label="Stop"]',
  turn: '[data-turn-key]',
  turnState: '[data-talvt-turn-state]',
  profileMenu: 'button[aria-label="Open profile menu"]',
  loginLink: 'a[href="/auth/login"]',
  alert: '[role="alert"]',
  attachment: '[data-testid="attachment"], [data-testid="attachment-preview"]',
  fileInput: 'input[type="file"]',
  captcha: 'iframe[src*="captcha"], iframe[src*="challenges.cloudflare"]',
} as const;

export const CHATGPT_LOGIN_STEPS = [
  'hsw-editor draw login chatgpt   # opens the dedicated browser on your desktop; log in once, then close the window',
] as const;

export interface ChatgptBrowserConfig {
  readonly browser: BrowserOptions;
  /** Page opened for each prompt; only the offline fixture overrides the default. */
  readonly baseUrl: string;
  readonly guard: GuardConfig;
  readonly ownerLockFile: string;
  /** Stop the browser after a request if this call started it. */
  readonly stopWhenDone: boolean;
}

/** Parse "in 3 hours 20 minutes" / "in 45 minutes" reset hints; undefined when absent. */
export function parseRetryAfterMs(text: string): number | undefined {
  const m =
    /\b(?:in|after)\s+(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:and\s*)?(?:(\d+)\s*(?:minutes?|mins?|m)\b)?/i.exec(
      text,
    );
  if (!m || (!m[1] && !m[2])) return undefined;
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
}

/** Image/usage limit wording. Deliberately NOT a bare /limit/: "limited by policy" is a refusal, not a quota. */
export const QUOTA_PATTERN =
  /(?:\b(?:hit|reached|exceeded) (?:the |your )?(?:[\w-]+ ){0,3}(?:limit|cap)\b|\b(?:usage|rate|image|daily) (?:generation )?limit\b|\blimit (?:resets?|will reset)\b|too many requests|\bquota\b|try again (?:later|in)|come back (?:later|in))/i;

export interface PageProbe {
  readonly loggedIn: boolean;
  readonly loginWall: boolean;
  readonly challenge: boolean;
  readonly composer: boolean;
  readonly title: string;
}

const probeJs = `(() => {
  const vis = e => !!e && e.isConnected && e.getClientRects().length > 0;
  const q = s => [...document.querySelectorAll(s)].some(vis);
  const loginButton = [...document.querySelectorAll('button,a')].some(b => vis(b) && /^(log in|sign up for free)$/i.test((b.innerText||'').trim()));
  return {
    loggedIn: q(${JSON.stringify(SEL.profileMenu)}),
    loginWall: q(${JSON.stringify(SEL.loginLink)}) || loginButton,
    challenge: q(${JSON.stringify(SEL.captcha)}) || /verify you are human|checking your browser|just a moment/i.test(document.title),
    composer: q(${JSON.stringify(SEL.composer)}),
    title: document.title,
  };
})()`;

interface TurnSnapshot {
  readonly turns: number;
  readonly running: boolean;
  readonly lastState: string;
  readonly quotaText: string;
  readonly lastText: string;
  readonly imgs: ReadonlyArray<{ src: string; w: number; h: number }>;
}

const snapshotJs = `(() => {
  const vis = e => !!e && e.isConnected && e.getClientRects().length > 0;
  const turns = [...document.querySelectorAll(${JSON.stringify(SEL.turn)})];
  const last = turns.at(-1);
  const states = last ? [...last.querySelectorAll(${JSON.stringify(SEL.turnState)})] : [];
  const alerts = [...document.querySelectorAll(${JSON.stringify(SEL.alert)})].filter(e => vis(e) && !e.closest(${JSON.stringify(SEL.turn)}));
  const imgs = last ? [...last.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth >= 256 && i.naturalHeight >= 256)
      .map(i => ({src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight})) : [];
  return {
    turns: turns.length,
    running: [...document.querySelectorAll(${JSON.stringify(SEL.stop)})].some(vis) || states.some(s => s.getAttribute('data-talvt-turn-state') === 'in_progress'),
    lastState: states.length === 1 ? states[0].getAttribute('data-talvt-turn-state') : '',
    quotaText: alerts.map(a => a.textContent || '').join(' | '),
    lastText: last ? (last.innerText || '').slice(0, 600) : '',
    imgs,
  };
})()`;

/** Fetch an <img> with the page's own session; fall back to a canvas read for CORS-clean images. */
const fetchImageJs = (src: string) => `(async () => {
  const toB64 = buf => { let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); };
  try {
    const r = await fetch(${JSON.stringify(src)}, {credentials: 'include', signal: AbortSignal.timeout(20000)});
    if (!r.ok) throw new Error('image fetch http ' + r.status);
    return toB64(new Uint8Array(await r.arrayBuffer()));
  } catch (e) {
    const img = [...document.images].find(i => (i.currentSrc || i.src) === ${JSON.stringify(src)});
    if (!img) throw e;
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  }
})()`;

const imageFileInputIndexJs = `(() => {
  const inputs = [...document.querySelectorAll(${JSON.stringify(SEL.fileInput)})];
  const i = inputs.findIndex(e => /image/i.test(e.getAttribute('accept') || ''));
  return i < 0 ? 0 : i;
})()`;

function quotaError(text: string): DrawError {
  const retryAfterMs = parseRetryAfterMs(text);
  return new DrawError(
    'quota_exhausted',
    text.slice(0, 300),
    retryAfterMs === undefined ? {} : { retryAfterMs },
  );
}

export class ChatgptBrowserBackend implements DrawBackend {
  readonly id: DrawBackendId = 'chatgpt-browser';
  constructor(
    private readonly store: GuardStore,
    private readonly config: ChatgptBrowserConfig,
  ) {}

  async draw(req: DrawRequest, signal: AbortSignal): Promise<DrawResult> {
    const started = Date.now();
    const deadline = started + (req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const lock = await acquireOwnerLock(this.config.ownerLockFile, 'dedicated ChatGPT browser');
    let weStartedBrowser = false;
    let cdp: Cdp | undefined;
    let page: Page | undefined;
    let closeOnAbort: (() => void) | undefined;
    try {
      weStartedBrowser = (await startBrowser(this.config.browser)).started;
      cdp = await Cdp.connect(this.config.browser.cdpPort).catch(() => {
        throw new DrawError(
          'backend_unavailable',
          `no browser on 127.0.0.1:${this.config.browser.cdpPort}`,
          {
            retryable: true,
          },
        );
      });
      const session = cdp;
      closeOnAbort = () => session.close();
      signal.addEventListener('abort', closeOnAbort, { once: true });
      page = await cdp.openPage('about:blank');
      const images: DrawImage[] = [];
      let conversationUrl = '';
      try {
        for (let i = 0; i < req.n; i++) {
          if (signal.aborted) throw new DrawError('timeout', 'aborted', { retryable: false });
          await page.navigate(`${this.config.baseUrl}/`);
          await this.waitReady(page, deadline);
          await paceSend(this.store, this.id, this.config.guard, signal);
          const baseline = await page.eval<TurnSnapshot>(snapshotJs);
          if (req.refs.length > 0) await this.attach(page, req, deadline);
          await abortableSleep(jitter(800, 2200), signal);
          await page.eval<boolean>(
            `(() => { const c = document.querySelector(${JSON.stringify(SEL.composer)}); if (!c) return false; c.focus(); return true; })()`,
          );
          await page.insertText(composePrompt(req));
          await abortableSleep(jitter(700, 1800), signal);
          const sent = await page.eval<boolean>(
            `(() => { const b = document.querySelector(${JSON.stringify(SEL.send)}); if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false; b.click(); return true; })()`,
          );
          if (!sent) {
            throw new DrawError(
              'backend_unavailable',
              'send button missing/disabled after typing (selector drift or upload not finished)',
              { detail: { selector: SEL.send } },
            );
          }
          const snap = await this.waitDone(page, baseline.turns, deadline, signal);
          conversationUrl = await page.eval<string>('location.href');
          const stem = safeStem(req.tag, 'draw');
          for (const [k, img] of snap.imgs.entries()) {
            const b64 = await page.eval<string>(fetchImageJs(img.src));
            const bytes = Buffer.from(b64, 'base64');
            images.push(
              await saveImage(
                req.outDir,
                `${stem}-${Date.now()}-${i + 1}${snap.imgs.length > 1 ? `-${k + 1}` : ''}`,
                bytes,
              ),
            );
          }
        }
      } catch (error) {
        const shot = join(req.outDir, `chatgpt-browser-failure-${Date.now()}.png`);
        const saved = await page.screenshot(shot).then(
          () => true,
          () => false,
        );
        if (error instanceof DrawError) throw error;
        // Selector drift / page-context loss must surface as a classified failure, never a raw crash.
        throw new DrawError(
          'backend_unavailable',
          `browser automation failed: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: false, ...(saved ? { detail: { screenshot: shot } } : {}) },
        );
      }
      return {
        ok: true,
        backend: this.id,
        ...(req.tag === undefined ? {} : { tag: req.tag }),
        images,
        meta: { elapsedMs: Date.now() - started, conversationUrl },
      };
    } finally {
      if (closeOnAbort) signal.removeEventListener('abort', closeOnAbort);
      await page?.close().catch(() => undefined);
      cdp?.close();
      if (weStartedBrowser && this.config.stopWhenDone) await stopBrowser(this.config.browser);
      await lock.release();
    }
  }

  /** Wait for a usable composer; classify login wall / captcha and stop there. */
  private async waitReady(page: Page, deadline: number) {
    for (;;) {
      const probe = await page.eval<PageProbe>(probeJs).catch(() => null);
      if (probe) {
        const classified = classifyProbe(probe);
        if (classified) throw classified;
        if (probe.loggedIn && probe.composer) {
          await sleep(jitter(1200, 2500));
          return;
        }
      }
      if (Date.now() > deadline) {
        throw new DrawError('timeout', 'chatgpt composer did not appear', {
          detail: { selector: SEL.composer },
        });
      }
      await sleep(1000);
    }
  }

  private async attach(page: Page, req: DrawRequest, deadline: number) {
    const index = await page.eval<number>(imageFileInputIndexJs);
    await page.setFiles(
      SEL.fileInput,
      req.refs.map((ref) => ref.path),
      index,
    );
    const t0 = Date.now();
    for (;;) {
      const n = await page.eval<number>(
        `document.querySelectorAll(${JSON.stringify(SEL.attachment)}).length`,
      );
      if (n >= req.refs.length) break;
      if (Date.now() - t0 > 15_000) {
        if (Date.now() > deadline) throw new DrawError('timeout', 'attachments did not render');
        break; // marker unverified for uploads: send() guards on the Send button being enabled
      }
      await sleep(500);
    }
    await sleep(jitter(1500, 3000));
  }

  private async waitDone(
    page: Page,
    baselineTurns: number,
    deadline: number,
    signal: AbortSignal,
  ): Promise<TurnSnapshot> {
    await abortableSleep(jitter(2500, 4000), signal);
    for (;;) {
      if (signal.aborted) throw new DrawError('timeout', 'aborted', { retryable: false });
      const snap = await page.eval<TurnSnapshot>(snapshotJs);
      if (snap.quotaText && QUOTA_PATTERN.test(snap.quotaText)) throw quotaError(snap.quotaText);
      const probe = await page.eval<PageProbe>(probeJs);
      if (probe.challenge) {
        throw new DrawError('challenge', 'human verification appeared mid-run', {
          retryable: false,
        });
      }
      if (snap.turns >= baselineTurns + 2 && !snap.running && snap.lastState === 'complete') {
        if (snap.imgs.length > 0) return snap;
        if (QUOTA_PATTERN.test(snap.lastText)) throw quotaError(snap.lastText);
        throw new DrawError(
          'refused',
          `assistant turn finished without an image: ${snap.lastText.slice(0, 200)}`,
          {
            retryable: false,
          },
        );
      }
      if (Date.now() > deadline)
        throw new DrawError('timeout', 'no generated image before deadline');
      await sleep(2000);
    }
  }
}

export function classifyProbe(probe: PageProbe): DrawError | null {
  if (probe.challenge) {
    return new DrawError(
      'challenge',
      `human verification wall (${probe.title}); complete it in the dedicated browser (hsw-editor draw login chatgpt)`,
      { retryable: false },
    );
  }
  if (probe.loginWall && !probe.loggedIn) {
    return new DrawError(
      'login_required',
      'dedicated ChatGPT profile is logged out; run `hsw-editor draw login chatgpt` once',
      { retryable: false },
    );
  }
  return null;
}

export function composePrompt(req: DrawRequest): string {
  const roles = req.refs
    .map((ref, i) => `Image ${i + 1} is a ${ref.role ?? 'reference'} image.`)
    .join(' ');
  return `${roles ? `${roles} ` : ''}Create an image (generate it, do not just describe it): ${req.prompt} Output size: ${req.size}.`;
}

/** Cheap login probe: own tab, no prompt sent. Returns the classified error or null when logged in. */
export async function probeChatgptLogin(
  config: ChatgptBrowserConfig,
  timeoutMs = 45_000,
): Promise<{ readonly loggedIn: boolean; readonly error: DrawError | null }> {
  const lock = await acquireOwnerLock(config.ownerLockFile, 'dedicated ChatGPT browser');
  let weStartedBrowser = false;
  let cdp: Cdp | undefined;
  let page: Page | undefined;
  try {
    weStartedBrowser = (await startBrowser(config.browser)).started;
    cdp = await Cdp.connect(config.browser.cdpPort);
    page = await cdp.openPage('about:blank');
    await page.navigate(`${config.baseUrl}/`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const probe = await page.eval<PageProbe>(probeJs).catch(() => null);
      if (probe) {
        const classified = classifyProbe(probe);
        if (classified) return { loggedIn: false, error: classified };
        if (probe.loggedIn && probe.composer) return { loggedIn: true, error: null };
      }
      if (Date.now() > deadline) {
        throw new DrawError('timeout', 'chatgpt page did not settle', { retryable: true });
      }
      await sleep(1000);
    }
  } finally {
    await page?.close().catch(() => undefined);
    cdp?.close();
    if (weStartedBrowser && config.stopWhenDone) await stopBrowser(config.browser);
    await lock.release();
  }
}
