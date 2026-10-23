/**
 * Typed client of the tool routes (`/api/tools/*`, contract in docs/api.md#tools). Bodies are parsed with
 * the shared zod schemas of `@hsw-editor/tools/contract` (custom tool, import draft) or the narrow ones
 * below (class listing, holding interface, summaries). Failures surface as `ApiError` / `NetworkError`.
 */
import { CustomToolSchema, DraftSchema } from '@hsw-editor/tools/contract';
import type { CustomTool, Draft, DraftObjectPatch } from '@hsw-editor/tools/contract';
import { z } from 'zod';
import { fetchJson } from '@/api/http.ts';
import { postJson } from '@/api/requests.ts';

export const TOOLS_ANALYZE_JOB = 'tools.analyze';

const LabelSchema = z.object({ en: z.string(), ru: z.string() });
export type Label = z.infer<typeof LabelSchema>;

const ParamSpecSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('num'),
    min: z.number(),
    max: z.number(),
    def: z.number(),
    step: z.number(),
    unit: z.enum(['mm', 'deg', 'count', 'ratio']),
    label: LabelSchema,
    dimension: z.boolean(),
  }),
  z.object({
    kind: z.literal('choice'),
    options: z.array(z.string()),
    def: z.string(),
    label: LabelSchema,
  }),
  z.object({ kind: z.literal('color'), def: z.string(), label: LabelSchema }),
]);
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

const ParamValuesSchema = z.record(z.string(), z.union([z.number(), z.string()]));
export type ParamValues = z.infer<typeof ParamValuesSchema>;

const DimsSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });
const HoldingDimsSchema = z.record(z.string(), z.number());

export const ToolClassInfoSchema = z.object({
  id: z.string(),
  family: z.string(),
  familyLabel: LabelSchema,
  name: LabelSchema,
  bankClass: z.string(),
  keywords: z.object({ en: z.array(z.string()), ru: z.array(z.string()) }),
  schema: z.record(z.string(), ParamSpecSchema),
  presets: z.array(z.object({ id: z.string(), label: LabelSchema, values: ParamValuesSchema })),
  /** Bounding box of the default build: width, length, thickness (mm). */
  dimsMm: DimsSchema,
  /** Measured class dimensions (`shaftDiameter`, ...) of the default build, the keys of holder `fitsTool.dims`. */
  holdingDims: HoldingDimsSchema,
});
export type ToolClassInfo = z.infer<typeof ToolClassInfoSchema>;

export const ToolSummarySchema = z.object({
  id: z.string(),
  name: z.object({ en: z.string().optional(), ru: z.string().optional() }),
  classId: z.string().nullable(),
  bankClass: z.string().nullable(),
  dimensionsMm: z.object({
    length: z.number(),
    width: z.number(),
    thickness: z.number(),
    source: z.enum(['photo', 'user']),
  }),
  dimsMm: DimsSchema,
  holdingDims: HoldingDimsSchema,
  tags: z.array(z.string()),
  confidence: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  triangles: z.number(),
});
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

const SectionSampleSchema = z.object({
  y: z.number(),
  w: z.number(),
  t: z.number(),
  r: z.number(),
});
const V3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const HoldingResponseSchema = z.object({
  holding: z.object({
    axis: z.object({ origin: V3Schema, direction: V3Schema }),
    lengthMm: z.number(),
    hang: z
      .object({
        point: V3Schema,
        kind: z.enum(['hole', 'loop', 'butt', 'head', 'body', 'neck']),
        diameterMm: z.number().optional(),
      })
      .nullable(),
    zones: z.array(z.object({ name: z.string(), y0: z.number(), y1: z.number() }).loose()),
    profile: z.object({ stepMm: z.number(), samples: z.array(SectionSampleSchema) }),
    maxSection: SectionSampleSchema,
    dims: HoldingDimsSchema,
  }),
  bboxMm: z.object({ min: V3Schema, max: V3Schema }),
  bankClass: z.string().nullable(),
});
export type HoldingResponse = z.infer<typeof HoldingResponseSchema>;

export const toolRoutes = {
  classes: '/api/tools/classes',
  classThumb: (id: string, preset?: string): string =>
    `/api/tools/classes/${encodeURIComponent(id)}/thumb.webp${
      preset === undefined ? '' : `?preset=${encodeURIComponent(preset)}`
    }`,
  classGlb: (id: string, values: ParamValues, lod: 0 | 1 = 1): string =>
    `/api/tools/classes/${encodeURIComponent(id)}/model.glb?lod=${lod}&p=${encodeURIComponent(
      JSON.stringify(values),
    )}`,
  classHolding: (id: string, values: ParamValues): string =>
    `/api/tools/classes/${encodeURIComponent(id)}/holding?p=${encodeURIComponent(JSON.stringify(values))}`,
  list: '/api/tools',
  tool: (id: string): string => `/api/tools/${encodeURIComponent(id)}`,
  toolThumb: (id: string, version: string): string =>
    `/api/tools/${encodeURIComponent(id)}/thumb.webp?v=${encodeURIComponent(version)}`,
  toolGlb: (id: string, version: string, lod: 0 | 1 = 0): string =>
    `/api/tools/${encodeURIComponent(id)}/${lod === 0 ? 'model.glb' : 'model-lod1.glb'}?v=${encodeURIComponent(version)}`,
  toolHolding: (id: string): string => `/api/tools/${encodeURIComponent(id)}/holding`,
  drafts: '/api/tools/drafts',
  draft: (id: string): string => `/api/tools/drafts/${encodeURIComponent(id)}`,
  draftFile: (id: string, file: string): string =>
    `/api/tools/drafts/${encodeURIComponent(id)}/files/${file
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
} as const;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const ClassesSchema = z.object({ classes: z.array(ToolClassInfoSchema) });
const ToolsSchema = z.object({ tools: z.array(ToolSummarySchema) });
const ToolSchema = z.object({ tool: CustomToolSchema });
const DraftEnvelopeSchema = z.object({ draft: DraftSchema });
const JobStartSchema = z.object({ job: z.object({ id: z.string().min(1) }).loose() });
const CommitSchema = z.object({
  tools: z.array(ToolSummarySchema),
  skipped: z.array(z.object({ key: z.string(), reason: z.string() })),
  draft: DraftSchema,
});
export type CommitResult = z.infer<typeof CommitSchema>;

export async function fetchClasses(): Promise<ToolClassInfo[]> {
  return ClassesSchema.parse(await fetchJson(toolRoutes.classes)).classes;
}

export async function fetchTools(): Promise<ToolSummary[]> {
  return ToolsSchema.parse(await fetchJson(toolRoutes.list)).tools;
}

export async function fetchTool(id: string): Promise<CustomTool> {
  return ToolSchema.parse(await fetchJson(toolRoutes.tool(id))).tool;
}

export async function fetchClassHolding(
  classId: string,
  values: ParamValues,
  signal?: AbortSignal,
): Promise<HoldingResponse> {
  return HoldingResponseSchema.parse(
    await fetchJson(toolRoutes.classHolding(classId, values), signal ? { signal } : undefined),
  );
}

export async function fetchToolHolding(id: string, signal?: AbortSignal): Promise<HoldingResponse> {
  return HoldingResponseSchema.parse(
    await fetchJson(toolRoutes.toolHolding(id), signal ? { signal } : undefined),
  );
}

export interface ToolPatch {
  readonly name?: Partial<Label>;
  readonly classId?: string | null;
  readonly params?: ParamValues;
  readonly partColors?: Record<string, string>;
  readonly dimensionsMm?: { length?: number; width?: number; thickness?: number };
  readonly tags?: readonly string[];
  readonly notes?: string;
}

export async function patchTool(id: string, patch: ToolPatch): Promise<CustomTool> {
  return ToolSchema.parse(
    await fetchJson(toolRoutes.tool(id), {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    }),
  ).tool;
}

export async function deleteTool(id: string): Promise<void> {
  await fetchJson(toolRoutes.tool(id), { method: 'DELETE' });
}

/** Saves a built-in class with chosen parameters to the user library. */
export async function createClassTool(input: {
  readonly classId: string;
  readonly params?: ParamValues;
  readonly name?: Partial<Label>;
  readonly tags?: readonly string[];
}): Promise<CustomTool> {
  return ToolSchema.parse(await postJson(toolRoutes.list, input)).tool;
}

// ---- import drafts ------------------------------------------------------------------------------

export type DraftMode = 'single' | 'multi';
export type CalibrationInput =
  | { readonly mmPerPx: number }
  | {
      readonly pointsPx: readonly [readonly [number, number], readonly [number, number]];
      readonly distanceMm: number;
    };

export async function createDraft(input: {
  readonly files: readonly File[];
  readonly mode: DraftMode;
  readonly calibration: CalibrationInput | null;
  readonly signal?: AbortSignal;
}): Promise<Draft> {
  const form = new FormData();
  for (const file of input.files) form.append('photo', file);
  form.set('mode', input.mode);
  if (input.calibration) form.set('calibration', JSON.stringify(input.calibration));
  const json = await fetchJson(toolRoutes.drafts, {
    method: 'POST',
    body: form,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return DraftEnvelopeSchema.parse(json).draft;
}

export async function fetchDraft(id: string): Promise<Draft> {
  return DraftEnvelopeSchema.parse(await fetchJson(toolRoutes.draft(id))).draft;
}

export async function deleteDraft(id: string): Promise<void> {
  await fetchJson(toolRoutes.draft(id), { method: 'DELETE' });
}

export async function startAnalyzeJob(draftId: string): Promise<string> {
  const json = await postJson('/api/jobs', { kind: TOOLS_ANALYZE_JOB, input: { draftId } });
  return JobStartSchema.parse(json).job.id;
}

export async function patchDraftObject(
  draftId: string,
  key: string,
  patch: DraftObjectPatch,
): Promise<Draft> {
  return DraftEnvelopeSchema.parse(
    await fetchJson(`${toolRoutes.draft(draftId)}/objects/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    }),
  ).draft;
}

export async function groupDraftObjects(draftId: string, keys: readonly string[]): Promise<Draft> {
  return DraftEnvelopeSchema.parse(await postJson(`${toolRoutes.draft(draftId)}/group`, { keys }))
    .draft;
}

export async function mergeDraftObjects(draftId: string, keys: readonly string[]): Promise<Draft> {
  return DraftEnvelopeSchema.parse(await postJson(`${toolRoutes.draft(draftId)}/merge`, { keys }))
    .draft;
}

export async function splitDraftObject(draftId: string, key: string, n: number): Promise<Draft> {
  return DraftEnvelopeSchema.parse(await postJson(`${toolRoutes.draft(draftId)}/split`, { key, n }))
    .draft;
}

export async function recalibrateDraft(
  draftId: string,
  calibration: CalibrationInput,
): Promise<Draft> {
  return DraftEnvelopeSchema.parse(
    await postJson(`${toolRoutes.draft(draftId)}/calibration`, calibration),
  ).draft;
}

export async function commitDraft(
  draftId: string,
  input: { readonly keys?: readonly string[]; readonly tags?: readonly string[] },
): Promise<CommitResult> {
  return CommitSchema.parse(await postJson(`${toolRoutes.draft(draftId)}/commit`, input));
}


const VisionStatusSchema = z.object({
  available: z.boolean(),
  url: z.string().optional(),
  message: z.string().optional(),
});
export type VisionStatus = z.infer<typeof VisionStatusSchema>;

/** Whether the vision sidecar answers right now; a daemon without the route (older build) counts as not available. */
export async function fetchVisionStatus(signal?: AbortSignal): Promise<VisionStatus> {
  try {
    return VisionStatusSchema.parse(
      await fetchJson('/api/tools/vision', signal ? { signal } : undefined),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return { available: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export { fetchJob, jobErrorText, type Job } from '@/widgets/calibrationJob.ts';
