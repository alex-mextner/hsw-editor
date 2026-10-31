/**
 * The public description of a built-in tool class (`GET /api/tools/classes`): what the Tool Library lists (names, families,
 * keywords, parameter schema, presets) plus the size and measured holding dimensions of its default build. The daemon answers
 * with it per request; the demo build (no daemon) writes the same list once into a static file, so both serve one shape.
 */
import { FAMILY_LABELS, generate, type AnyToolClass } from './registry.ts';

export interface ToolClassMetrics {
  dimsMm: { x: number; y: number; z: number };
  holdingDims: Record<string, number>;
}

const metricsMemo = new Map<string, ToolClassMetrics>();

/** Size and holding dims of the default build of a class, computed on first use. */
export function classMetrics(cls: AnyToolClass): ToolClassMetrics {
  let metrics = metricsMemo.get(cls.id);
  if (!metrics) {
    const model = generate(cls.id, {}, 0);
    const b = model.bounds;
    metrics = {
      dimsMm: { x: b.max[0] - b.min[0], y: b.max[1] - b.min[1], z: b.max[2] - b.min[2] },
      holdingDims: model.holding.dims,
    };
    metricsMemo.set(cls.id, metrics);
  }
  return metrics;
}

export function describeClass(cls: AnyToolClass): Record<string, unknown> {
  return {
    id: cls.id,
    family: cls.family,
    familyLabel: FAMILY_LABELS[cls.family],
    name: cls.name,
    bankClass: cls.bankClass,
    keywords: cls.keywords,
    schema: cls.schema,
    presets: cls.presets,
    thumb: `/api/tools/classes/${encodeURIComponent(cls.id)}/thumb.webp`,
    ...classMetrics(cls),
  };
}
