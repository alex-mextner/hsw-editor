/**
 * Host tools that let omp edit the open wall through the same REST op stream the human uses.
 *
 * Every mutation goes over the daemon's own HTTP API (`docs/api.md`) with `actor = { kind: 'agent', name: 'omp' }`,
 * so it is validated by the single reducer, appended to the wall history, broadcast over SSE to the page and
 * undoable like any other edit. Argument schemas are the zod schemas of `packages/core`.
 */
import {
  type ApplyResponse,
  type InputRequest,
  NewInputRequestSchema,
  type Op,
  type Wall,
  type WallResponse,
  OpsBodySchema,
} from '@hsw-editor/core';
import type { JsonObject, JsonValue, OmpToolResult } from '@hsw-editor/omp-protocol';
import { z } from 'zod';
import type { OmpConfig } from './config.ts';
import type { HostTool, ToolEnv, ToolFactory } from './tool-types.ts';

export const AGENT_ACTOR = { kind: 'agent', name: 'omp' } as const;

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

function text(
  value: JsonValue | object,
  extra: { details?: JsonValue; isError?: boolean } = {},
): OmpToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(extra.details !== undefined ? { details: extra.details } : {}),
    ...(extra.isError ? { isError: true } : {}),
  };
}

function failure(message: string, details?: JsonValue): OmpToolResult {
  return text(message, { isError: true, ...(details !== undefined ? { details } : {}) });
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(args)'}: ${issue.message}`)
    .join('; ');
}

function jsonSchemaOf(schema: z.ZodType): JsonObject {
  // z.toJSONSchema output is plain JSON; the cast only bridges zod's loose return type to JsonObject.
  const generated = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonObject;
  const { $schema: _dropped, ...rest } = generated;
  return rest;
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
const RequestInputArgsSchema = z.strictObject({ request: NewInputRequestSchema });

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
        return text(body, { details: { rev: wall.rev, items: wall.items.length } });
      },
    };

    const wallApply: HostTool = {
      definition: {
        name: 'wall_apply',
        label: 'Wall: apply ops',
        description:
          'Apply one or more ops to the open wall as a single atomic batch (one rev, one undo step), attributed to you (agent omp). Op types: addItem, moveItem, rotateItem, setParams, removeItem, setVariant, lock, addPhoto, removePhoto, setCalibration, setBoard, rename, addModelRef, updateModelRef, removeModelRef. Omitted item ids are generated and returned. Pass baseRev from wall_get to detect concurrent edits by the user. Removing more items than the configured threshold needs the user to approve.',
        parameters: jsonSchemaOf(ApplyArgsSchema),
      },
      async execute(args, { signal }) {
        const parsed = ApplyArgsSchema.safeParse(args);
        if (!parsed.success)
          return failure(`Invalid wall_apply arguments: ${formatIssues(parsed.error)}`);
        const { ops, baseRev, label } = parsed.data;
        const removals = countRemovals(ops);
        const decision = decideDestructive(env.config, removals);
        if (decision === 'refuse') {
          return failure(
            `Refused: removing ${removals} elements exceeds the limit of ${env.config.destructiveThreshold} and the user's settings forbid bulk removal by the agent.`,
          );
        }
        if (decision === 'ask') {
          const summary = await describeRemovals(wallPath, ops, removals, signal);
          const answer = await env.prompts.ask(
            'wall_apply',
            {
              kind: 'destructive_ops',
              title: `Remove ${removals} elements?`,
              summary,
              removeCount: removals,
              opCount: ops.length,
            },
            signal,
          );
          if (!('approved' in answer) || !answer.approved) {
            return failure(
              'The user declined this removal. Do not retry it; ask what they want instead.',
            );
          }
        }
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
        return text(result, { details: { rev, changed, opCount: ops.length, removals } });
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
        let last: ApplyResponse | null = null;
        for (let step = 0; step < steps; step += 1) {
          const reply = await api<ApplyResponse & ApiErrorReply>(
            'POST',
            `${wallPath}/${redo ? 'redo' : 'undo'}`,
            { ...(step === 0 && baseRev !== undefined ? { baseRev } : {}), actor: AGENT_ACTOR },
            signal,
          );
          if (reply.status !== 200) {
            const failed = apiFailure(reply.status, reply.body);
            return last === null
              ? failed
              : text(
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
          : text(
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
        return text({ count: results.length, results }, { details: { count: results.length } });
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
          ? text({ ok: true, selected: result.selected })
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
          ? text(
              { status: 'answered', answer: resolved.answer ?? null },
              { details: { requestId: id, kind: resolved.kind } },
            )
          : text({
              status: resolved.status,
              note: 'The user dismissed the widget; do not repeat the same request.',
            });
      },
    };

    /** Long-poll the request until it is resolved; null when `signal` aborts first. */
    async function awaitRequest(path: string, signal: AbortSignal): Promise<InputRequest | null> {
      while (!signal.aborted) {
        const reply = await api<{ request: InputRequest } & ApiErrorReply>(
          'GET',
          `${path}?wait=${REQUEST_POLL_MS}`,
          undefined,
          signal,
        ).catch(() => null);
        if (reply === null) return null;
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

    return [wallGet, wallApply, wallUndo, bankSearch, wallSelect, wallView, requestInput];
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
