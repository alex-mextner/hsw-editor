/**
 * Calibration wizard as a pure state machine: the UI feeds it clicks and typed values and renders whatever
 * `wizardPrompt` / `wizardPreview` say. Keeping the flow here (instead of in React state) makes every step,
 * including "move a click after placing it" and "wrong corner order", testable without a browser.
 */
import {
  calibrateFromCorners,
  calibrateTwoPoint,
  CORNER_ORDER,
  CornerOrderError,
  DEFAULT_REFERENCE_MM,
  scaleErrorBound,
  type BoardExtent,
  type CalibrationResult,
  type ReferenceAxis,
  type ScaleErrorBound,
} from './calibration.ts';
import { DegenerateError, type Vec2 } from './matrix.ts';
import { createPhotoMap, scaleSpread, type ImageSize, type ScaleSpread } from './photo-map.ts';

export type WizardMode = 'two-point' | 'corners';

export interface TwoPointWizard {
  mode: 'two-point';
  /** 0..2 clicks: the two ends of the reference. */
  clicks: Vec2[];
  realMm: number;
  axis: ReferenceAxis;
}

export interface CornersWizard {
  mode: 'corners';
  /** 0..4 clicks in `CORNER_ORDER`. */
  clicks: Vec2[];
  widthMm: number;
  heightMm: number;
}

export type WizardState = TwoPointWizard | CornersWizard;

export type WizardEvent =
  | { type: 'click'; px: Vec2 }
  /** Drag a placed click to fine-tune it. */
  | { type: 'moveClick'; index: number; px: Vec2 }
  | { type: 'undo' }
  | { type: 'reset' }
  | { type: 'setLength'; realMm: number }
  | { type: 'setAxis'; axis: ReferenceAxis }
  | { type: 'setSize'; widthMm?: number; heightMm?: number };

export function startWizard(mode: WizardMode, extent: BoardExtent): WizardState {
  if (mode === 'two-point') {
    return { mode, clicks: [], realMm: DEFAULT_REFERENCE_MM, axis: 'free' };
  }
  return { mode, clicks: [], widthMm: extent.widthMm, heightMm: extent.heightMm };
}

export function wizardClickCount(state: WizardState): number {
  return state.mode === 'two-point' ? 2 : 4;
}

export type WizardStep =
  | {
      kind: 'click';
      index: number;
      label: 'reference-start' | 'reference-end' | (typeof CORNER_ORDER)[number];
    }
  | { kind: 'confirm' };

/** What the user is asked to do next. */
export function wizardPrompt(state: WizardState): WizardStep {
  const index = state.clicks.length;
  if (index >= wizardClickCount(state)) return { kind: 'confirm' };
  if (state.mode === 'two-point') {
    return { kind: 'click', index, label: index === 0 ? 'reference-start' : 'reference-end' };
  }
  return { kind: 'click', index, label: CORNER_ORDER[index]! };
}

export function reduceWizard(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case 'click':
      return state.clicks.length >= wizardClickCount(state)
        ? state
        : { ...state, clicks: [...state.clicks, event.px] };
    case 'moveClick':
      return event.index < 0 || event.index >= state.clicks.length
        ? state
        : { ...state, clicks: state.clicks.map((c, i) => (i === event.index ? event.px : c)) };
    case 'undo':
      return { ...state, clicks: state.clicks.slice(0, -1) };
    case 'reset':
      return { ...state, clicks: [] };
    case 'setLength':
      return state.mode === 'two-point' ? { ...state, realMm: event.realMm } : state;
    case 'setAxis':
      return state.mode === 'two-point' ? { ...state, axis: event.axis } : state;
    case 'setSize':
      return state.mode === 'corners'
        ? {
            ...state,
            widthMm: event.widthMm ?? state.widthMm,
            heightMm: event.heightMm ?? state.heightMm,
          }
        : state;
  }
}

export type WizardProblem =
  | 'need-clicks'
  | 'invalid-length'
  | 'invalid-size'
  | 'clicks-too-close'
  | 'corner-order'
  | 'degenerate';

export interface WizardPreview {
  result: CalibrationResult;
  /** Two-point only: what 1 px and 3 px click errors cost. */
  clickError?: { onePx: ScaleErrorBound; threePx: ScaleErrorBound };
  /**
   * Corners only: how much the mm/px scale varies over the photo (large for a photo taken at a steep angle).
   * A two-point calibration has one scale everywhere by construction, so it has no spread to report; it warns with
   * `single-scale-only-at-reference` instead.
   */
  spread?: ScaleSpread;
  /** Advice the UI should show next to the result. */
  warnings: WizardWarning[];
}

export type WizardWarning =
  /** The reference spans less than 10% of the photo width: clicks dominate the error. */
  | 'short-reference'
  /** Two-point scale on a photo whose own geometry is unknown: exact only at the reference. */
  | 'single-scale-only-at-reference'
  /** The corners calibration leaves a large reprojection error (px). */
  | 'large-reprojection';

const SHORT_REFERENCE_FRACTION = 0.1;
const LARGE_REPROJECTION_PX = 3;

/** Live result of the wizard, or the reason there is none yet. */
export function wizardPreview(
  state: WizardState,
  image: ImageSize,
  extent: BoardExtent,
): { ok: true; preview: WizardPreview } | { ok: false; problem: WizardProblem } {
  if (state.clicks.length < wizardClickCount(state)) return { ok: false, problem: 'need-clicks' };
  try {
    if (state.mode === 'two-point') {
      const [a, b] = state.clicks as [Vec2, Vec2];
      if (!(state.realMm > 0) || !Number.isFinite(state.realMm)) {
        return { ok: false, problem: 'invalid-length' };
      }
      const reference = { a, b, realMm: state.realMm, axis: state.axis };
      const result = calibrateTwoPoint(reference, image, extent);
      const warnings: WizardWarning[] = ['single-scale-only-at-reference'];
      const clickError = {
        onePx: scaleErrorBound(reference, 1),
        threePx: scaleErrorBound(reference, 3),
      };
      if (clickError.onePx.referencePx < SHORT_REFERENCE_FRACTION * image.width) {
        warnings.unshift('short-reference');
      }
      return {
        ok: true,
        preview: { result, clickError, warnings },
      };
    }
    if (!(state.widthMm > 0) || !(state.heightMm > 0))
      return { ok: false, problem: 'invalid-size' };
    const result = calibrateFromCorners(
      {
        cornersPx: state.clicks as [Vec2, Vec2, Vec2, Vec2],
        widthMm: state.widthMm,
        heightMm: state.heightMm,
      },
      image,
    );
    const warnings: WizardWarning[] =
      result.reprojection.rmsPx > LARGE_REPROJECTION_PX ? ['large-reprojection'] : [];
    return {
      ok: true,
      preview: {
        result,
        spread: scaleSpread(createPhotoMap(result.homography, image)),
        warnings,
      },
    };
  } catch (error) {
    if (error instanceof CornerOrderError) return { ok: false, problem: 'corner-order' };
    if (error instanceof DegenerateError) {
      return {
        ok: false,
        problem: state.mode === 'two-point' ? 'clicks-too-close' : 'degenerate',
      };
    }
    throw error;
  }
}
