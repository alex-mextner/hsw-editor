/**
 * Versioned prompt templates for "draw the missing views of this object". Generated views are
 * hints for the fitter (silhouette/proportion sanity checks), never ground truth: the wall data
 * must label them `source: 'generated'`. Bump PROMPT_TEMPLATE_VERSION on any wording change so
 * stored results stay attributable to the template that produced them.
 */
import { DRAW_SIZES, type DrawRef, type DrawSize, MAX_REFS } from './contract.ts';

export const PROMPT_TEMPLATE_VERSION = 1;

export const DRAW_VIEWS = ['front', 'side', 'top', 'back'] as const;
export type DrawView = (typeof DRAW_VIEWS)[number];

const VIEW_PHRASE: Record<DrawView, string> = {
  front:
    'straight-on FRONT orthographic view (camera level with the object, looking at its front face)',
  side: "straight-on SIDE orthographic view from the object's right (camera level, exactly 90 degrees from the front)",
  top: 'straight-down TOP orthographic view (camera directly above, looking down)',
  back: 'straight-on BACK orthographic view (camera level, opposite the front)',
};

export interface DrawObjectSpec {
  /** Short human name, e.g. "Fischer wall plug box". */
  readonly name: string;
  /** Optional extra description of what the photo shows. */
  readonly description?: string;
  /** Known real-world bounding box, millimetres (width, height, depth) to anchor proportions. */
  readonly dimsMm?: { readonly width: number; readonly height: number; readonly depth: number };
}

export interface ViewPlanStep {
  readonly view: DrawView;
  readonly prompt: string;
  readonly size: DrawSize;
  /** Expected width/height ratio of the output image (the requested size). */
  readonly aspect: number;
  /** Prior generated views to attach as `view` refs, in addition to the subject photo. */
  readonly useGeneratedRefs: boolean;
}

export interface ViewPlanOptions {
  readonly object: DrawObjectSpec;
  readonly views: readonly DrawView[];
  readonly size?: DrawSize;
}

const COMMON_RULES = [
  'Draw the SAME single object as in the reference image(s): identical shape, proportions, colours, markings and level of detail.',
  'Pure white (#FFFFFF) seamless background, no floor, no horizon, no cast or contact shadow, no gradient, no reflection.',
  'Orthographic projection: no perspective foreshortening, parallel edges stay parallel.',
  'Centre the whole object with a clear white margin on every side; nothing may be cropped.',
  'Flat even studio lighting. No text, labels, hands, props, other objects or watermarks.',
] as const;

export function sizeAspect(size: DrawSize): number {
  const [w, h] = size.split('x').map(Number);
  return (w ?? 1) / (h ?? 1);
}

function dimsLine(object: DrawObjectSpec): string {
  const d = object.dimsMm;
  if (!d) return '';
  return ` Real size: ${d.width} mm wide, ${d.height} mm high, ${d.depth} mm deep; keep these proportions.`;
}

export function buildViewPrompt(object: DrawObjectSpec, view: DrawView): string {
  const subject = object.description ? `${object.name} (${object.description})` : object.name;
  return [
    `Create an image (generate it, do not just describe it): the ${VIEW_PHRASE[view]} of ${subject}.`,
    ...COMMON_RULES,
    dimsLine(object).trim(),
  ]
    .filter((line) => line !== '')
    .join(' ');
}

/** One request per missing view; later steps chain earlier results as refs for consistency. */
export function planViews(options: ViewPlanOptions): ViewPlanStep[] {
  const size = options.size ?? DRAW_SIZES[0];
  const unique = DRAW_VIEWS.filter((view) => options.views.includes(view));
  return unique.map((view, index) => ({
    view,
    prompt: buildViewPrompt(options.object, view),
    size,
    aspect: sizeAspect(size),
    useGeneratedRefs: index > 0,
  }));
}

/** subject photo first, then previously generated views, capped at MAX_REFS (subject always kept). */
export function chainRefs(
  subject: readonly DrawRef[],
  generatedPaths: readonly string[],
): DrawRef[] {
  const base = subject.map((ref): DrawRef => ({ path: ref.path, role: ref.role ?? 'subject' }));
  const room = Math.max(0, MAX_REFS - base.length);
  const generated = generatedPaths.slice(-room).map((path): DrawRef => ({ path, role: 'view' }));
  return room === 0 ? base.slice(0, MAX_REFS) : [...base, ...generated];
}
