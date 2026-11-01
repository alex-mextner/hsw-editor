/**
 * One English sentence per physics problem, for agents and scripts that read the report as text. The editor has its
 * own ru/en catalogue (`apps/web/src/i18n`); this one exists so the daemon's answer is readable without it.
 */
import type { PhysicsProblem } from '@hsw-editor/physics';

type Params = PhysicsProblem['params'];

function num(params: Params, key: string): number | null {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function list(params: Params, key: string): string[] {
  const value = params[key];
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' && value !== '' ? [value] : [];
}

const REMOVAL_REASON_TEXT: Readonly<Record<string, string>> = {
  heavy: 'it is heavy',
  cramped: 'there is little room for fingers beside it',
  long_lift: 'it has to be lifted a long way',
};

function describeLevitating(params: Params): string {
  const gap = num(params, 'gapMm');
  return gap !== null && gap >= 0
    ? `Floats about ${gap} mm above its holder: nothing touches it, so it would fall.`
    : 'Floats in the air: it touches nothing of its holder and would fall.';
}

function describePenetrates(params: Params): string {
  const depth = num(params, 'depthMm');
  return `Is not seated: it sticks ${depth === null ? 'into' : `${depth} mm into`} the holder or a neighbour.`;
}

function describeTips(params: Params): string {
  const above = num(params, 'aboveMm');
  return above !== null
    ? `Tips over: its centre of gravity is ${above} mm above the point it hangs from.`
    : 'Tips over: it is held only on one side and rotates out of the holder.';
}

function describeSwings(params: Params): string {
  const sway = num(params, 'swayMm');
  const deg = num(params, 'swingDeg');
  const parts: string[] = [];
  if (deg !== null) parts.push(`about ${deg}° when bumped`);
  if (sway !== null) parts.push(`about ${sway} mm sideways`);
  return `Swings freely${parts.length > 0 ? ` (${parts.join(', ')})` : ''}.`;
}

function describeSlidesOff(params: Params): string {
  const margin = num(params, 'marginG');
  const needed = num(params, 'neededG');
  return `Slides off sideways when the wall is bumped${
    margin === null || needed === null ? '' : ` (it takes ${margin} g, ${needed} g is needed)`
  }.`;
}

function describeNeedsRetention(params: Params): string {
  const margin = num(params, 'marginG');
  const needed = num(params, 'neededG');
  return `Nothing keeps it from being pulled out: it comes along when a neighbour is taken off${
    margin === null || needed === null ? '' : ` (it holds ${margin} g, ${needed} g is needed)`
  }.`;
}

function describeWedged(params: Params): string {
  const depth = num(params, 'depthMm');
  return `Is stuck, not seated: its end is jammed ${
    depth === null ? 'in' : `${depth} mm into`
  } an opening that is too small for it, so it hangs there on a taper instead of resting on its handle.`;
}

function describeProtrudes(params: Params): string {
  const mm = num(params, 'protrudeMm');
  return `Sticks out ${mm === null ? '' : `${mm} mm `}below its holder: the rack is too shallow for this tool.`;
}

function describeOverloaded(params: Params): string {
  const mass = num(params, 'massG');
  const max = num(params, 'maxLoadG');
  return `Too heavy for its holder${
    mass === null || max === null ? '' : `: ${mass} g against a rating of ${max} g`
  }.`;
}

function describeRemovalBlocked(params: Params): string {
  const by = list(params, 'blockedBy');
  return `Cannot be taken off${by.length > 0 ? `: blocked by ${by.join(', ')}` : ''}.`;
}

function describeRemovalNeedsTilt(params: Params): string {
  const path = typeof params['path'] === 'string' ? params['path'] : '';
  return `Has to be tilted to come off${path === '' ? '' : ` (${path})`}.`;
}

function describeRemovalTwoHands(params: Params): string {
  const reasons = list(params, 'reasons').map((code) => REMOVAL_REASON_TEXT[code] ?? code);
  return `Needs two hands to take off${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''}.`;
}

const DESCRIBERS: Readonly<Record<string, (params: Params) => string>> = {
  levitating: describeLevitating,
  penetrates: describePenetrates,
  falls: () => 'Falls off: the holder cannot carry it in this position.',
  tips: describeTips,
  swings: describeSwings,
  slides_off: describeSlidesOff,
  needs_retention: describeNeedsRetention,
  wedged: describeWedged,
  protrudes: describeProtrudes,
  overloaded: describeOverloaded,
  removal_blocked: describeRemovalBlocked,
  removal_needs_tilt: describeRemovalNeedsTilt,
  removal_two_hands: describeRemovalTwoHands,
};

export function describeProblemEn(problem: PhysicsProblem): string {
  const { code, params } = problem;
  const describer = Object.hasOwn(DESCRIBERS, code) ? DESCRIBERS[code] : undefined;
  return describer ? describer(params) : `Physics problem: ${code}.`;
}
