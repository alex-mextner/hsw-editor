/**
 * Turns a physics problem (`@hsw-editor/physics` `PhysicsProblem`, or the `{code, params}` reasons of the holder
 * suggestions) into a sentence in the active language. Codes are the engine's: the hang codes, the three removal
 * problem codes, and the bare removal reason codes (`blocked`, `needs_tilt`, ...) the suggestions carry.
 */
import type { RemovalReport } from '@hsw-editor/physics';
import type { Translate } from '@/i18n/index.ts';

export type ProblemParam = number | string | readonly string[];

export interface ProblemLike {
  readonly code: string;
  readonly params: Readonly<Record<string, ProblemParam>>;
}

/** `nameOf` resolves an obstacle id to a display name; the id itself when omitted. */
export type NameOf = (id: string) => string;

const identity: NameOf = (id) => id;

function text(value: ProblemParam | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'object' ? value.join(', ') : String(value);
}

function list(value: ProblemParam | undefined): readonly string[] {
  if (value === undefined) return [];
  return typeof value === 'object' ? value : [String(value)];
}

/** Millimetres/degrees: one decimal at most, no trailing zero ("2", "2.5"). */
function round(value: ProblemParam | undefined): string {
  const n = typeof value === 'number' ? value : Number(text(value));
  return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : text(value);
}

const CAUSE_KEYS = {
  heavy: 'physics.because.heavy',
  cramped: 'physics.because.cramped',
  long_lift: 'physics.because.long_lift',
} as const;

function isCause(code: string): code is keyof typeof CAUSE_KEYS {
  return code in CAUSE_KEYS;
}

/** The removal path in words: "tilt 15° about x, lift 15 mm, pull". `null` when the tool cannot be taken off. */
export function describeRemovalPath(removal: RemovalReport, t: Translate): string | null {
  if (removal.path === null) return null;
  const steps: string[] = [];
  for (const reason of removal.reasons) {
    if (reason.code === 'needs_tilt') {
      steps.push(
        t('physics.path.tilt', {
          deg: round(reason.params['deg']),
          axis: text(reason.params['axis']),
        }),
      );
    }
  }
  if (removal.liftMm > 0 && removal.pullMm > 0) {
    steps.push(t('physics.path.liftPull', { liftMm: removal.liftMm }));
  } else if (removal.pullMm > 0) {
    steps.push(t('physics.path.pull'));
  } else {
    steps.push(t('physics.path.lift'));
  }
  return steps.join(', ');
}

/** A path string as the engine writes it, for problems that carry only `params.path` ("lift 15 mm, pull"). */
function pathFromEngine(raw: string, t: Translate): string {
  const tilt = /tilt (\w) ([+-]?[\d.]+) deg/.exec(raw);
  const lift = /lift (\d+) mm, pull/.exec(raw);
  const steps: string[] = [];
  if (tilt)
    steps.push(
      t('physics.path.tilt', { deg: round(Math.abs(Number(tilt[2]))), axis: tilt[1] ?? '' }),
    );
  if (lift) steps.push(t('physics.path.liftPull', { liftMm: lift[1] ?? '' }));
  else if (/\bpull\b/.test(raw)) steps.push(t('physics.path.pull'));
  else if (/\blift\b/.test(raw)) steps.push(t('physics.path.lift'));
  return steps.length > 0 ? steps.join(', ') : raw;
}

export function describeProblem(
  problem: ProblemLike,
  t: Translate,
  nameOf: NameOf = identity,
): string {
  const p = problem.params;
  switch (problem.code) {
    case 'levitating': {
      const gap = typeof p['gapMm'] === 'number' ? p['gapMm'] : -1;
      return gap < 0
        ? t('physics.problem.levitating.unbounded')
        : t('physics.problem.levitating', { gapMm: round(gap) });
    }
    case 'penetrates':
      return t('physics.problem.penetrates', { depthMm: round(p['depthMm']) });
    case 'falls':
      return t('physics.problem.falls');
    case 'tips':
      return t('physics.problem.tips');
    case 'swings':
      return t('physics.problem.swings', {
        swayMm: round(p['swayMm']),
        swingDeg: round(p['swingDeg']),
      });
    case 'slides_off':
      return t('physics.problem.slides_off');
    case 'needs_retention':
      return t('physics.problem.needs_retention');
    case 'overloaded':
      return t('physics.problem.overloaded', {
        massG: round(p['massG']),
        maxLoadG: round(p['maxLoadG']),
      });
    case 'removal_blocked':
    case 'blocked': {
      const names = list(p['blockedBy']).map(nameOf);
      return names.length === 0
        ? t('physics.problem.removal_blocked.unknown')
        : t('physics.problem.removal_blocked', { blockedBy: names.join(', ') });
    }
    case 'removal_needs_tilt':
    case 'needs_tilt': {
      const path = text(p['path']);
      return t('physics.problem.removal_needs_tilt', {
        path:
          path !== ''
            ? pathFromEngine(path, t)
            : t('physics.path.tilt', { deg: round(p['deg']), axis: text(p['axis']) }),
      });
    }
    case 'removal_two_hands': {
      const causes = list(p['reasons'])
        .filter(isCause)
        .map((code) => t(CAUSE_KEYS[code]));
      return causes.length === 0
        ? t('physics.problem.removal_two_hands.unknown')
        : t('physics.problem.removal_two_hands', { because: causes.join(', ') });
    }
    case 'heavy':
    case 'cramped':
    case 'long_lift':
      return t('physics.problem.removal_two_hands', { because: t(CAUSE_KEYS[problem.code]) });
    case 'tight_clearance':
      return t('physics.problem.tight_clearance', { clearanceMm: round(p['clearanceMm']) });
    default:
      return t('physics.problem.unknown', { code: problem.code });
  }
}
