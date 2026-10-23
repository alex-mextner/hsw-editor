/**
 * Server-driven input requests: an agent (or the vision service) asks the human to answer something
 * the UI can show as a small widget (fit a dimension, pick a variant, compare candidate models,
 * calibrate a photo). Wire contract agreed with the server; when `packages/core` exports the same
 * schemas this file is the single place to swap them in.
 *
 * Parsing is deliberately tolerant: one malformed request must not hide the others, and the SSE
 * handlers drop what they cannot read instead of throwing.
 */
import type { JsonValue } from '@hsw-editor/core';
import { z } from 'zod';
import { HUMAN, fetchJson } from './http.ts';

export const REQUEST_KINDS = ['dimension', 'variant', 'compare', 'calibration'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const RequestStatusSchema = z.enum(['open', 'answered', 'cancelled']);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

const ActorLikeSchema = z.object({
  kind: z.enum(['human', 'agent', 'cli']),
  name: z.string().optional(),
});
export type RequestActor = z.infer<typeof ActorLikeSchema>;

const DimensionFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  unit: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** Value measured from the photo by the fit. */
  fitted: z.number().optional(),
  /** Value the asker proposes (e.g. a standard size). */
  suggested: z.number().optional(),
});
export type DimensionField = z.infer<typeof DimensionFieldSchema>;

const VariantCandidateSchema = z.object({
  id: z.string().min(1),
  bankId: z.string().optional(),
  label: z.string(),
  score: z.number().min(0).max(1).optional(),
});
export type VariantCandidate = z.infer<typeof VariantCandidateSchema>;

const base = {
  id: z.string().min(1),
  status: RequestStatusSchema,
  itemId: z.string().optional(),
  photoId: z.string().optional(),
  title: z.string().optional(),
  prompt: z.string().optional(),
  createdBy: ActorLikeSchema.default({ kind: 'agent' }),
  createdAt: z.union([z.string(), z.number()]).default(0),
} as const;

export const InputRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('dimension'),
    payload: z.object({ fields: z.array(DimensionFieldSchema) }),
  }),
  z.object({
    ...base,
    kind: z.literal('variant'),
    payload: z.object({ candidates: z.array(VariantCandidateSchema) }),
  }),
  z.object({
    ...base,
    kind: z.literal('compare'),
    payload: z.object({ modelRefIds: z.array(z.string()) }),
  }),
  z.object({
    ...base,
    kind: z.literal('calibration'),
    payload: z.object({
      photoId: z.string().min(1),
      mode: z.enum(['two-point', 'corners', 'grid']).default('two-point'),
    }),
  }),
]);
export type InputRequest = z.infer<typeof InputRequestSchema>;
export type RequestOfKind<K extends RequestKind> = Extract<InputRequest, { kind: K }>;

/** SSE `request_input`: a new (or re-announced) request. */
export const RequestInputEventSchema = z.object({ request: InputRequestSchema });
/** SSE `request_resolved`: answered or cancelled by anyone (another tab, the agent timing out...). */
export const RequestResolvedEventSchema = z.object({
  id: z.string().min(1),
  status: RequestStatusSchema,
});

const requestsPath = (wallId: string): string =>
  `/api/walls/${encodeURIComponent(wallId)}/requests`;

export function postJson(path: string, body: unknown): Promise<unknown> {
  return fetchJson(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const RequestListSchema = z.object({ requests: z.array(z.unknown()) });

/** Open requests of a wall; entries this build cannot read (unknown kind, bad payload) are skipped. */
export async function listOpenRequests(wallId: string): Promise<InputRequest[]> {
  const json = await fetchJson(`${requestsPath(wallId)}?status=open`);
  const list = RequestListSchema.safeParse(json);
  if (!list.success) return [];
  const requests: InputRequest[] = [];
  for (const entry of list.data.requests) {
    const parsed = InputRequestSchema.safeParse(entry);
    if (parsed.success && parsed.data.status === 'open') requests.push(parsed.data);
  }
  return requests;
}

/** Wall edits are applied by the UI first (`submitOps`); the answer only tells the asker what happened. */
export async function answerRequest(
  wallId: string,
  requestId: string,
  answer: JsonValue,
): Promise<void> {
  await postJson(`${requestsPath(wallId)}/${encodeURIComponent(requestId)}/answer`, {
    answer,
    actor: HUMAN,
  });
}

export async function cancelRequest(wallId: string, requestId: string): Promise<void> {
  await postJson(`${requestsPath(wallId)}/${encodeURIComponent(requestId)}/cancel`, {
    actor: HUMAN,
  });
}
