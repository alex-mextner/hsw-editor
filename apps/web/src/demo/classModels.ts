/**
 * In-browser answers of the class routes the daemon computes per request (`GET /api/tools/classes/<id>/holding` and `/model.glb`
 * with `?preset=` / `?p=` parameter values): the same generators the daemon runs, so the Tool Library of the demo build (no daemon)
 * shows the same model and holding diagram for every parameter set. Loaded on demand (`staticApi.ts`), never on the startup path.
 */
import {
  exportGlb,
  generate,
  getToolClass,
  hasToolClass,
  presetValues,
  type ParamValue,
} from '@hsw-editor/tools';
import { z } from 'zod';

const ParamValues = z.record(z.string(), z.union([z.number(), z.string()]));

export type ClassResource = 'holding' | 'model.glb';

function valuesOf(classId: string, params: URLSearchParams): Record<string, ParamValue> | null {
  const preset = params.get('preset');
  let base: Record<string, ParamValue> = {};
  if (preset) {
    if (!getToolClass(classId).presets.some((candidate) => candidate.id === preset)) return null;
    base = presetValues(classId, preset);
  }
  const raw = params.get('p');
  if (!raw) return base;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = ParamValues.safeParse(json);
  return parsed.success ? { ...base, ...parsed.data } : null;
}

/** The answer for a class resource, or `null` when the class, preset or parameters are unknown (the caller answers 404/400). */
export function classResponse(
  classId: string,
  resource: ClassResource,
  params: URLSearchParams,
): Response | null {
  if (!hasToolClass(classId)) return null;
  const values = valuesOf(classId, params);
  if (values === null) return null;
  const model = generate(classId, values, params.get('lod') === '1' ? 1 : 0);
  if (resource === 'model.glb') {
    return new Response(new Uint8Array(exportGlb(model)), {
      headers: { 'content-type': 'model/gltf-binary' },
    });
  }
  return Response.json({
    params: model.params,
    holding: model.holding,
    bboxMm: model.bounds,
    bankClass: getToolClass(classId).bankClass,
  });
}
