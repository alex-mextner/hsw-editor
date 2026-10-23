/**
 * Host tools that let omp edit the open wall through the same REST op stream the human uses.
 *
 * Every mutation goes over the daemon's own HTTP API (`docs/api.md`) with `actor = { kind: 'agent', name: 'omp' }`,
 * so it is validated by the single reducer, appended to the wall history, broadcast over SSE to the page and
 * undoable like any other edit. Argument schemas are the zod schemas of `packages/core`.
 */
import {
  type ApplyResponse,
  type HistoryEntry,
  type InputRequest,
  NewInputRequestSchema,
  type Op,
  type Wall,
  type WallResponse,
  OpSchema,
  OpsBodySchema,
} from '@hsw-editor/core';
import type { JsonObject, JsonValue, OmpToolResult } from '@hsw-editor/omp-protocol';
import { z } from 'zod';
import type { OmpConfig } from './config.ts';
import { failure, formatIssues, jsonResult, jsonSchemaOf } from './tool-helpers.ts';
import type { HostTool, ToolEnv, ToolFactory } from './tool-types.ts';

export const AGENT_ACTOR = { kind: 'agent', name: 'omp' } as const;

/** Every op type the reducer accepts, read from the schema so the tool description cannot drift. */
const OP_TYPE_NAMES = OpSchema.options.map((option) => option.shape.type.value).join(', ');

const MAX_OPS_PER_CALL = 500;
const MAX_INLINE_WALL_CHARS = 50_000;
const MAX_UNDO_STEPS = 20;
const MAX_VIEW_SIDE_PX = 1600;
const SELECTION_TIMEOUT_MS = 4000;
const REQUEST_POLL_MS = 60_000;

export interface WallToolOptions {
  /** Base URL of the daemon's own API, e.g. `http://127.0.0.1:8794` (resolved lazily: the port is known after listen). */
  readonly apiBase: () => string;
  readonly fetchImpl?: typeof fetch;
}

// ---- Pure helpers (unit-tested) ---------------------------------------------------------------------

/** Number of removal ops (items, photos, model refs), looking inside batches. */
export function countRemovals(ops: readonly Op[]): number {
  let count = 0;
  for (const op of ops) {
    if (op.type === 'batch') count += countRemovals(op.ops);
    else if (op.type === 'removeItem' || op.type === 'removePhoto' || op.type === 'removeModelRef')
      count += 1;
  }
  return count;
}

/**
 * Removals the next `steps` undos (or redos) would perform. Mirrors the store's stacks: an op pushes onto
 * the undo stack and clears the redo stack, an undo moves the top across, a redo pushes its own rev.
 * Undo applies the target's stored inverse, redo re-applies its op.
 */
export function countUndoRedoRemovals(
  entries: readonly HistoryEntry[],
  steps: number,
  redo: boolean,
): number {
  const byRev = new Map<number, Exclude<HistoryEntry, { kind: 'create' }>>();
  const undoStack: number[] = [];
  const redoStack: number[] = [];
  for (const entry of entries) {
    if (entry.kind === 'create') continue;
    byRev.set(entry.rev, entry);
    if (entry.kind === 'op') {
      undoStack.push(entry.rev);
      redoStack.length = 0;
    } else if (entry.kind === 'undo') {
      const undone = undoStack.pop();
      if (undone !== undefined) redoStack.push(undone);
    } else {
      redoStack.pop();
      undoStack.push(entry.rev);
    }
  }
  let removals = 0;
  for (let step = 0; step < steps; step += 1) {
    const ref = redo ? redoStack.pop() : undoStack.pop();
    const target = ref === undefined ? undefined : byRev.get(ref);
    if (ref === undefined || target === undefined) break;
    removals += countRemovals([redo ? target.op : target.inverse]);
    (redo ? undoStack : redoStack).push(ref);
  }
  return removals;
}

export type DestructiveDecision = 'proceed' | 'ask' | 'refuse';

/** Policy gate for bulk removals proposed by the agent. */
export function decideDestructive(
  config: Pick<OmpConfig, 'destructiveOps' | 'destructiveThreshold'>,
  removeCount: number,
): DestructiveDecision {
  if (config.destructiveOps === 'allow' || removeCount <= config.destructiveThreshold)
    return 'proceed';
  return config.destructiveOps === 'deny' ? 'refuse' : 'ask';
}

export interface AddedIds {
  readonly items: string[];
  readonly photos: string[];
  readonly models: string[];
}

/** Ids of the entities an applied op created (the server fills in omitted ids; the agent needs them back). */
export function addedIds(op: Op, into: AddedIds = { items: [], photos: [], models: [] }): AddedIds {
  switch (op.type) {
    case 'addItem':
      into.items.push(op.item.id);
      break;
    case 'addPhoto':
      into.photos.push(op.photo.id);
      break;
    case 'addModelRef':
      into.models.push(op.model.id);
      break;
    case 'batch':
      for (const inner of op.ops) addedIds(inner, into);
      break;
    default:
      break;
  }
  return into;
}

// ---- Argument schemas ---------------------------------------------------------------------------------

const ApplyArgsSchema = OpsBodySchema.omit({ actor: true }).extend({
  ops: OpsBodySchema.shape.ops.max(MAX_OPS_PER_CALL),
});
const UndoArgsSchema = z.strictObject({
  steps: z.number().int().min(1).max(MAX_UNDO_STEPS).default(1),
  redo: z.boolean().default(false),
  baseRev: z.number().int().min(0).optional(),
});
const GetArgsSchema = z.strictObject({ compact: z.boolean().default(false) });
const BankSearchArgsSchema = z.strictObject({
  query: z.string().max(200).default(''),
  category: z.string().max(100).optional(),
  toolClass: z.string().max(100).optional(),
  mounting: z.string().max(50).optional(),
  limit: z.number().int().min(1).max(30).default(10),
});
const SelectArgsSchema = z.strictObject({ ids: z.array(z.string().min(1).max(64)).max(200) });
const ViewArgsSchema = z.strictObject({
  view: z.enum(['current', 'front', 'iso']).default('current'),
  maxSidePx: z.number().int().min(200).max(MAX_VIEW_SIDE_PX).default(900),
});
const AnalyseHangArgsSchema = z.strictObject({ itemId: z.string().min(1).max(64).optional() });
const RequestInputArgsSchema = z.strictObject({ request: NewInputRequestSchema });
const CleanBackgroundArgsSchema = z.strictObject({
  photoId: z.string().min(1).max(64).optional(),
  method: z.enum(['auto', 'basic']).default('auto'),
  refresh: z.boolean().default(false),
});
/** How often the cleaning job is looked at while the tool waits for it. */
const CLEAN_POLL_MS = 1000;

// ---- Tools ----------------------------------------------------------------------------------------------

interface ApiReply<T> {
  readonly status: number;
  readonly body: T;
}

interface ApiErrorReply {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: JsonValue;
  };
  readonly currentRev?: number;
}

/** The slice of the physics report the tool's `details` read; the body itself is passed on untouched. */
interface WallPhysicsReply {
  readonly rev?: number;
  readonly tools?: readonly unknown[];
  readonly flagged?: number;
}

export function createWallToolFactory(options: WallToolOptions): ToolFactory {
  const doFetch = options.fetchImpl ?? fetch;

  async function api<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<ApiReply<T>> {
    const response = await doFetch(`${options.apiBase()}${path}`, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
      ...(signal ? { signal } : {}),
    });
    const parsed = (await response.json().catch(() => ({}))) as T;
    return { status: response.status, body: parsed };
  }

  return (env: ToolEnv) => {
    const wallPath = `/api/walls/${encodeURIComponent(env.wallId)}`;

    const apiFailure = (status: number, body: ApiErrorReply): OmpToolResult => {
      const code = body.error?.code ?? `http_${status}`;
      const hint =
        code === 'rev_conflict'
          ? ` The wall is now at rev ${body.currentRev ?? '?'}; call wall_get, re-plan on the current state and retry.`
          : code === 'op_failed'
            ? ' Nothing was applied (a request is atomic). Fix the refused op and retry.'
            : '';
      return failure(`${code}: ${body.error?.message ?? 'request failed'}${hint}`, {
        code,
        ...(body.error?.details !== undefined ? { issues: body.error.details } : {}),
        ...(body.currentRev !== undefined ? { currentRev: body.currentRev } : {}),
      });
    };

    const wallGet: HostTool = {
      definition: {
        name: 'wall_get',
        label: 'Wall: get',
        description:
          'Return the wall that is open in the editor: board geometry, items (with cells, poses, bank ids, params), photos, model refs, the current rev, whether undo/redo are possible, geometry warnings and the items the user has selected. Call before editing.',
        parameters: jsonSchemaOf(GetArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = GetArgsSchema.safeParse(args);
        if (!parsed.success) return failure(formatIssues(parsed.error));
        const reply = await api<WallResponse & ApiErrorReply>('GET', wallPath, undefined, signal);
        if (reply.status !== 200) return apiFailure(reply.status, reply.body);
        const { wall, warnings, canUndo, canRedo } = reply.body;
        const selection = await env.viewport
          .call(
            { method: 'get_selection' },
            AbortSignal.any([signal, AbortSignal.timeout(SELECTION_TIMEOUT_MS)]),
          )
          .then((result) => ('selected' in result ? result.selected : null))
          .catch(() => null);
        const full = JSON.stringify(wall);
        const compact = parsed.data.compact || full.length > MAX_INLINE_WALL_CHARS;
        const body = {
          rev: wall.rev,
          canUndo,
          canRedo,
          selection,
          warnings,
          wall: compact ? compactWall(wall) : wall,
          ...(compact && !parsed.data.compact
            ? {
                note: 'Wall is large: items are shown in compact form (id, kind, bankId, variantId, cell, rotZ, label).',
              }
            : {}),
        };
        return jsonResult(body, { details: { rev: wall.rev, items: wall.items.length } });
      },
    };

    /** The user's go-ahead for removals above the policy threshold; a failure result when it is withheld. */
    const gateRemovals = async (
      toolName: string,
      removals: number,
      opCount: number,
      describe: () => Promise<string>,
      signal: AbortSignal,
    ): Promise<OmpToolResult | null> => {
      const decision = decideDestructive(env.config, removals);
      if (decision === 'proceed') return null;
      if (decision === 'refuse') {
        return failure(
          `Refused: removing ${removals} elements exceeds the limit of ${env.config.destructiveThreshold} and the user's settings forbid bulk removal by the agent.`,
        );
      }
      const answer = await env.prompts.ask(
        toolName,
        {
          kind: 'destructive_ops',
          title: `Remove ${removals} elements?`,
          summary: await describe(),
          removeCount: removals,
          opCount,
        },
        signal,
      );
      return 'approved' in answer && answer.approved
        ? null
        : failure('The user declined this removal. Do not retry it; ask what they want instead.');
    };

    /** The whole history, newest last (the endpoint pages at 10 000 entries). */
    const fetchHistory = async (signal: AbortSignal): Promise<HistoryEntry[] | OmpToolResult> => {
      const entries: HistoryEntry[] = [];
      for (;;) {
        const since = entries.at(-1)?.rev ?? 0;
        const page = await api<{ entries?: HistoryEntry[] } & ApiErrorReply>(
          'GET',
          `${wallPath}/history?since=${since}&limit=10000`,
          undefined,
          signal,
        );
        if (page.status !== 200) return apiFailure(page.status, page.body);
        const batch = page.body.entries ?? [];
        entries.push(...batch);
        if (batch.length < 10_000) return entries;
      }
    };

    const wallApply: HostTool = {
      definition: {
        name: 'wall_apply',
        label: 'Wall: apply ops',
        description: `Apply one or more ops to the open wall as a single atomic batch (one rev, one undo step), attributed to you (agent omp). Op types: ${OP_TYPE_NAMES}. Omitted item ids are generated and returned. Pass baseRev from wall_get to detect concurrent edits by the user. Removing more items than the configured threshold needs the user to approve.`,
        parameters: jsonSchemaOf(ApplyArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = ApplyArgsSchema.safeParse(args);
        if (!parsed.success)
          return failure(`Invalid wall_apply arguments: ${formatIssues(parsed.error)}`);
        const { ops, baseRev, label } = parsed.data;
        const removals = countRemovals(ops);
        const refused = await gateRemovals(
          'wall_apply',
          removals,
          ops.length,
          () => describeRemovals(wallPath, ops, removals, signal),
          signal,
        );
        if (refused !== null) return refused;
        const reply = await api<ApplyResponse & ApiErrorReply>(
          'POST',
          `${wallPath}/ops`,
          {
            ops,
            ...(baseRev !== undefined ? { baseRev } : {}),
            ...(label !== undefined ? { label } : {}),
            actor: AGENT_ACTOR,
          },
          signal,
        );
        if (reply.status !== 200) return apiFailure(reply.status, reply.body);
        const { rev, changed, op, warnings, canUndo } = reply.body;
        const added = addedIds(op);
        const result = {
          ok: true,
          rev,
          changed,
          canUndo,
          added: {
            ...(added.items.length > 0 ? { items: added.items } : {}),
            ...(added.photos.length > 0 ? { photos: added.photos } : {}),
            ...(added.models.length > 0 ? { models: added.models } : {}),
          },
          warnings,
        };
        return jsonResult(result, { details: { rev, changed, opCount: ops.length, removals } });
      },
    };

    const wallUndo: HostTool = {
      definition: {
        name: 'wall_undo',
        label: 'Wall: undo / redo',
        description:
          "Undo (or redo) the newest change(s) on the wall's shared linear history. It reverts the newest op by ANY actor, including the user: use it only to take back your own edit right after making it. Pass baseRev to fail instead of undoing someone else's newer edit.",
        parameters: jsonSchemaOf(UndoArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = UndoArgsSchema.safeParse(args);
        if (!parsed.success) return failure(formatIssues(parsed.error));
        const { steps, redo, baseRev } = parsed.data;
        // The rev the removal count was computed at: an edit made while the user decides must fail the undo.
        let guardRev = baseRev;
        if (env.config.destructiveOps !== 'allow') {
          const history = await fetchHistory(signal);
          if (!Array.isArray(history)) return history;
          guardRev ??= history.at(-1)?.rev ?? 0;
          const removals = countUndoRedoRemovals(history, steps, redo);
          const refused = await gateRemovals(
            'wall_undo',
            removals,
            steps,
            async () =>
              `${redo ? 'Redoing' : 'Undoing'} ${steps} step(s) removes ${removals} elements from the wall.`,
            signal,
          );
          if (refused !== null) return refused;
        }
        let last: ApplyResponse | null = null;
        for (let step = 0; step < steps; step += 1) {
          const reply: ApiReply<ApplyResponse & ApiErrorReply> = await api(
            'POST',
            `${wallPath}/${redo ? 'redo' : 'undo'}`,
            {
              ...(guardRev !== undefined ? { baseRev: step === 0 ? guardRev : last?.rev } : {}),
              actor: AGENT_ACTOR,
            },
            signal,
          );
          if (reply.status !== 200) {
            const failed = apiFailure(reply.status, reply.body);
            return last === null
              ? failed
              : jsonResult(
                  {
                    ok: false,
                    completed: step,
                    rev: last.rev,
                    error: reply.body.error?.code ?? reply.status,
                  },
                  { isError: true },
                );
          }
          last = reply.body;
        }
        return last === null
          ? failure('nothing was undone')
          : jsonResult(
              { ok: true, rev: last.rev, canUndo: last.canUndo, canRedo: last.canRedo },
              { details: { rev: last.rev } },
            );
      },
    };

    const bankSearch: HostTool = {
      definition: {
        name: 'wall_bank_search',
        label: 'Wall: bank search',
        description:
          'Search the bank of ready-made HSW elements by text (Russian or English), optionally filtered by category id (e.g. holders/screwdrivers), tool class or mounting kind. Returns ids to use as bankId, names, categories, size in mm, the honeycomb cells covered, and the dimension parameters (key, range, default) the element accepts via setParams.',
        parameters: jsonSchemaOf(BankSearchArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = BankSearchArgsSchema.safeParse(args);
        if (!parsed.success) return failure(formatIssues(parsed.error));
        const { query, category, toolClass, mounting, limit } = parsed.data;
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        if (category) params.set('category', category);
        if (toolClass) params.set('tool', toolClass);
        if (mounting) params.set('mounting', mounting);
        const search = await api<{ results?: { id: string; score: number }[] } & ApiErrorReply>(
          'GET',
          `/api/bank/search?${params.toString()}`,
          undefined,
          signal,
        );
        if (search.status === 404 && search.body.error?.code === 'not_found') {
          return failure(
            'The element bank is not available on this server (no /api/bank routes are mounted). Tell the user instead of guessing a bankId.',
          );
        }
        if (search.status !== 200) return apiFailure(search.status, search.body);
        const hits = search.body.results ?? [];
        const elements = await Promise.all(
          hits.map(async ({ id, score }) => {
            const element = await api<BankElementView & ApiErrorReply>(
              'GET',
              `/api/bank/elements/${encodeURIComponent(id)}`,
              undefined,
              signal,
            );
            return element.status === 200 ? summariseElement(element.body, score) : null;
          }),
        );
        const results = elements.filter((entry): entry is BankElementSummary => entry !== null);
        return jsonResult(
          { count: results.length, results },
          { details: { count: results.length } },
        );
      },
    };

    const wallSelect: HostTool = {
      definition: {
        name: 'wall_select',
        label: 'Wall: select',
        description:
          'Select (highlight) items in the editor by id so the user sees what you mean. An empty list clears the selection.',
        parameters: jsonSchemaOf(SelectArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = SelectArgsSchema.safeParse(args);
        if (!parsed.success) return failure(formatIssues(parsed.error));
        const result = await env.viewport.call(
          { method: 'select', params: { ids: parsed.data.ids } },
          signal,
        );
        return 'selected' in result
          ? jsonResult({ ok: true, selected: result.selected })
          : failure('unexpected viewport reply');
      },
    };

    const wallView: HostTool = {
      definition: {
        name: 'wall_view',
        label: 'Wall: view',
        description:
          'Capture a screenshot of the 3D viewport of the open wall and return it as an image so you can see the result of your edits. view: current (what the user sees), front (orthographic, straight at the wall) or iso.',
        parameters: jsonSchemaOf(ViewArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = ViewArgsSchema.safeParse(args);
        if (!parsed.success) return failure(formatIssues(parsed.error));
        const result = await env.viewport.call({ method: 'capture', params: parsed.data }, signal);
        if (!('dataBase64' in result)) return failure('unexpected viewport reply');
        return {
          content: [
            {
              type: 'text',
              text: `Viewport screenshot (${parsed.data.view}), ${result.width}x${result.height}px.`,
            },
            { type: 'image', data: result.dataBase64, mimeType: result.mimeType },
          ],
          details: { width: result.width, height: result.height },
        };
      },
    };

    const cleanBackground: HostTool = {
      definition: {
        name: 'wall_clean_background',
        label: 'Wall: clean background',
        description:
          'Clean the photographed wall under the board: the area the board will cover (calibration footprint plus a margin) is replaced by a clean wall surface, in a new "clean" variant of the photo (the original is kept; undo removes it). A basic local fill is made at once; with method auto the image backend of draw then redoes it when one is signed in (otherwise the basic one stays and ai says why). The photo must be calibrated. photoId defaults to the first photo; refresh makes it again even if the board has not moved. Waits for the result.',
        parameters: jsonSchemaOf(CleanBackgroundArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = CleanBackgroundArgsSchema.safeParse(args);
        if (!parsed.success) return failure(formatIssues(parsed.error));
        let photoId = parsed.data.photoId;
        if (photoId === undefined) {
          const current = await api<{ wall?: Wall } & ApiErrorReply>(
            'GET',
            wallPath,
            undefined,
            signal,
          );
          if (current.status !== 200) return apiFailure(current.status, current.body);
          const originals =
            current.body.wall?.photos.filter((photo) => photo.cleanOf === undefined) ?? [];
          // The first photo that can be cleaned at all, else the first one (the job then says it needs calibrating).
          photoId = (originals.find((photo) => photo.calibration !== undefined) ?? originals[0])
            ?.id;
          if (photoId === undefined) return failure('The wall has no photo to clean.');
        }
        const started = await api<{ job?: { id: string } } & ApiErrorReply>(
          'POST',
          '/api/jobs',
          {
            kind: 'photo.clean',
            wallId: env.wallId,
            input: {
              wallId: env.wallId,
              photoId,
              method: parsed.data.method,
              refresh: parsed.data.refresh,
            },
          },
          signal,
        );
        const jobId = started.body.job?.id;
        if (started.status >= 300 || jobId === undefined)
          return apiFailure(started.status, started.body);
        for (;;) {
          const polled = await api<
            {
              job?: { state: string; result?: JsonValue; error?: JsonValue };
            } & ApiErrorReply
          >('GET', `/api/jobs/${encodeURIComponent(jobId)}`, undefined, signal);
          const job = polled.body.job;
          if (polled.status !== 200 || job === undefined)
            return apiFailure(polled.status, polled.body);
          if (job.state === 'succeeded') return jsonResult(job.result ?? null);
          if (job.state === 'failed' || job.state === 'cancelled') {
            return failure(`Cleaning ${job.state}: ${JSON.stringify(job.error ?? null)}`);
          }
          await new Promise((resolve) => setTimeout(resolve, CLEAN_POLL_MS));
          if (signal?.aborted) return failure('Cancelled.');
        }
      },
    };

    const requestInput: HostTool = {
      definition: {
        name: 'wall_request_input',
        label: 'Wall: ask the user',
        description:
          "Open an input widget in the editor and wait for the user's answer. kind dimension: numeric fields in mm (give fitted/suggested values and min/max); variant: choose among candidate bank elements; compare: compare reference models (modelRefIds from the wall); calibration: calibrate a photo. Use it when the answer changes the result and cannot be read from the photo or the wall. Returns the answer JSON, or status cancelled if the user dismissed it. Wall edits that follow from the answer are made by the editor or by you after reading it. For a plain question use the ask tool instead.",
        parameters: jsonSchemaOf(RequestInputArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = RequestInputArgsSchema.safeParse(args);
        if (!parsed.success)
          return failure(`Invalid wall_request_input arguments: ${formatIssues(parsed.error)}`);
        const created = await api<{ request: InputRequest } & ApiErrorReply>(
          'POST',
          `${wallPath}/requests`,
          { request: parsed.data.request, actor: AGENT_ACTOR },
          signal,
        );
        if (created.status !== 201) return apiFailure(created.status, created.body);
        const { id } = created.body.request;
        const resolved = await awaitRequest(
          `${wallPath}/requests/${encodeURIComponent(id)}`,
          signal,
        );
        if (resolved === null) {
          await api('POST', `${wallPath}/requests/${encodeURIComponent(id)}/cancel`, {
            actor: AGENT_ACTOR,
          }).catch(() => null);
          return failure('Cancelled before the user answered.');
        }
        return resolved.status === 'answered'
          ? jsonResult(
              { status: 'answered', answer: resolved.answer ?? null },
              { details: { requestId: id, kind: resolved.kind } },
            )
          : jsonResult({
              status: resolved.status,
              note: 'The user dismissed the widget; do not repeat the same request.',
            });
      },
    };

    const analyseHang: HostTool = {
      definition: {
        name: 'wall_analyse_hang',
        label: 'Wall: analyse hang',
        description:
          'Analyse how the tools hang on their holders, physically (mass and centre of gravity against the real holder geometry): per tool a stability score and status (stable|marginal|unstable), problems such as levitating above the holder, not seated, falls, tips, swings, slides off, needs retention, overloaded holder, and removal ergonomics (blocked by neighbours, needs a tilt, needs two hands, cramped), each with an English sentence. Tools that overhang the board edge are fine; only physics is judged. Without itemId the whole wall is analysed, with itemId one tool. Tools without a holder (parentId) or a tool model are listed under skipped.',
        parameters: jsonSchemaOf(AnalyseHangArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = AnalyseHangArgsSchema.safeParse(args);
        if (!parsed.success) return failure(formatIssues(parsed.error));
        const { itemId } = parsed.data;
        const path =
          itemId === undefined
            ? `${wallPath}/physics`
            : `${wallPath}/items/${encodeURIComponent(itemId)}/physics`;
        const reply = await api<WallPhysicsReply & ApiErrorReply>('GET', path, undefined, signal);
        if (reply.status !== 200) return apiFailure(reply.status, reply.body);
        return jsonResult(reply.body, {
          details: {
            rev: reply.body.rev ?? null,
            tools: reply.body.tools?.length ?? 0,
            flagged: reply.body.flagged ?? 0,
          },
        });
      },
    };

    /** Long-poll the request until it is resolved; null when `signal` aborts first. */
    async function awaitRequest(path: string, signal: AbortSignal): Promise<InputRequest | null> {
      while (!signal.aborted) {
        let reply: ApiReply<{ request: InputRequest } & ApiErrorReply>;
        try {
          reply = await api('GET', `${path}?wait=${REQUEST_POLL_MS}`, undefined, signal);
        } catch (error) {
          if (signal.aborted) return null;
          throw error;
        }
        if (reply.status !== 200)
          throw new Error(reply.body.error?.message ?? `request poll failed (${reply.status})`);
        if (reply.body.request.status !== 'open') return reply.body.request;
      }
      return null;
    }

    async function describeRemovals(
      path: string,
      ops: readonly Op[],
      removals: number,
      signal: AbortSignal,
    ): Promise<string> {
      const ids: string[] = [];
      const collect = (list: readonly Op[]): void => {
        for (const op of list) {
          if (op.type === 'batch') collect(op.ops);
          else if (op.type === 'removeItem') ids.push(op.id);
        }
      };
      collect(ops);
      const reply = await api<WallResponse & ApiErrorReply>('GET', path, undefined, signal).catch(
        () => null,
      );
      const labels = new Map(
        reply?.status === 200
          ? reply.body.wall.items.map((item) => [item.id, item.label ?? item.bankId ?? item.kind])
          : [],
      );
      const named = ids.slice(0, 8).map((id) => `${labels.get(id) ?? '?'} (${id})`);
      const more = removals > named.length ? `, … and ${removals - named.length} more` : '';
      return `${named.join(', ')}${more}`;
    }

    return [
      wallGet,
      wallApply,
      wallUndo,
      bankSearch,
      wallSelect,
      wallView,
      requestInput,
      analyseHang,
      cleanBackground,
    ];
  };
}

// ---- Compact views -----------------------------------------------------------------------------------------

function compactWall(wall: Wall): JsonObject {
  return {
    id: wall.id,
    name: wall.name,
    rev: wall.rev,
    board: { ...wall.board },
    items: wall.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      ...(item.bankId !== undefined ? { bankId: item.bankId } : {}),
      ...(item.variantId !== undefined ? { variantId: item.variantId } : {}),
      ...(item.cell !== undefined ? { cell: { ...item.cell } } : {}),
      rotZ: item.pose.rotZ,
      ...(item.label !== undefined ? { label: item.label } : {}),
      ...(item.locked ? { locked: true } : {}),
    })),
    photos: wall.photos.map((photo) => ({ id: photo.id, name: photo.name ?? photo.file })),
    models: wall.models.map((model) => ({
      id: model.id,
      label: model.label,
      status: model.status,
    })),
  };
}

/** The subset of a bank element the agent needs; tolerant of the bank schema growing. */
interface BankElementView {
  readonly id: string;
  readonly name: { readonly ru: string; readonly en: string };
  readonly category: string;
  readonly dimsMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly footprint?: { readonly cells: readonly unknown[] };
  readonly mounting?: { readonly kind: string };
  readonly family?: string;
  readonly variantLabel?: string;
  readonly params?: readonly {
    readonly key: string;
    readonly label?: string;
    readonly unit?: string;
    readonly min: number;
    readonly max: number;
    readonly default: number;
  }[];
}

interface BankElementSummary {
  readonly id: string;
  readonly score: number;
  readonly name: { readonly ru: string; readonly en: string };
  readonly category: string;
  readonly dimsMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly cells?: number;
  readonly mounting?: string;
  readonly family?: string;
  readonly variant?: string;
  readonly params?: readonly {
    readonly key: string;
    readonly min: number;
    readonly max: number;
    readonly default: number;
    readonly unit?: string;
  }[];
}

function summariseElement(element: BankElementView, score: number): BankElementSummary {
  return {
    id: element.id,
    score: Math.round(score * 100) / 100,
    name: element.name,
    category: element.category,
    dimsMm: element.dimsMm,
    ...(element.footprint ? { cells: element.footprint.cells.length } : {}),
    ...(element.mounting ? { mounting: element.mounting.kind } : {}),
    ...(element.family ? { family: element.family } : {}),
    ...(element.variantLabel ? { variant: element.variantLabel } : {}),
    ...(element.params && element.params.length > 0
      ? {
          params: element.params.map(({ key, min, max, default: def, unit }) => ({
            key,
            min,
            max,
            default: def,
            ...(unit !== undefined ? { unit } : {}),
          })),
        }
      : {}),
  };
}
