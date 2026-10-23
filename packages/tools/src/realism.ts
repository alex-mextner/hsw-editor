/**
 * What a real tool of each class measures. The generators are built from catalogue sizes; this table is the guard that keeps every
 * default, every preset and every size a user types inside what can actually be bought: a 150 mm screwdriver with a 55 mm blade next
 * to a normal handle is not a tool. A size outside a range is refused by `solveToolDims` (the nearest real size is built instead and
 * the caller is told it was not reached) and fails `realism.test.ts` when it comes out of a generator.
 *
 * Ranges are mm on the generated model (`bounds`: length = Y, width = X, thickness = Z) and on its `holding.dims` (named parts). A
 * `dims` key a variant does not have (a cold chisel has no handle) is not checked. `ratios` bound one named dimension over another, which
 * is what keeps proportions (blade vs handle) real when only the overall length is changed.
 */
import { type Bounds } from './math.ts';
import { type HoldingInterface } from './model.ts';

export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

export interface Ratio {
  readonly of: string;
  readonly over: string;
  readonly min: number;
  readonly max: number;
}

export interface Realism {
  /** Overall length (the tool's longest extent along its principal axis). */
  readonly length: ValueRange;
  readonly width?: ValueRange;
  readonly thickness?: ValueRange;
  readonly dims?: Readonly<Record<string, ValueRange>>;
  readonly ratios?: readonly Ratio[];
}

const r = (min: number, max: number): ValueRange => ({ min, max });

export const REALISM: Readonly<Record<string, Realism>> = {
  screwdriver: {
    length: r(95, 320),
    width: r(8, 70),
    dims: { handleLength: r(55, 130), handleDiameter: r(9, 46), shaftLength: r(38, 300) },
    ratios: [{ of: 'shaftLength', over: 'handleLength', min: 0.6, max: 2.2 }],
  },
  'ruler-steel': { length: r(150, 1000), width: r(12, 40), thickness: r(0.5, 2) },
  'square-try': { length: r(150, 600), width: r(70, 400) },
  'spirit-level': { length: r(230, 1200), width: r(40, 80) },
  'tape-measure': { length: r(100, 500), dims: { caseWidth: r(55, 90) } },
  caliper: { length: r(200, 450), width: r(60, 100) },
  scissors: { length: r(120, 260), dims: { bladeLength: r(55, 160) } },
  'utility-knife': { length: r(130, 215), width: r(14, 34) },
  'hex-key': { length: r(45, 150), dims: { longArm: r(45, 145) } },
  'driver-bit': { length: r(22, 55), width: r(5, 12) },
  'drill-bit': { length: r(40, 210), width: r(2, 14) },
  'nut-driver': {
    length: r(150, 290),
    dims: { handleLength: r(75, 120), shaftLength: r(70, 170) },
    ratios: [{ of: 'shaftLength', over: 'handleLength', min: 0.7, max: 1.8 }],
  },
  'hex-key-set': { length: r(80, 115) },
  'bit-case': { length: r(85, 140) },
  'drill-bit-case': { length: r(120, 150) },
  'wrench-open-end': { length: r(95, 340), dims: { headWidth: r(15, 65) } },
  'wrench-ring': { length: r(150, 420), dims: { headWidth: r(18, 56) } },
  'wrench-combination': { length: r(130, 420), dims: { headWidth: r(17, 65) } },
  'wrench-adjustable': { length: r(145, 310), dims: { jawCapacity: r(15, 40) } },
  'wrench-ratchet': { length: r(140, 350), dims: { headDiameter: r(22, 42) } },
  socket: { length: r(22, 80), width: r(15, 50) },
  multimeter: { length: r(105, 210), width: r(60, 105) },
  flashlight: { length: r(85, 310), width: r(15, 56) },
  'soldering-iron': { length: r(140, 240) },
  'glue-gun': { length: r(120, 200) },
  'battery-pack': { length: r(75, 90) },
  'cordless-drill': { length: r(140, 230), width: r(170, 235) },
  'spray-can': { length: r(120, 225), width: r(33, 70) },
  'tape-roll': { length: r(45, 125), width: r(45, 125) },
  hammer: {
    length: r(270, 420),
    dims: { handleLength: r(245, 380), headLength: r(90, 155), handleDiameter: r(22, 40) },
  },
  // A cold chisel is one bar of steel: no handle.
  chisel: { length: r(170, 270), dims: { bladeLength: r(90, 160), handleLength: r(0, 120) } },
  punch: { length: r(95, 160), width: r(5, 15) },
  file: {
    length: r(190, 490),
    dims: { handleLength: r(55, 130), fileLength: r(140, 360) },
  },
  'saw-hand': { length: r(330, 600), dims: { bladeLength: r(260, 520) } },
  hacksaw: { length: r(320, 430), dims: { bladeLength: r(200, 300) } },
  'pliers-combination': { length: r(155, 205), dims: { handleLength: r(85, 125) } },
  'side-cutters': { length: r(135, 185), dims: { handleLength: r(75, 115) } },
  'pliers-long-nose': { length: r(155, 245), dims: { handleLength: r(80, 135) } },
  'locking-pliers': { length: r(175, 305), dims: { handleLength: r(85, 155) } },
  'tin-snips': { length: r(245, 305), dims: { handleLength: r(120, 160) } },
  'water-pump-pliers': { length: r(195, 305), dims: { handleLength: r(105, 170) } },
  'crimper-stripper': { length: r(155, 205), dims: { handleLength: r(80, 110) } },
  'c-clamp': { length: r(140, 330) },
  'bar-clamp': { length: r(395, 745) },
  'spring-clamp': { length: r(95, 230) },
};

export function realismOf(classId: string): Realism | undefined {
  return REALISM[classId];
}

export interface RealismProblem {
  what: string;
  value: number;
  min: number;
  max: number;
}

function outside(what: string, value: number, range: ValueRange): RealismProblem | null {
  return value >= range.min && value <= range.max
    ? null
    : { what, value: Math.round(value * 10) / 10, min: range.min, max: range.max };
}

/** Everything about a built model that is outside what a real tool of its class measures. */
export function realismProblems(
  classId: string,
  bounds: Bounds,
  holding: Pick<HoldingInterface, 'dims'>,
): RealismProblem[] {
  const rule = REALISM[classId];
  if (!rule) return [{ what: 'no realism entry', value: 0, min: 0, max: 0 }];
  const found: (RealismProblem | null)[] = [
    outside('length', bounds.max[1] - bounds.min[1], rule.length),
    rule.width ? outside('width', bounds.max[0] - bounds.min[0], rule.width) : null,
    rule.thickness ? outside('thickness', bounds.max[2] - bounds.min[2], rule.thickness) : null,
  ];
  for (const [key, range] of Object.entries(rule.dims ?? {})) {
    const value = holding.dims[key];
    if (value !== undefined) found.push(outside(key, value, range));
  }
  for (const ratio of rule.ratios ?? []) {
    const top = holding.dims[ratio.of];
    const bottom = holding.dims[ratio.over];
    if (top !== undefined && bottom !== undefined && bottom > 0) {
      found.push(outside(`${ratio.of}/${ratio.over}`, top / bottom, ratio));
    }
  }
  return found.filter((problem): problem is RealismProblem => problem !== null);
}
