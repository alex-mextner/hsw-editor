import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, readdir } from 'node:fs/promises';
import { type DrawBackend, DrawError, type DrawRequest } from '@hsw-editor/draw';
import { GuardStore } from '../guard.ts';
import { createDrawRuntime } from '../runtime.ts';
import { getBackendStatuses } from '../status.ts';
import { type Scratch, scratchDir, writeObjectPng } from '../test-helpers.ts';
import {
  DrawCliBackend,
  type DrawCliConfig,
  classifyDrawCliText,
  probeDrawCli,
} from './draw-cli.ts';

let scratch: Scratch;
beforeEach(async () => {
  scratch = await scratchDir();
});
afterEach(() => scratch.cleanup());

type Mode = 'ok' | 'login' | 'quota' | 'timeout' | 'no-codex' | 'garbage';

/** A stand-in `draw`: records its argv and stdin, answers per `mode`, never touches the network. */
async function fakeDraw(mode: Mode): Promise<string> {
  const image = `${scratch.dir}/generated.png`;
  await writeObjectPng(image);
  const script = `${scratch.dir}/draw`;
  await Bun.write(
    script,
    `#!/usr/bin/env bun
import { appendFileSync, copyFileSync, writeFileSync } from 'node:fs';
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(`${scratch.dir}/argv.jsonl`)}, JSON.stringify(args) + '\\n');
const fail = (text, code = 1) => { console.error('draw: ' + text); process.exit(code); };
if (mode === 'login') fail('ChatGPT login required (API-key login is not accepted). Run \`codex login\`.');
if (mode === 'no-codex') fail('Codex CLI not found. Install/update it with \`npm install -g @openai/codex@latest\`.');
if (args.includes('--check')) { console.log('draw: codex-cli 0.163.0 (/x/codex)'); process.exit(0); }
const prompt = await Bun.stdin.text();
writeFileSync(${JSON.stringify(`${scratch.dir}/prompt.txt`)}, prompt);
const out = args[args.indexOf('-o') + 1];
if (mode === 'quota') fail("Codex generation failed: You've hit the usage limit for image generation. Try again in 2 hours 30 minutes.");
if (mode === 'timeout') fail('Codex timed out after 5s; stopped locally, not retried.');
if (mode === 'garbage') writeFileSync(out, 'not an image'); else copyFileSync(${JSON.stringify(image)}, out);
console.log('draw: saved ' + out);
`,
  );
  await chmod(script, 0o755);
  return script;
}

const config = (bin: string): DrawCliConfig => ({ bin, guard: { minIntervalMs: 0, dailyCap: 10 } });

const request = async (): Promise<DrawRequest> => {
  const subject = `${scratch.dir}/photo.png`;
  const mask = `${scratch.dir}/mask.png`;
  await writeObjectPng(subject);
  await writeObjectPng(mask);
  return {
    version: 1,
    prompt: 'Edit image 1 inside the white area of image 2',
    refs: [
      { path: subject, role: 'subject' },
      { path: mask, role: 'view' },
    ],
    n: 1,
    size: '1024x1024',
    outDir: `${scratch.dir}/out`,
    tag: 'clean-1',
    timeoutMs: 60_000,
  };
};

const argv = async (): Promise<string[][]> =>
  (await Bun.file(`${scratch.dir}/argv.jsonl`).text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as string[]);

const run = async (mode: Mode, store = new GuardStore(`${scratch.dir}/guard.json`)) =>
  new DrawCliBackend(store, config(await fakeDraw(mode)))
    .draw(await request(), new AbortController().signal)
    .catch((error: unknown) => error);

test('success: draw --backend chatgpt gets the refs in order and the prompt on stdin, the image is saved and the send recorded', async () => {
  const store = new GuardStore(`${scratch.dir}/guard.json`);
  const result = await run('ok', store);
  expect(result).toMatchObject({ ok: true, backend: 'draw-cli', tag: 'clean-1' });
  const [call] = await argv();
  expect(call?.slice(0, 6)).toEqual([
    '--backend',
    'chatgpt',
    '-i',
    `${scratch.dir}/photo.png`,
    '-i',
    `${scratch.dir}/mask.png`,
  ]);
  expect(call).toContain('--timeout');
  expect(await Bun.file(`${scratch.dir}/prompt.txt`).text()).toContain('inside the white area');
  expect(result).toMatchObject({ images: [{ mime: 'image/png', width: 512 }] });
  // only the validated copy stays in outDir: no `.draw-cli-*` scratch file
  expect((await readdir(`${scratch.dir}/out`)).filter((f) => f.startsWith('.draw-cli'))).toEqual(
    [],
  );
  expect((await store.get('draw-cli')).sends).toHaveLength(1);
});

test('draw-cli words map onto the contract failure classes', async () => {
  const login = await run('login');
  expect(login).toBeInstanceOf(DrawError);
  expect((login as DrawError).code).toBe('login_required');

  const quota = (await run('quota')) as DrawError;
  expect(quota.code).toBe('quota_exhausted');
  expect(quota.extra.retryAfterMs).toBe(9_000_000);

  expect(((await run('timeout')) as DrawError).code).toBe('timeout');
  expect(((await run('no-codex')) as DrawError).code).toBe('backend_unavailable');
  // draw exits 0 but the file is not an image: refused, never passed on
  expect(((await run('garbage')) as DrawError).code).toBe('refused');
});

test('a missing draw binary is backend_unavailable with the install hint context', async () => {
  const failure = await new DrawCliBackend(
    new GuardStore(`${scratch.dir}/guard.json`),
    config('/nonexistent/draw'),
  )
    .draw(await request(), new AbortController().signal)
    .catch((error: unknown) => error);
  expect((failure as DrawError).code).toBe('backend_unavailable');
});

test('classification keeps policy refusals apart from quota wording', () => {
  expect(
    classifyDrawCliText('draw: Codex generation failed: I cannot create that image.').code,
  ).toBe('refused');
  expect(classifyDrawCliText('draw: Codex generation failed: HTTP 429').code).toBe(
    'quota_exhausted',
  );
});

test('probe: --check decides ready / login_required / unavailable, nothing is generated', async () => {
  expect(await probeDrawCli(await fakeDraw('ok'))).toMatchObject({ state: 'ready' });
  const login = await probeDrawCli(await fakeDraw('login'));
  expect(login).toMatchObject({ state: 'login_required' });
  expect(login.state === 'login_required' && login.steps.join(' ')).toContain('codex login');
  const noCodex = await probeDrawCli(await fakeDraw('no-codex'));
  expect(noCodex.state).toBe('unavailable');
  expect(await probeDrawCli('/nonexistent/draw')).toMatchObject({ state: 'unavailable' });
  expect((await argv()).every((call) => call.includes('--check'))).toBe(true);
});

test('status shows draw-cli ready from its own check, and login_required with the codex step; no login of the editor is involved', async () => {
  const make = async (mode: Mode) =>
    createDrawRuntime({
      env: {
        HSW_EDITOR_DATA_DIR: `${scratch.dir}/data-${mode}`,
        HSW_DRAW_CLI_BIN: await fakeDraw(mode),
        HSW_OMP_BIN: '/nonexistent/omp',
        HSW_CHATGPT_HEADLESS: '1',
      },
    });
  const ready = (await getBackendStatuses(await make('ok'), { probe: true })).find(
    (s) => s.id === 'draw-cli',
  );
  expect(ready).toMatchObject({ state: 'ready', verified: true });
  const out = (await getBackendStatuses(await make('login'), { probe: true })).find(
    (s) => s.id === 'draw-cli',
  );
  expect(out).toMatchObject({ state: 'login_required' });
  expect(out?.steps.join(' ')).toContain('codex login');
});

test('auto: draw-cli answers first, and a signed-out draw-cli hands over to the next backend', async () => {
  const sibling: DrawBackend & { calls: number } = {
    id: 'omp',
    calls: 0,
    async draw() {
      this.calls++;
      return { ok: true, backend: 'omp', images: [], meta: { elapsedMs: 1 } };
    },
  };
  const make = async (mode: Mode) =>
    createDrawRuntime({
      env: {
        HSW_EDITOR_DATA_DIR: `${scratch.dir}/data-${mode}`,
        HSW_DRAW_CLI_BIN: await fakeDraw(mode),
      },
      backends: { omp: sibling },
    });
  const first = await (await make('ok')).run(await request(), new AbortController().signal);
  expect(first).toMatchObject({ ok: true, backend: 'draw-cli' });
  expect(sibling.calls).toBe(0);
  const second = await (await make('login')).run(await request(), new AbortController().signal);
  expect(second).toMatchObject({ ok: true, backend: 'omp' });
  expect(sibling.calls).toBe(1);
});

test('two draws into the same outDir with the same tag keep their own scratch and their own result file', async () => {
  const backend = new DrawCliBackend(
    new GuardStore(`${scratch.dir}/guard.json`),
    config(await fakeDraw('ok')),
  );
  const req = await request();
  const [first, second] = await Promise.all([
    backend.draw(req, new AbortController().signal),
    backend.draw(req, new AbortController().signal),
  ]);
  expect(first.ok && second.ok).toBe(true);
  const paths = [first, second].flatMap((r) => (r.ok ? r.images.map((i) => i.path) : []));
  expect(new Set(paths).size).toBe(2);
  expect(await readdir(`${scratch.dir}/out`)).toHaveLength(2);
});
