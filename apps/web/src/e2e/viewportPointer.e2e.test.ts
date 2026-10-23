/**
 * Real-browser check of the viewport's pointer contract, driven through CDP input events (real
 * mouse/touch/wheel events, not synthetic DOM ones):
 *   - left drag on the background orbits the camera; the right button never does (it opens the menu)
 *   - left drag on an item moves the item and never the camera, and orbit works again afterwards
 *   - right click opens the item / board menu, Escape closes it
 *   - a plain mouse wheel scrolls the history strip, a horizontal swipe still works, Ctrl+wheel does not
 *   - one finger orbits
 * "The camera moved" is read off the pixels of the canvas, so no test hook is needed in the app.
 *
 * Needs a running editor with at least one wall that has holders and a long history:
 *   HSW_E2E_URL=http://127.0.0.1:8944 [HSW_E2E_CHROME=/path/to/chrome] bun test apps/web/src/e2e
 * The item-drag test edits the wall and undoes the edit. Skipped when HSW_E2E_URL or Chrome is missing.
 *
 * Real timers: this drives a real GPU-less Chrome, so waiting is on real rendering. Every wait polls
 * a concrete condition (`until`), or lets two animation frames pass in the page (`frames`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const baseUrl = process.env['HSW_E2E_URL'];
const chromePath =
  process.env['HSW_E2E_CHROME'] ??
  ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']
    .map((name) => Bun.which(name))
    .find((found) => found !== null) ??
  null;

const VIEWPORT = { width: 1400, height: 900 };

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/** Minimal CDP client: one browser socket, one attached page session. */
class Cdp {
  private counter = 0;
  private readonly pending = new Map<number, Pending>();
  private sessionId: string | null = null;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (typeof message !== 'object' || message === null || !('id' in message)) return;
      if (typeof message.id !== 'number') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if ('error' in message) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve('result' in message ? message.result : undefined);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot reach ${url}`)), {
      once: true,
    });
    await promise;
    return new Cdp(socket);
  }

  send(method: string, params: object = {}): Promise<unknown> {
    this.counter += 1;
    const id = this.counter;
    const payload = {
      id,
      method,
      params,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
    };
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.pending.set(id, { resolve, reject });
    this.socket.send(JSON.stringify(payload));
    return promise;
  }

  async openPage(): Promise<void> {
    const target = (await this.send('Target.createTarget', { url: 'about:blank' })) as {
      targetId: string;
    };
    const attached = (await this.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessionId = attached.sessionId;
    await this.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  close(): void {
    this.socket.close();
  }
}

type Button = 'left' | 'right' | 'middle';
const BUTTON_MASK: Record<Button, number> = { left: 1, right: 2, middle: 4 };
const SHIFT = 8;
const CTRL = 2;

let browser: Subprocess<'ignore', 'ignore', 'pipe'> | null = null;
let profileDir = '';
let cdp: Cdp;
let wallId = '';

async function evaluate<T>(expression: string): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result: { value: T }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error(`evaluate failed: ${expression}`);
  return result.result.value;
}

/** Lets the page process pending input and render: three animation frames. */
const frames = (): Promise<unknown> =>
  evaluate(
    `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done))))`,
  );

/** Polls `condition` until it holds or `attempts` polls passed; the poll interval is the only fixed delay. */
async function eventually(condition: () => Promise<boolean>, attempts = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function until(description: string, condition: () => Promise<boolean>): Promise<void> {
  if (!(await eventually(condition))) throw new Error(`timed out waiting for ${description}`);
}

async function mouse(
  type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
  x: number,
  y: number,
  button: Button | 'none' = 'none',
  modifiers = 0,
): Promise<void> {
  const held = type === 'mouseReleased' || button === 'none' ? 0 : BUTTON_MASK[button];
  await cdp.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    buttons: held,
    modifiers,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    pointerType: 'mouse',
  });
}

async function drag(
  button: Button,
  from: readonly [number, number],
  to: readonly [number, number],
  modifiers = 0,
): Promise<void> {
  const steps = 8;
  await mouse('mouseMoved', from[0], from[1], 'none', modifiers);
  await mouse('mousePressed', from[0], from[1], button, modifiers);
  for (let step = 1; step <= steps; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from[0] + ((to[0] - from[0]) * step) / steps,
      y: from[1] + ((to[1] - from[1]) * step) / steps,
      button,
      buttons: BUTTON_MASK[button],
      modifiers,
      pointerType: 'mouse',
    });
  }
  await mouse('mouseReleased', to[0], to[1], button, modifiers);
  await frames();
}

async function click(x: number, y: number, button: Button = 'left'): Promise<void> {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, button);
  await mouse('mouseReleased', x, y, button);
  await frames();
}

async function pressKey(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
  const common = { key, code, modifiers, windowsVirtualKeyCode: keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  await frames();
}

/** PNG of the canvas only: equal pixels before/after means the camera did not move. */
async function canvasPixels(): Promise<string> {
  const rect = await evaluate<{ x: number; y: number; width: number; height: number }>(
    `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
  );
  const shot = (await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...rect, scale: 1 },
  })) as { data: string };
  return shot.data;
}

/** Waits until two consecutive canvas captures agree (models loaded, nothing animating). */
async function settled(): Promise<string> {
  let previous = await canvasPixels();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await Bun.sleep(300);
    const next = await canvasPixels();
    if (next === previous) return next;
    previous = next;
  }
  throw new Error('the canvas never settled');
}

async function openEditor(): Promise<void> {
  await cdp.send('Page.navigate', { url: `${baseUrl}/` });
  await until('the app shell', () => evaluate<boolean>(`document.getElementById('root') !== null`));
  await evaluate(
    `(() => { localStorage.setItem('hsw-editor.currentWallId', ${JSON.stringify(wallId)}); localStorage.setItem('hsw-editor.layout', JSON.stringify({ leftOpen: true, rightOpen: true, bottomOpen: true, ompOpen: false })); return true; })()`,
  );
  await cdp.send('Page.navigate', { url: `${baseUrl}/` });
  await until('the 3D canvas', () =>
    evaluate<boolean>(`document.querySelector('canvas') !== null`),
  );
  await settled();
}

const menuLabels = (): Promise<string[]> =>
  evaluate<string[]>(
    `[...document.querySelectorAll('[role=menuitem]')].map((item) => item.textContent ?? '')`,
  );

const itemSelected = (): Promise<boolean> =>
  evaluate<boolean>(`document.querySelector('[data-slot="item-widgets"]') !== null`);

async function wallRev(): Promise<number> {
  const list = (await (await fetch(`${baseUrl}/api/walls`)).json()) as {
    walls: { id: string; rev: number }[];
  };
  return list.walls.find((wall) => wall.id === wallId)?.rev ?? -1;
}

/** Left-clicks a grid over the board until an item gets selected (the inspector then shows its widgets). */
async function findItemPoint(): Promise<[number, number]> {
  for (let y = 300; y <= 700; y += 24) {
    for (let x = 400; x <= 1000; x += 24) {
      await click(x, y);
      if (await itemSelected()) return [x, y];
    }
  }
  throw new Error('no item found under the pointer: open a wall with holders on it');
}

describe.skipIf(!baseUrl || !chromePath)('viewport pointer contract (real Chrome)', () => {
  beforeAll(async () => {
    const list = (await (await fetch(`${baseUrl}/api/walls`)).json()) as {
      walls: { id: string; items: number }[];
    };
    const wall = list.walls.find((candidate) => candidate.items >= 3);
    if (!wall) throw new Error('HSW_E2E_URL needs a wall with at least 3 items');
    wallId = wall.id;
    profileDir = await mkdtemp(join(tmpdir(), 'hsw-e2e-'));
    browser = Bun.spawn(
      [
        chromePath ?? 'chrome',
        '--headless=new',
        '--no-sandbox',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        'about:blank',
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    );
    const reader = browser.stderr.getReader();
    const decoder = new TextDecoder();
    let log = '';
    let endpoint: string | null = null;
    while (endpoint === null) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Chrome exited before opening a debug port:\n${log}`);
      log += decoder.decode(chunk.value);
      endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(log)?.[1] ?? null;
    }
    cdp = await Cdp.connect(endpoint);
    await cdp.openPage();
  }, 60_000);

  afterAll(async () => {
    cdp?.close();
    browser?.kill();
    await browser?.exited;
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  });

  test('left drag on the background orbits the camera', async () => {
    await openEditor();
    const before = await settled();
    await drag('left', [520, 200], [620, 250]);
    expect(await canvasPixels()).not.toBe(before);
  }, 60_000);

  test('Shift + left drag moves the view too (pan)', async () => {
    await openEditor();
    const before = await settled();
    await drag('left', [520, 200], [620, 250], SHIFT);
    expect(await canvasPixels()).not.toBe(before);
  }, 60_000);

  test('the right button does not orbit; it opens the board menu, Escape closes it', async () => {
    await openEditor();
    const before = await settled();
    await drag('right', [520, 200], [620, 250]);
    await until('the board menu', async () => (await menuLabels()).length > 0);
    expect((await menuLabels()).some((label) => label.startsWith('Select all'))).toBe(true);
    await pressKey('Escape', 'Escape', 27);
    await until('the menu to close', async () => (await menuLabels()).length === 0);
    // Compared once the menu is gone: its popup is drawn over the canvas.
    expect(await settled()).toBe(before);
  }, 60_000);

  test('right click on an item opens the item menu and selects the item', async () => {
    await openEditor();
    const [x, y] = await findItemPoint();
    await click(520, 200);
    expect(await itemSelected()).toBe(false);
    await click(x, y, 'right');
    await until('the item menu', async () =>
      (await menuLabels()).some((label) => label.startsWith('Duplicate')),
    );
    expect(await itemSelected()).toBe(true);
    await pressKey('Escape', 'Escape', 27);
  }, 120_000);

  test('dragging an item moves the item, never the camera, and orbit works afterwards', async () => {
    await openEditor();
    const [x, y] = await findItemPoint();
    await openEditor();
    const pristine = await settled();
    const revBefore = await wallRev();
    // The drop spot must be a valid placement; try a few directions until the wall accepts one.
    let saved = false;
    for (const [dx, dy] of [
      [-70, -90],
      [90, -90],
      [-110, 70],
      [110, 70],
      [0, -140],
    ] as const) {
      await drag('left', [x, y], [x + dx, y + dy]);
      saved = await eventually(async () => (await wallRev()) === revBefore + 1, 15);
      if (saved) break;
    }
    expect(saved).toBe(true);
    // Undo puts the item back; the picture only matches the original if the camera stayed put.
    await pressKey('z', 'KeyZ', 90, CTRL);
    await until('the undo to be saved', async () => (await wallRev()) === revBefore + 2);
    // The dragged item stays selected (highlighted); clear that so only the camera can differ.
    await pressKey('Escape', 'Escape', 27);
    expect(await settled()).toBe(pristine);
    await drag('left', [520, 200], [620, 250]);
    expect(await canvasPixels()).not.toBe(pristine);
  }, 180_000);

  test('one finger orbits, like the left mouse button', async () => {
    await openEditor();
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const before = await settled();
    const touch = (type: string, point?: readonly [number, number]) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: point ? [{ x: point[0], y: point[1], id: 0 }] : [],
      });
    await touch('touchStart', [520, 200]);
    for (let step = 1; step <= 8; step += 1)
      await touch('touchMove', [520 + step * 12, 200 + step * 6]);
    await touch('touchEnd');
    await frames();
    expect(await canvasPixels()).not.toBe(before);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  }, 60_000);

  test('a plain mouse wheel scrolls the history strip; swipes and Ctrl+wheel behave', async () => {
    await openEditor();
    const strip = `document.querySelector('[data-slot="timeline"] ol')`;
    const box = await evaluate<{ x: number; y: number; overflow: boolean }>(
      `(() => { const s = ${strip}; const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, overflow: s.scrollWidth > s.clientWidth + 400 }; })()`,
    );
    expect(box.overflow).toBe(true);
    const wheel = (deltaX: number, deltaY: number, modifiers = 0) =>
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: box.x,
        y: box.y,
        deltaX,
        deltaY,
        modifiers,
      });
    const scrollLeft = (): Promise<number> => evaluate<number>(`${strip}.scrollLeft`);
    await mouse('mouseMoved', box.x, box.y);
    const start = await scrollLeft();
    await wheel(0, -200);
    await until('the wheel to scroll the strip', async () => (await scrollLeft()) < start);
    const afterWheel = await scrollLeft();
    await wheel(-120, 0);
    await until('the swipe to scroll the strip', async () => (await scrollLeft()) < afterWheel);
    const afterSwipe = await scrollLeft();
    await wheel(0, 200, CTRL);
    await frames();
    expect(await scrollLeft()).toBe(afterSwipe);
  }, 60_000);
});
