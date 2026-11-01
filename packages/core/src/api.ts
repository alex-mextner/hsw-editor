/**
 * Wire types of the REST/SSE API (see docs/api.md). Request bodies are validated with these schemas on
 * the server; the web app, the CLI bridge and agents import the types instead of re-modelling them.
 */
import { z } from 'zod';
import { type WallWarning } from './ops.ts';
import type { RequestInputEvent, RequestResolvedEvent } from './request.ts';
import {
  ActorSchema,
  BoardSchema,
  IdSchema,
  type ModelRef,
  OpSchema,
  type Op,
  type Photo,
  WallSchema,
  type Wall,
} from './schema.ts';

export const HistoryEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    rev: z.number().int().min(0),
    ts: z.string(),
    actor: ActorSchema,
    /** Initial document; replaying history starts here. */
    wall: WallSchema,
  }),
  z.strictObject({
    kind: z.enum(['op', 'undo', 'redo']),
    rev: z.number().int().min(1),
    ts: z.string(),
    actor: ActorSchema,
    /** What was applied to the wall at `rev` (for undo: the stored inverse of `ref`). */
    op: OpSchema,
    /** Restores the wall as it was before `rev`. */
    inverse: OpSchema,
    /** Entry undone/redone by an `undo`/`redo`. */
    ref: z.number().int().min(0).optional(),
    label: z.string().max(200).optional(),
  }),
]);
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
export type ChangeEntry = Extract<HistoryEntry, { kind: 'op' | 'undo' | 'redo' }>;

export const WallSummarySchema = z.strictObject({
  id: IdSchema,
  name: z.string(),
  rev: z.number().int(),
  items: z.number().int(),
  photos: z.number().int(),
  models: z.number().int(),
  updatedAt: z.string(),
  /** A wall meant to be copied, not edited in place (a demo or showcase wall): the editor clones it on the first edit. */
  template: z.boolean().optional(),
});
export type WallSummary = z.infer<typeof WallSummarySchema>;

export const CreateWallBodySchema = z.strictObject({
  name: z.string().min(1).max(200),
  id: IdSchema.optional(),
  /** Missing fields fall back to DEFAULT_BOARD (48 x 32 cells, HSW pitch). */
  board: BoardSchema.partial().optional(),
  actor: ActorSchema.optional(),
});
export type CreateWallBody = z.infer<typeof CreateWallBodySchema>;

export const OpsBodySchema = z.strictObject({
  ops: z.array(OpSchema).min(1).max(5000),
  /** Fail with 409 `rev_conflict` unless the wall is at exactly this rev. */
  baseRev: z.number().int().min(0).optional(),
  actor: ActorSchema.optional(),
  /** Label of the wrapping batch when more than one op is sent. */
  label: z.string().min(1).max(200).optional(),
});
export type OpsBody = z.infer<typeof OpsBodySchema>;

export const UndoBodySchema = z.strictObject({
  baseRev: z.number().int().min(0).optional(),
  actor: ActorSchema.optional(),
});
export type UndoBody = z.infer<typeof UndoBodySchema>;

export interface ApplyResponse {
  rev: number;
  /** False when every op was a no-op: nothing was written and `rev` did not move. */
  changed: boolean;
  op: Op;
  inverse: Op;
  wall: Wall;
  warnings: WallWarning[];
  canUndo: boolean;
  canRedo: boolean;
}

export interface WallResponse {
  wall: Wall;
  warnings: WallWarning[];
  canUndo: boolean;
  canRedo: boolean;
  /** Present (true) for a template wall, see `WallSummary.template`. */
  template?: boolean;
}

export interface PhotoUploadResponse {
  photo: Photo;
  rev: number;
  wall: Wall;
}

export interface ModelUploadResponse {
  model: ModelRef;
  rev: number;
  wall: Wall;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface RevConflictBody extends ApiErrorBody {
  wall: Wall;
  currentRev: number;
}

export interface WallExport {
  format: 'hsw-editor-wall';
  version: 1;
  wall: Wall;
  history: HistoryEntry[];
}

/** SSE event names of `/api/walls/:id/events`, with their `data` payloads. */
export interface WallEventMap {
  snapshot: { wall: Wall };
  op: ChangeEntry;
  heartbeat: { rev: number };
  deleted: Record<string, never>;
  /** Not tied to a rev: no SSE `id`. Open requests are re-sent after every (re)connect. */
  request_input: RequestInputEvent;
  request_resolved: RequestResolvedEvent;
}
