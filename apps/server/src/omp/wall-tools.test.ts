import { describe, expect, test } from 'bun:test';
import {
  applyOp,
  createEmptyWall,
  type HistoryEntry,
  type LeafOp,
  type Op,
  type Wall,
  WallItemSchema,
} from '@hsw-editor/core';
import type { HswPromptAnswer, ViewportCall, ViewportResult } from '@hsw-editor/omp-protocol';
import { testConfig } from './testing/harness.ts';
import type { HostTool, PromptDraft } from './tool-types.ts';
import {
  addedIds,
  countRemovals,
  countUndoRedoRemovals,
  createWallToolFactory,
  decideDestructive,
} from './wall-tools.ts';
import type { OmpConfig } from './config.ts';

const addItem = (id: string): LeafOp => ({
  type: 'addItem',
  item: {
    id,
    kind: 'holder',
    bankId: 'holders/screwdriver',
    pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'agent' },
    locked: false,
  },
});
const removeItem = (id: string): LeafOp => ({ type: 'removeItem', id });

const historyEntry = (
  kind: 'op' | 'undo' | 'redo',
  rev: number,
  op: Op,
  inverse: Op,
  ref?: number,
): HistoryEntry => ({
  kind,
  rev,
  ts: '2026-10-23T00:00:00.000Z',
  actor: { kind: 'human' },
  op,
  inverse,
  ...(ref !== undefined ? { ref } : {}),
});
const historyOp = (rev: number, op: Op, inverse: Op): HistoryEntry =>
  historyEntry('op', rev, op, inverse);
const batchOf = (...ops: LeafOp[]): Op => ({ type: 'batch', ops });

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

interface Harness {
  readonly tools: Map<string, HostTool>;
  readonly requests: Recorded[];
  readonly prompts: PromptDraft[];
  readonly viewportCalls: ViewportCall[];
}

function harness(options: {
  config?: Partial<OmpConfig>;
  wall?: Wall;
  reply?: (request: Recorded) => { status: number; body: object } | null;
  answer?: HswPromptAnswer;
  viewport?: (call: ViewportCall) => ViewportResult;
}): Harness {
  const requests: Recorded[] = [];
  const prompts: PromptDraft[] = [];
  const viewportCalls: ViewportCall[] = [];
  const wall = options.wall ?? createEmptyWall('w1', 'Test');
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(String(input));
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      body:
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    requests.push(recorded);
    const custom = options.reply?.(recorded);
    if (custom) return Response.json(custom.body, { status: custom.status });
    if (recorded.method === 'GET' && url.pathname === '/api/walls/w1') {
      return Response.json({ wall, warnings: [], canUndo: false, canRedo: false });
    }
    return Response.json({ error: { code: 'not_found' } }, { status: 404 });
  };
  const factory = createWallToolFactory({
    apiBase: () => 'http://127.0.0.1:1',
    fetchImpl: fetchImpl as typeof fetch,
  });
  const tools = new Map(
    factory({
      wallId: 'w1',
      config: testConfig(options.config),
      viewport: {
        async call(call) {
          viewportCalls.push(call);
          if (options.viewport) return options.viewport(call);
          throw new Error('no editor window');
        },
      },
      prompts: {
        async ask(_tool, draft) {
          prompts.push(draft);
          return options.answer ?? { cancelled: true };
        },
      },
    }).map((tool) => [tool.definition.name, tool]),
  );
  return { tools, requests, prompts, viewportCalls };
}

async function run(h: Harness, name: string, args: object) {
  const tool = h.tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.execute(JSON.parse(JSON.stringify(args)), {
    wallId: 'w1',
    signal: new AbortController().signal,
  });
}

function resultText(result: Awaited<ReturnType<typeof run>>): string {
  const block = result.content.find((entry) => entry.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

describe('destructive op policy', () => {
  test('counts removals across batches and entity kinds', () => {
    expect(
      countRemovals([
        removeItem('a'),
        { type: 'batch', ops: [removeItem('b'), { type: 'removePhoto', id: 'p' }] },
      ]),
    ).toBe(3);
    expect(countRemovals([addItem('x')])).toBe(0);
  });

  test('the threshold is inclusive and the policy decides what happens beyond it', () => {
    const ask = { destructiveOps: 'ask', destructiveThreshold: 5 } as const;
    expect(decideDestructive(ask, 5)).toBe('proceed');
    expect(decideDestructive(ask, 6)).toBe('ask');
    expect(decideDestructive({ ...ask, destructiveOps: 'deny' }, 6)).toBe('refuse');
    expect(decideDestructive({ ...ask, destructiveOps: 'deny' }, 5)).toBe('proceed');
    expect(decideDestructive({ ...ask, destructiveOps: 'allow' }, 500)).toBe('proceed');
  });

  test('addedIds finds ids the server generated, inside batches', () => {
    const added = addedIds({
      type: 'batch',
      ops: [addItem('i-1'), addItem('i-2'), removeItem('i-0')],
    });
    expect(added.items).toEqual(['i-1', 'i-2']);
  });

  test('countUndoRedoRemovals replays the undo/redo stacks of the history', () => {
    const add = batchOf(addItem('a'), addItem('b'), addItem('c'));
    const undoAdd = batchOf(removeItem('a'), removeItem('b'), removeItem('c'));
    const entries = [historyOp(1, add, undoAdd)];
    expect(countUndoRedoRemovals(entries, 1, false)).toBe(3);
    expect(countUndoRedoRemovals(entries, 1, true)).toBe(0);
    // After the undo, redo re-applies the add (no removals) and a second undo has nothing left.
    const undone = [...entries, historyEntry('undo', 2, undoAdd, add, 1)];
    expect(countUndoRedoRemovals(undone, 1, false)).toBe(0);
    expect(countUndoRedoRemovals(undone, 1, true)).toBe(0);
    // Redo of a removal op is a removal; a new op clears the redo stack.
    const removal = historyOp(3, batchOf(removeItem('a')), batchOf(addItem('a')));
    const removedThenUndone = [
      removal,
      historyEntry('undo', 4, batchOf(addItem('a')), batchOf(removeItem('a')), 3),
    ];
    expect(countUndoRedoRemovals(removedThenUndone, 1, true)).toBe(1);
    expect(countUndoRedoRemovals([...removedThenUndone, historyOp(5, add, undoAdd)], 1, true)).toBe(
      0,
    );
  });
});

describe('wall_apply', () => {
  const okReply = (op: Op) => (request: Recorded) =>
    request.method === 'POST' && request.path.endsWith('/ops')
      ? {
          status: 200,
          body: {
            rev: 4,
            changed: true,
            op,
            inverse: op,
            wall: {},
            warnings: [{ code: 'cell_collision' }],
            canUndo: true,
            canRedo: false,
          },
        }
      : null;

  test('sends the ops as actor agent/omp with baseRev and label, and returns generated ids and warnings', async () => {
    const h = harness({
      reply: okReply({ type: 'batch', ops: [addItem('i-new1'), addItem('i-new2')] }),
    });
    const result = await run(h, 'wall_apply', {
      ops: [addItem('i-new1'), addItem('i-new2')],
      baseRev: 3,
      label: 'two holders',
    });
    const post = h.requests.find((request) => request.method === 'POST');
    expect(post?.path).toBe('/api/walls/w1/ops');
    expect(post?.body).toMatchObject({
      baseRev: 3,
      label: 'two holders',
      actor: { kind: 'agent', name: 'omp' },
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(resultText(result))).toMatchObject({
      ok: true,
      rev: 4,
      added: { items: ['i-new1', 'i-new2'] },
      warnings: [{ code: 'cell_collision' }],
    });
  });

  test('schema violations are reported to the agent without touching the wall', async () => {
    const h = harness({});
    const result = await run(h, 'wall_apply', { ops: [{ type: 'teleportItem', id: 'x' }] });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('Invalid wall_apply arguments');
    expect(h.requests).toHaveLength(0);
  });

  test('a stale baseRev tells the agent the current rev and what to do', async () => {
    const h = harness({
      reply: () => ({
        status: 409,
        body: { error: { code: 'rev_conflict', message: 'stale' }, currentRev: 9 },
      }),
    });
    const result = await run(h, 'wall_apply', { ops: [addItem('i-1')], baseRev: 2 });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('rev 9');
    expect(resultText(result)).toContain('wall_get');
  });

  test('bulk removal asks the user; declining applies nothing, approving applies it', async () => {
    const ops = ['a', 'b', 'c', 'd', 'e', 'f'].map(removeItem);
    const declined = harness({
      answer: { approved: false },
      reply: okReply({ type: 'batch', ops }),
    });
    const refusal = await run(declined, 'wall_apply', { ops });
    expect(declined.prompts).toHaveLength(1);
    expect(declined.prompts[0]).toMatchObject({ kind: 'destructive_ops', removeCount: 6 });
    expect(refusal.isError).toBe(true);
    expect(declined.requests.some((request) => request.method === 'POST')).toBe(false);

    const approved = harness({
      answer: { approved: true },
      reply: okReply({ type: 'batch', ops }),
    });
    const done = await run(approved, 'wall_apply', { ops });
    expect(done.isError).toBeUndefined();
    expect(approved.requests.some((request) => request.method === 'POST')).toBe(true);
  });

  test('removals at or below the threshold never prompt; policy deny refuses; closed prompt counts as no', async () => {
    const few = ['a', 'b', 'c', 'd', 'e'].map(removeItem);
    const quiet = harness({ reply: okReply({ type: 'batch', ops: few }) });
    await run(quiet, 'wall_apply', { ops: few });
    expect(quiet.prompts).toHaveLength(0);

    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map(removeItem);
    const denied = harness({ config: { destructiveOps: 'deny' } });
    expect((await run(denied, 'wall_apply', { ops: many })).isError).toBe(true);
    expect(denied.requests).toHaveLength(0);

    const dismissed = harness({ answer: { cancelled: true } });
    expect((await run(dismissed, 'wall_apply', { ops: many })).isError).toBe(true);
  });
});

describe('wall_get / wall_view / wall_select', () => {
  test('wall_get returns the wall with the selection from the editor window', async () => {
    const h = harness({ viewport: () => ({ selected: ['i-1'] }) });
    const result = await run(h, 'wall_get', {});
    const body = JSON.parse(resultText(result)) as {
      rev: number;
      selection: string[] | null;
      wall: { id: string };
    };
    expect(body).toMatchObject({ rev: 0, selection: ['i-1'], wall: { id: 'w1' } });
    expect(h.viewportCalls).toEqual([{ method: 'get_selection' }]);
  });

  test('wall_get still works when no editor window is attached, reporting selection as null', async () => {
    const h = harness({});
    const body = JSON.parse(resultText(await run(h, 'wall_get', {}))) as { selection: null };
    expect(body.selection).toBeNull();
  });

  test('a large wall is returned in compact form', async () => {
    const wall = createEmptyWall('w1', 'Big');
    const items = Array.from({ length: 400 }, (_, i) => {
      const op = addItem(`i-${i}`);
      if (op.type !== 'addItem') throw new Error('unreachable');
      return { ...op.item, label: 'x'.repeat(100) };
    });
    const h = harness({ wall: { ...wall, items } });
    const body = JSON.parse(resultText(await run(h, 'wall_get', {}))) as {
      note?: string;
      wall: { items: { pose?: unknown }[] };
    };
    expect(body.note).toContain('compact');
    expect(body.wall.items[0]?.pose).toBeUndefined();
  });

  test('wall_view returns the screenshot as an image block', async () => {
    const h = harness({
      viewport: () => ({
        mimeType: 'image/png',
        dataBase64: 'iVBORw0KGgo=',
        width: 800,
        height: 500,
      }),
    });
    const result = await run(h, 'wall_view', { view: 'front' });
    expect(
      result.content.some((block) => block.type === 'image' && block.mimeType === 'image/png'),
    ).toBe(true);
    expect(h.viewportCalls[0]).toEqual({
      method: 'capture',
      params: { view: 'front', maxSidePx: 900 },
    });
  });

  test('wall_view and wall_select surface a missing editor window as a tool error', async () => {
    const h = harness({});
    await expect(run(h, 'wall_view', {})).rejects.toThrow('no editor window');
    await expect(run(h, 'wall_select', { ids: ['i-1'] })).rejects.toThrow('no editor window');
  });
});

describe('wall_clean_background', () => {
  const photo = {
    id: 'p-1',
    file: 'photos/p-1.jpg',
    mime: 'image/jpeg' as const,
    width: 100,
    height: 80,
    origin: 'upload' as const,
  };

  function cleaning(states: string[]) {
    let polls = 0;
    const base = createEmptyWall('w1', 'Test');
    return harness({
      wall: { ...base, photos: [photo] },
      reply: (request) => {
        if (request.method === 'POST' && request.path === '/api/jobs') {
          return { status: 202, body: { job: { id: 'j1', state: 'queued' } } };
        }
        if (request.path === '/api/jobs/j1') {
          const state = states[Math.min(polls, states.length - 1)] ?? 'failed';
          polls += 1;
          return {
            status: 200,
            body: {
              job: {
                id: 'j1',
                state,
                result: { status: 'ok', method: 'basic', ai: 'login_required' },
                error: 'boom',
              },
            },
          };
        }
        return null;
      },
    });
  }

  test('starts photo.clean for the first photo and returns the finished result', async () => {
    const h = cleaning(['succeeded']);
    const result = await run(h, 'wall_clean_background', {});
    expect(JSON.parse(resultText(result))).toEqual({
      status: 'ok',
      method: 'basic',
      ai: 'login_required',
    });
    const start = h.requests.find((request) => request.path === '/api/jobs');
    expect(start?.body).toEqual({
      kind: 'photo.clean',
      wallId: 'w1',
      input: { wallId: 'w1', photoId: 'p-1', method: 'auto', refresh: false },
    });
  });

  test('a failed job is a tool failure, a wall without photos has nothing to clean', async () => {
    const failed = await run(cleaning(['failed']), 'wall_clean_background', {
      photoId: 'p-1',
      method: 'basic',
    });
    expect(resultText(failed)).toContain('Cleaning failed');
    const empty = await run(harness({}), 'wall_clean_background', {});
    expect(resultText(empty)).toContain('no photo');
  });
});

describe('wall_request_input', () => {
  const dimension = {
    request: {
      kind: 'dimension',
      title: 'Screwdriver',
      payload: { fields: [{ key: 'length', unit: 'mm', fitted: 148, suggested: 150 }] },
    },
  };

  test('opens a core input request as the agent and returns the answer once the user resolves it', async () => {
    let polls = 0;
    const reply = (request: Recorded) => {
      if (request.method === 'POST' && request.path === '/api/walls/w1/requests') {
        return { status: 201, body: { request: { id: 'r-1', kind: 'dimension', status: 'open' } } };
      }
      if (request.path.startsWith('/api/walls/w1/requests/r-1?wait=')) {
        polls += 1;
        return polls < 3
          ? { status: 200, body: { request: { id: 'r-1', kind: 'dimension', status: 'open' } } }
          : {
              status: 200,
              body: {
                request: {
                  id: 'r-1',
                  kind: 'dimension',
                  status: 'answered',
                  answer: { length: 160 },
                },
              },
            };
      }
      return null;
    };
    const h = harness({ reply });
    const result = await run(h, 'wall_request_input', dimension);
    const created = h.requests.find((request) => request.method === 'POST');
    expect(created?.body).toMatchObject({
      actor: { kind: 'agent', name: 'omp' },
      request: { kind: 'dimension' },
    });
    expect(polls).toBe(3);
    expect(JSON.parse(resultText(result))).toEqual({ status: 'answered', answer: { length: 160 } });
  });

  test('a dismissed widget is reported, not treated as an answer', async () => {
    const reply = (request: Recorded) =>
      request.method === 'POST'
        ? { status: 201, body: { request: { id: 'r-2', kind: 'dimension', status: 'open' } } }
        : { status: 200, body: { request: { id: 'r-2', kind: 'dimension', status: 'cancelled' } } };
    const body = JSON.parse(
      resultText(await run(harness({ reply }), 'wall_request_input', dimension)),
    ) as { status: string };
    expect(body.status).toBe('cancelled');
  });

  test('an aborted call cancels the open request so no widget is left behind', async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    const h = harness({
      reply: (request) => {
        requests.push(`${request.method} ${request.path}`);
        if (request.method === 'POST' && request.path.endsWith('/requests')) {
          controller.abort();
          return {
            status: 201,
            body: { request: { id: 'r-3', kind: 'dimension', status: 'open' } },
          };
        }
        return { status: 200, body: { request: { id: 'r-3', kind: 'dimension', status: 'open' } } };
      },
    });
    const tool = h.tools.get('wall_request_input');
    const result = await tool?.execute(JSON.parse(JSON.stringify(dimension)), {
      wallId: 'w1',
      signal: controller.signal,
    });
    expect(result?.isError).toBe(true);
    expect(requests).toContain('POST /api/walls/w1/requests/r-3/cancel');
  });

  test('requests that do not match the core schema never reach the server', async () => {
    const h = harness({});
    const result = await run(h, 'wall_request_input', {
      request: { kind: 'dimension', payload: { fields: [] } },
    });
    expect(result.isError).toBe(true);
    expect(h.requests).toHaveLength(0);
  });
});

describe('wall_undo and wall_bank_search', () => {
  test('undo posts as the agent and guards every step with the rev the previous step produced', async () => {
    const reply = (request: Recorded) => {
      if (request.path.startsWith('/api/walls/w1/history')) {
        return { status: 200, body: { entries: [] } };
      }
      return request.path.endsWith('/undo')
        ? {
            status: 200,
            body: {
              rev: 5,
              changed: true,
              op: {},
              inverse: {},
              wall: {},
              warnings: [],
              canUndo: true,
              canRedo: true,
            },
          }
        : null;
    };
    const h = harness({ reply });
    const result = await run(h, 'wall_undo', { steps: 2, baseRev: 6 });
    const posts = h.requests.filter((request) => request.method === 'POST');
    expect(posts.map((request) => request.body)).toEqual([
      { baseRev: 6, actor: { kind: 'agent', name: 'omp' } },
      { baseRev: 5, actor: { kind: 'agent', name: 'omp' } },
    ]);
    expect(JSON.parse(resultText(result))).toMatchObject({ ok: true, rev: 5, canRedo: true });
  });

  test('undoing a batch that removes more than the threshold asks first; declining undoes nothing', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const history = [
      historyOp(
        1,
        { type: 'batch', ops: ids.map(addItem) },
        { type: 'batch', ops: ids.map(removeItem) },
      ),
    ];
    const reply = (request: Recorded) =>
      request.path.startsWith('/api/walls/w1/history')
        ? { status: 200, body: { entries: history } }
        : null;
    const declined = harness({ reply, answer: { approved: false } });
    expect((await run(declined, 'wall_undo', {})).isError).toBe(true);
    expect(declined.prompts[0]).toMatchObject({ kind: 'destructive_ops', removeCount: 6 });
    expect(declined.requests.some((request) => request.method === 'POST')).toBe(false);

    const denied = harness({ reply, config: { destructiveOps: 'deny' } });
    expect((await run(denied, 'wall_undo', {})).isError).toBe(true);
    expect(denied.prompts).toHaveLength(0);
  });

  test('bank search resolves hits to compact element summaries', async () => {
    const reply = (request: Recorded) => {
      if (request.path.startsWith('/api/bank/search'))
        return {
          status: 200,
          body: {
            results: [
              { id: 'e1', score: 3.14159 },
              { id: 'gone', score: 1 },
            ],
          },
        };
      if (request.path === '/api/bank/elements/e1') {
        return {
          status: 200,
          body: {
            id: 'e1',
            name: { ru: 'Держатель отвёрток', en: 'Screwdriver holder' },
            category: 'holders/screwdrivers',
            dimsMm: { x: 60, y: 40, z: 30 },
            footprint: { cells: [{}, {}] },
            mounting: { kind: 'plug' },
            params: [{ key: 'length', min: 80, max: 200, default: 120, unit: 'mm', label: 'L' }],
          },
        };
      }
      return { status: 404, body: { error: { code: 'not_found' } } };
    };
    const h = harness({ reply });
    const body = JSON.parse(
      resultText(await run(h, 'wall_bank_search', { query: 'отвертка', limit: 5 })),
    ) as {
      count: number;
      results: { id: string; cells: number; score: number; params: { key: string }[] }[];
    };
    expect(h.requests[0]?.path).toBe(
      '/api/bank/search?q=%D0%BE%D1%82%D0%B2%D0%B5%D1%80%D1%82%D0%BA%D0%B0&limit=5',
    );
    expect(body.count).toBe(1);
    expect(body.results[0]).toMatchObject({
      id: 'e1',
      cells: 2,
      score: 3.14,
      params: [{ key: 'length' }],
    });
  });
});

// ---- Tool library tools ---------------------------------------------------------------------------------

const LIBRARY = [
  {
    id: 'sd-1',
    name: { en: 'Phillips screwdriver', ru: 'Отвёртка крестовая' },
    classId: 'screwdriver',
    bankClass: 'screwdriver',
    tags: ['carpet', 'carpet-2026-10-21'],
    dimsMm: { x: 28, y: 210, z: 28 },
    holdingDims: { shaftDiameter: 6 },
  },
  {
    id: 'pl-1',
    name: { en: 'Combination pliers' },
    classId: 'pliers-combination',
    bankClass: 'pliers',
    tags: ['carpet'],
    dimsMm: { x: 60, y: 180, z: 20 },
    holdingDims: { jawThickness: 8 },
  },
  {
    id: 'blob-1',
    name: { en: 'Odd thing' },
    classId: null,
    bankClass: null,
    tags: ['garage'],
    dimsMm: { x: 50, y: 50, z: 50 },
    holdingDims: {},
  },
];

/** A holder for screwdrivers with three slots taking shafts of 3-9 mm (the fields `@hsw-editor/compat` reads). */
const HOLDER_ELEMENT = {
  id: 'sd-holder',
  name: { ru: 'Держатель отвёрток', en: 'Screwdriver holder' },
  category: 'holders/screwdrivers',
  dimsMm: { x: 90, y: 40, z: 30 },
  footprint: { cells: [{}, {}, {}] },
  mounting: { kind: 'plug' },
  fitsTool: [
    { toolClass: 'screwdriver', capacity: 3, dims: { shaftDiameter: { min: 3, max: 9 } } },
  ],
  bboxMm: { min: { x: -45, y: -20, z: 0 }, max: { x: 45, y: 20, z: 30 } },
};

const SD_HOLDING = {
  holding: {
    lengthMm: 210,
    hang: null,
    maxSection: { w: 28, t: 28, r: 20 },
    dims: { shaftDiameter: 6, width: 28 },
  },
  bankClass: 'screwdriver',
};

function wallWithHolder(holderBankId = 'sd-holder'): Wall {
  const wall = createEmptyWall('w1', 'Test');
  return applyOp(wall, {
    type: 'addItem',
    item: WallItemSchema.parse({
      id: 'h-1',
      kind: 'holder',
      bankId: holderBankId,
      cell: { col: 4, row: 4 },
    }),
  }).wall;
}

function libraryDaemon(options: { wall?: Wall; holding?: object } = {}) {
  const applied: Recorded[] = [];
  const reply = (request: Recorded) => {
    if (request.path === '/api/tools') return { status: 200, body: { tools: LIBRARY } };
    if (request.path.startsWith('/api/tools/sd-1/holding'))
      return { status: 200, body: options.holding ?? SD_HOLDING };
    if (request.path === '/api/tools/sd-1')
      return {
        status: 200,
        body: {
          tool: {
            id: 'sd-1',
            name: LIBRARY[0]?.name,
            dimensionsMm: { length: 210, width: 28, thickness: 28 },
          },
        },
      };
    if (request.path === '/api/tools/blob-1/holding')
      return { status: 200, body: { holding: SD_HOLDING.holding, bankClass: null } };
    if (request.path === '/api/tools/blob-1')
      return {
        status: 200,
        body: {
          tool: {
            id: 'blob-1',
            name: LIBRARY[2]?.name,
            dimensionsMm: { length: 50, width: 50, thickness: 50 },
          },
        },
      };
    if (request.path.startsWith('/api/tools/'))
      return { status: 404, body: { error: { code: 'tool_not_found' } } };
    if (request.path.startsWith('/api/bank/search'))
      return { status: 200, body: { results: [{ id: 'sd-holder', score: 2 }] } };
    if (request.path === '/api/bank/elements/sd-holder')
      return { status: 200, body: HOLDER_ELEMENT };
    if (request.method === 'POST' && request.path === '/api/walls/w1/ops') {
      applied.push(request);
      return {
        status: 200,
        body: {
          rev: 7,
          changed: true,
          op: { type: 'batch', ops: [] },
          warnings: [],
          canUndo: true,
        },
      };
    }
    return null;
  };
  return { h: harness({ reply, wall: options.wall ?? wallWithHolder() }), applied };
}

describe('wall_tools_search', () => {
  test('lists the library tools of a tag with box, dims and suggested holders, and every tag of the library', async () => {
    const { h } = libraryDaemon();
    const body = JSON.parse(resultText(await run(h, 'wall_tools_search', { tag: 'carpet' }))) as {
      total: number;
      matched: number;
      results: {
        id: string;
        bankClass: string;
        dimsMm: object;
        suggestedHolders: { id: string; name: string }[];
      }[];
      tags: { tag: string; count: number }[];
    };
    expect(body.total).toBe(3);
    expect(body.matched).toBe(2);
    expect(body.results.map((tool) => tool.id)).toEqual(['sd-1', 'pl-1']);
    expect(body.results[0]).toMatchObject({
      bankClass: 'screwdriver',
      dimsMm: { x: 28, y: 210, z: 28 },
      suggestedHolders: [{ id: 'sd-holder', name: 'Screwdriver holder' }],
    });
    expect(body.tags[0]).toEqual({ tag: 'carpet', count: 2 });
    // one holder search per distinct class, by the class name, filtered to holders of that class
    const searches = h.requests.filter((request) => request.path.startsWith('/api/bank/search'));
    expect(searches.map((request) => request.path).sort()).toEqual([
      '/api/bank/search?q=pliers&tool=pliers&category=holders&limit=3',
      '/api/bank/search?q=screwdriver&tool=screwdriver&category=holders&limit=3',
    ]);
  });

  test('filters by class and text; an unknown tag matches nothing but still lists the tags that exist', async () => {
    const { h } = libraryDaemon();
    const byClass = JSON.parse(
      resultText(await run(h, 'wall_tools_search', { classId: 'pliers', holders: false })),
    ) as { results: { id: string }[] };
    expect(byClass.results.map((tool) => tool.id)).toEqual(['pl-1']);
    const byText = JSON.parse(
      resultText(await run(h, 'wall_tools_search', { text: 'отвертка', holders: false })),
    ) as { results: { id: string }[] };
    expect(byText.results.map((tool) => tool.id)).toEqual(['sd-1']);
    const none = JSON.parse(resultText(await run(h, 'wall_tools_search', { tag: 'nope' }))) as {
      matched: number;
      tags: { tag: string }[];
    };
    expect(none.matched).toBe(0);
    expect(none.tags.map((entry) => entry.tag)).toContain('carpet');
  });

  test('a generic shape is listed with a note instead of holders', async () => {
    const { h } = libraryDaemon();
    const body = JSON.parse(resultText(await run(h, 'wall_tools_search', { tag: 'garage' }))) as {
      results: { id: string; note?: string; suggestedHolders?: unknown }[];
    };
    expect(body.results[0]?.note).toContain('generic');
    expect(body.results[0]?.suggestedHolders).toBeUndefined();
  });

  test('a daemon without the library reports it instead of an empty list', async () => {
    const h = harness({ reply: () => ({ status: 404, body: { error: { code: 'not_found' } } }) });
    expect((await run(h, 'wall_tools_search', {})).isError).toBe(true);
  });
});

describe('wall_add_tool', () => {
  test('adds a library tool with a tool:<id> model ref and hangs it on the free compatible holder in one batch', async () => {
    const { h, applied } = libraryDaemon();
    const body = JSON.parse(resultText(await run(h, 'wall_add_tool', { toolId: 'sd-1' }))) as {
      ok: boolean;
      itemId: string;
      holderId: string;
      slot: number;
    };
    expect(body).toMatchObject({ ok: true, holderId: 'h-1', slot: 0 });
    expect(applied).toHaveLength(1);
    const post = applied[0]?.body as {
      baseRev: number;
      actor: object;
      ops: { type: string; model?: Record<string, unknown>; item?: Record<string, unknown> }[];
    };
    expect(post.actor).toEqual({ kind: 'agent', name: 'omp' });
    expect(post.baseRev).toBe(1); // the rev the wall was read at
    expect(post.ops.map((op) => op.type)).toEqual(['addModelRef', 'addItem']);
    const model = post.ops[0]?.model ?? {};
    const item = post.ops[1]?.item ?? {};
    expect(model).toMatchObject({
      status: 'chosen',
      toolClass: 'screwdriver',
      source: { type: 'library', by: 'tool:sd-1' },
      dimensionsMm: { x: 28, y: 210, z: 28 },
    });
    expect(item).toMatchObject({
      kind: 'tool',
      modelRefId: model['id'],
      toolClass: 'screwdriver',
      parentId: 'h-1',
      slot: 0,
      // measured holding dims are params; the model's `width` is the box, not a param
      params: { shaftDiameter: 6 },
      label: 'Phillips screwdriver',
    });
    expect(item['id']).toBe(body.itemId);
    // hung: placed by the mount (z in front of the wall at the slot), not at the draft origin
    expect(item['pose']).not.toMatchObject({ x: 0, y: 0 });
  });

  test('a requested slot of the holder is the one the tool takes', async () => {
    const { h, applied } = libraryDaemon();
    await run(h, 'wall_add_tool', { toolId: 'sd-1', slot: 2 });
    const post = applied[0]?.body as { ops: { item?: { slot?: number } }[] };
    expect(post.ops[1]?.item?.slot).toBe(2);
  });

  test('refuses a holder whose shaft range does not take the tool, with the verdict, and posts nothing', async () => {
    const thick = {
      ...SD_HOLDING,
      holding: { ...SD_HOLDING.holding, dims: { shaftDiameter: 12 } },
    };
    const { h, applied } = libraryDaemon({ holding: thick });
    const result = await run(h, 'wall_add_tool', { toolId: 'sd-1', holderId: 'h-1' });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('does not take this tool');
    // the verdicts are in what the model reads, not only in the details
    expect(resultText(result)).toContain('dim_too_large');
    expect(applied).toHaveLength(0);
  });

  test('says to add a holder when the wall has none; names unknown tools and generic shapes', async () => {
    const empty = libraryDaemon({ wall: createEmptyWall('w1', 'Test') });
    const noHolder = await run(empty.h, 'wall_add_tool', { toolId: 'sd-1' });
    expect(noHolder.isError).toBe(true);
    expect(resultText(noHolder)).toContain('Add a suitable holder');

    const { h } = libraryDaemon();
    expect(resultText(await run(h, 'wall_add_tool', { toolId: 'ghost' }))).toContain(
      'tool_not_found',
    );
    const generic = await run(h, 'wall_add_tool', { toolId: 'blob-1' });
    expect(generic.isError).toBe(true);
    expect(resultText(generic)).toContain('generic shape');
  });
});
