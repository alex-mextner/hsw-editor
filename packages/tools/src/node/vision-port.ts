/**
 * Port to the vision sidecar (`services/vision`, loopback FastAPI). The tool import never re-implements
 * segmentation, profile fitting or colour sampling: it consumes the `photo_to_objects` result (docs/vision.md)
 * and the object edit ops (merge / split / reprofile / add).
 */
import { z } from 'zod';
import type { CalibrationInput } from '../custom/draft.ts';

/** Sidecar JSON uses `null` for "not available" and sometimes omits the key. */
const Opt = <T extends z.ZodType>(t: T): z.ZodOptional<z.ZodNullable<T>> => t.nullable().optional();

export const SidecarObjectSchema = z.looseObject({
  id: z.number().int(),
  areaPx: z.number().optional(),
  bboxXywh: z.array(z.number()).length(4).optional(),
  mask: z.string().optional(),
  crop: Opt(z.looseObject({ path: z.string() })),
  cutout: Opt(z.string()),
  cropOriented: Opt(z.string()),
  cutoutOriented: Opt(z.string()),
  axis: Opt(z.looseObject({ deg: z.number() })),
  profile: Opt(
    z.looseObject({
      kind: z.string().optional(),
      length_mm: z.number(),
      max_width_mm: z.number().optional(),
      stations: z.array(z.looseObject({ t: z.number(), lo_mm: z.number(), hi_mm: z.number() })),
      iou_recon: z.number().optional(),
    }),
  ),
  mmPerPx: Opt(z.number()),
  class: Opt(
    z.looseObject({
      toolClass: Opt(z.string()),
      prob: z.number().optional(),
      topk: z
        .array(
          z.looseObject({
            toolClass: Opt(z.string()),
            label: z.string().optional(),
            score: z.number(),
          }),
        )
        .optional(),
    }),
  ),
  dimensionsMm: Opt(
    z.looseObject({
      length: z.number(),
      width: z.number(),
      thickness: z.number(),
    }),
  ),
  colours: Opt(
    z.looseObject({
      parts: z.array(
        z.looseObject({
          t0: z.number(),
          t1: z.number(),
          hex: z.string(),
          area_frac: z.number().optional(),
          role_guess: Opt(z.string()),
        }),
      ),
    }),
  ),
  embedding: Opt(z.looseObject({ file: z.string(), row: z.number().int(), dim: z.number().int() })),
  confidence: z.number().optional(),
  status: z.string().optional(),
});
export type SidecarObject = z.infer<typeof SidecarObjectSchema>;

export const SidecarResultSchema = z.looseObject({
  status: z.string(),
  outDir: z.string().optional(),
  calibration: Opt(
    z.looseObject({ method: z.string().optional(), mm_per_px: z.number().optional() }),
  ),
  overlay: Opt(z.looseObject({ segmentation: Opt(z.string()) })),
  objects: z.array(SidecarObjectSchema),
});
export type SidecarResult = z.infer<typeof SidecarResultSchema>;

const StreamEventSchema = z.looseObject({
  event: z.string(),
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.string().optional(),
      message: z.string().optional(),
      fix: z.string().optional(),
    })
    .optional(),
});

/** A progress event of the sidecar stream (`stage`, `progress`, `object`, ...): informational only. */
export interface VisionEvent {
  event?: string | undefined;
  type?: string | undefined;
  [key: string]: unknown;
}

export interface PhotoObjectsRequest {
  imagePath: string;
  outDir: string;
  calibration: CalibrationInput | null;
  /** Path of the class vocabulary (`classes.json`, [{ id, prompts }]). */
  categoriesPath: string;
  /** `single`: one dominant object per photo (fast u2net path). */
  mode: 'single' | 'multi';
  maxObjects?: number;
  signal?: AbortSignal;
  onEvent?: (event: VisionEvent) => void;
}

/** Whether an analysis can run now: the sidecar answers, or a request would start it. Never starts it itself. */
export interface VisionAvailability {
  available: boolean;
  /** Where the sidecar listens when it is running. */
  url?: string;
  /** Why not (and the step that fixes it) when `available` is false. */
  message?: string;
}

export interface VisionPort {
  /** Never starts the sidecar. */
  status(): Promise<VisionAvailability>;
  photoToObjects(request: PhotoObjectsRequest): Promise<SidecarResult>;
  /** Object edit ops on an existing result directory (sidecar `/objects/merge`, `/objects/split`, `/objects/add`). */
  mergeObjects(
    outDir: string,
    ids: readonly number[],
    signal?: AbortSignal,
  ): Promise<SidecarObject>;
  splitObject(
    outDir: string,
    id: number,
    how: { linePx: [[number, number], [number, number]] } | { n: number },
    signal?: AbortSignal,
  ): Promise<SidecarObject[]>;
  /** One more object segmented from a click (`pointPx`) or a box (`boxXywh`), photo pixels. */
  addObject(
    outDir: string,
    prompt: { pointPx: [number, number] } | { boxXywh: [number, number, number, number] },
    signal?: AbortSignal,
  ): Promise<SidecarObject>;
}

const DEFAULT_START_FIX =
  'start the vision sidecar (see: hsw-editor doctor) and check HSW_VISION_URL (default http://127.0.0.1:8795)';

export class VisionUnavailableError extends Error {
  readonly fix: string;
  constructor(message: string, fix = DEFAULT_START_FIX) {
    super(message);
    this.name = 'VisionUnavailableError';
    this.fix = fix;
  }
}

export class VisionRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VisionRequestError';
    this.code = code;
  }
}

function calibrateBody(c: CalibrationInput | null): Record<string, unknown> {
  if (!c) return {};
  if (c.mmPerPx) return { mode: 'manual', mm_per_px: c.mmPerPx };
  if (c.pointsPx && c.distanceMm) {
    return { mode: 'two-point', points_px: c.pointsPx, distance_mm: c.distanceMm };
  }
  return {};
}

/**
 * How the port reaches the sidecar. A transport throws `VisionUnavailableError` when no sidecar can be reached
 * (or started) and `VisionRequestError` for an error the sidecar (or the protocol) reports.
 */
export interface VisionTransport {
  status(): Promise<VisionAvailability>;
  /** POST JSON, return the reply body of a 2xx answer. */
  postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown>;
  /** POST JSON to an NDJSON endpoint: forward `stage|progress|...` events, return the final `result`. */
  postStream(
    path: string,
    body: unknown,
    onEvent: PhotoObjectsRequest['onEvent'],
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Transport for a sidecar somebody else runs at a fixed loopback URL (tests, `HSW_VISION_URL`-style setups). */
export class FetchVisionTransport implements VisionTransport {
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      };
      return await fetch(`${this.base}${path}`, init);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new VisionUnavailableError(
        `vision sidecar not reachable at ${this.base}: ${String(error)}`,
      );
    }
  }

  async status(): Promise<VisionAvailability> {
    try {
      const res = await fetch(`${this.base}/health`, {
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (res.ok) return { available: true, url: this.base };
      return {
        available: false,
        url: this.base,
        message: `the vision service answered ${res.status}`,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        available: false,
        url: this.base,
        message: `the vision service is not reachable: ${reason}`,
      };
    }
  }

  async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await this.post(path, body, signal);
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const failure = z
        .looseObject({
          error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }),
        })
        .safeParse(json);
      const err = failure.success ? failure.data.error : {};
      throw new VisionRequestError(
        err.code ?? `http_${res.status}`,
        err.message ?? `vision sidecar answered ${res.status}`,
      );
    }
    return json;
  }

  /** NDJSON stream: `stage|progress|object|...` events then one `result` or `error`. */
  async postStream(
    path: string,
    body: unknown,
    onEvent: PhotoObjectsRequest['onEvent'],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await this.post(path, body, signal);
    if (!res.ok && !(res.headers.get('content-type') ?? '').includes('ndjson')) {
      throw new VisionRequestError(
        `http_${res.status}`,
        `vision sidecar answered ${res.status} for ${path} (is the sidecar version new enough? it needs /photo-to-objects)`,
      );
    }
    if (!res.body) {
      throw new VisionRequestError('bad_response', 'empty response from the vision sidecar');
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let result: unknown;
    const handleLine = (raw: string): void => {
      const line = raw.trim();
      if (!line) return;
      const event = StreamEventSchema.parse(JSON.parse(line));
      if (event.event === 'result') result = event.result;
      else if (event.event === 'error') {
        const err = event.error ?? {};
        throw new VisionRequestError(
          err.code ?? 'vision_error',
          `${err.message ?? 'vision error'}${err.fix ? ` (${err.fix})` : ''}`,
        );
      } else onEvent?.(event);
    };
    try {
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
      }
      handleLine(buffer); // the last line may come without a trailing newline
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (result === undefined) {
      if (!res.ok) {
        throw new VisionRequestError(`http_${res.status}`, `vision sidecar answered ${res.status}`);
      }
      throw new VisionRequestError('bad_response', 'vision stream ended without a result');
    }
    return result;
  }
}

const PING_TIMEOUT_MS = 1500;

export class HttpVisionPort implements VisionPort {
  constructor(private readonly transport: VisionTransport) {}

  status(): Promise<VisionAvailability> {
    return this.transport.status();
  }

  async photoToObjects(req: PhotoObjectsRequest): Promise<SidecarResult> {
    const body = {
      image_path: req.imagePath,
      out_dir: req.outDir,
      calibrate: calibrateBody(req.calibration),
      categories: req.categoriesPath,
      segment: req.mode === 'single' ? { method: 'u2net', fill: 'none' } : {},
      max_objects: req.mode === 'single' ? 1 : (req.maxObjects ?? 60),
      topk: 5,
      colours: true,
    };
    const raw = await this.transport.postStream('/photo-to-objects', body, req.onEvent, req.signal);
    return SidecarResultSchema.parse(raw);
  }

  private async edit<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const parsed = schema.safeParse(await this.transport.postJson(path, body, signal));
    if (!parsed.success) {
      throw new VisionRequestError(
        'bad_response',
        `unexpected reply from ${path}: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async mergeObjects(
    outDir: string,
    ids: readonly number[],
    signal?: AbortSignal,
  ): Promise<SidecarObject> {
    const r = await this.edit(
      '/objects/merge',
      { out_dir: outDir, ids },
      z.object({ object: SidecarObjectSchema }),
      signal,
    );
    return r.object;
  }

  async splitObject(
    outDir: string,
    id: number,
    how: { linePx: [[number, number], [number, number]] } | { n: number },
    signal?: AbortSignal,
  ): Promise<SidecarObject[]> {
    const body =
      'linePx' in how
        ? { out_dir: outDir, id, line_px: how.linePx }
        : { out_dir: outDir, id, n: how.n };
    const r = await this.edit(
      '/objects/split',
      body,
      z.object({ objects: z.array(SidecarObjectSchema) }),
      signal,
    );
    return r.objects;
  }

  async addObject(
    outDir: string,
    prompt: { pointPx: [number, number] } | { boxXywh: [number, number, number, number] },
    signal?: AbortSignal,
  ): Promise<SidecarObject> {
    const body =
      'pointPx' in prompt
        ? { out_dir: outDir, point_px: prompt.pointPx }
        : { out_dir: outDir, box_xywh: prompt.boxXywh };
    const r = await this.edit(
      '/objects/add',
      body,
      z.object({ object: SidecarObjectSchema }),
      signal,
    );
    return r.object;
  }
}
