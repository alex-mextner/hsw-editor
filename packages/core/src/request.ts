/**
 * Input requests: an agent or job asks the human a question while it works (enter a dimension, pick a
 * variant, compare candidate models, calibrate a photo). The UI renders a widget from the request, the
 * human answers, and the waiting agent gets the answer back. See docs/api.md, "Input requests".
 *
 * Requests are not wall ops: they never change the wall and are not part of undo history. The UI applies
 * the resulting wall edits itself via `/ops` first and then answers, so the answer is only what the agent
 * needs to know.
 */
import { z } from 'zod';
import type { JsonValue } from './json.ts';
import { ActorSchema, IdSchema, newId } from './schema.ts';

export const REQUEST_KINDS = ['dimension', 'variant', 'compare', 'calibration'] as const;
export const REQUEST_STATUSES = ['open', 'answered', 'cancelled'] as const;

const text = (max: number) => z.string().min(1).max(max);

export const DimensionFieldSchema = z.strictObject({
  /** Param key (as in `setParams`), e.g. `length`. */
  key: text(64),
  label: text(120).optional(),
  unit: z.literal('mm').default('mm'),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Value measured by the fitter. */
  fitted: z.number().optional(),
  /** Value the asker proposes as default. */
  suggested: z.number().optional(),
});

export const VariantCandidateSchema = z.strictObject({
  id: text(120),
  bankId: text(120).optional(),
  label: text(200),
  score: z.number().min(0).max(1).optional(),
});

const requestBase = {
  itemId: IdSchema.optional(),
  photoId: IdSchema.optional(),
  title: text(200).optional(),
  prompt: z.string().max(2000).optional(),
} as const;

const DimensionPayload = z.strictObject({ fields: z.array(DimensionFieldSchema).min(1).max(40) });
const VariantPayload = z.strictObject({
  candidates: z.array(VariantCandidateSchema).min(1).max(100),
});
/** Candidates are `wall.models` entries. */
const ComparePayload = z.strictObject({ modelRefIds: z.array(IdSchema).min(2).max(12) });
const CalibrationPayload = z.strictObject({
  photoId: IdSchema,
  mode: z.enum(['two-point', 'corners', 'grid']),
});

/** What a client sends to open a request (server fills id/status/createdBy/createdAt). */
export const NewInputRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('dimension'), ...requestBase, payload: DimensionPayload }),
  z.strictObject({ kind: z.literal('variant'), ...requestBase, payload: VariantPayload }),
  z.strictObject({ kind: z.literal('compare'), ...requestBase, payload: ComparePayload }),
  z.strictObject({ kind: z.literal('calibration'), ...requestBase, payload: CalibrationPayload }),
]);
export type NewInputRequest = z.infer<typeof NewInputRequestSchema>;

export const CreateRequestBodySchema = z.strictObject({
  request: NewInputRequestSchema,
  /** Who is asking; defaults to `{kind:'agent'}`. */
  actor: ActorSchema.optional(),
});
export type CreateRequestBody = z.infer<typeof CreateRequestBodySchema>;

export const AnswerRequestBodySchema = z.strictObject({
  /** Free-form JSON: this is exactly what the waiting agent receives. */
  answer: z.json(),
  actor: ActorSchema.optional(),
});
export type AnswerRequestBody = z.infer<typeof AnswerRequestBodySchema>;

export const CancelRequestBodySchema = z.strictObject({ actor: ActorSchema.optional() });
export type CancelRequestBody = z.infer<typeof CancelRequestBodySchema>;

const requestMeta = {
  id: IdSchema,
  status: z.enum(REQUEST_STATUSES),
  createdBy: ActorSchema,
  createdAt: z.string(),
  resolvedBy: ActorSchema.optional(),
  resolvedAt: z.string().optional(),
  answer: z.json().optional(),
} as const;

/** A stored request: the new-request shape plus bookkeeping. */
export const InputRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('dimension'),
    ...requestBase,
    ...requestMeta,
    payload: DimensionPayload,
  }),
  z.strictObject({
    kind: z.literal('variant'),
    ...requestBase,
    ...requestMeta,
    payload: VariantPayload,
  }),
  z.strictObject({
    kind: z.literal('compare'),
    ...requestBase,
    ...requestMeta,
    payload: ComparePayload,
  }),
  z.strictObject({
    kind: z.literal('calibration'),
    ...requestBase,
    ...requestMeta,
    payload: CalibrationPayload,
  }),
]);
export type InputRequest = z.infer<typeof InputRequestSchema>;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export function newRequestId(): string {
  return newId('r');
}

export interface RequestInputEvent {
  request: InputRequest;
}

export interface RequestResolvedEvent {
  id: string;
  status: 'answered' | 'cancelled';
  answer?: JsonValue;
}
