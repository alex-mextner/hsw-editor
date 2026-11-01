/** Response envelopes of the REST/SSE API (docs/api.md). Walls and ops are validated by packages/core. */
import { z } from 'zod';
import {
  HistoryEntrySchema,
  OpSchema,
  PhotoSchema,
  WallSchema,
  WallSummarySchema,
} from '@hsw-editor/core';
import type { ChangeEntry } from '@hsw-editor/core';

export { HistoryEntrySchema, WallSummarySchema };
export type { HistoryEntry, WallSummary } from '@hsw-editor/core';

export const WarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  itemIds: z.array(z.string()),
});

export const WallListSchema = z.object({ walls: z.array(WallSummarySchema) });

export const WallResponseSchema = z.object({
  wall: WallSchema,
  canUndo: z.boolean(),
  canRedo: z.boolean(),
  warnings: z.array(WarningSchema),
  /** True for a template wall (a demo or showcase wall): the first edit clones it (`wall/fork.ts`). */
  template: z.boolean().optional(),
});
export type WallResponse = z.infer<typeof WallResponseSchema>;

export const CreateWallResponseSchema = z.object({ wall: WallSchema });

/** `POST /api/walls/:id/photos`: the stored photo and the wall that now contains it. */
export const PhotoUploadResponseSchema = z.object({ photo: PhotoSchema, wall: WallSchema });

export const OpResponseSchema = z.object({
  rev: z.number().int(),
  changed: z.boolean(),
  op: OpSchema,
  inverse: OpSchema,
  wall: WallSchema,
  warnings: z.array(WarningSchema),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});
export type OpResponse = z.infer<typeof OpResponseSchema>;

export const HistoryResponseSchema = z.object({ entries: z.array(HistoryEntrySchema) });
export type { ChangeEntry };

export const ConflictResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
  wall: WallSchema.optional(),
  currentRev: z.number().int().optional(),
});

export const ErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
