/**
 * Structural inputs of the compatibility maths. They are deliberately narrow subsets of
 * `HoldingInterface` (`@hsw-editor/tools`) and `BankElement` (`@hsw-editor/bank`): a real tool model or bank
 * element satisfies them as it is, so this package depends on neither. Wall frame everywhere: mm, x right,
 * y up, z out of the wall; tool frame: origin on the principal axis at the butt, +Y towards the working end.
 */
import type { Vec3 } from './rotation.ts';

export type { Vec3 } from './rotation.ts';

export interface HangPoint {
  /** Point on the tool (tool frame) a hook or peg engages. */
  point: Vec3;
  kind: 'hole' | 'loop' | 'butt' | 'head' | 'body';
  diameterMm?: number | undefined;
}

export interface ToolInterface {
  /** Bank tool-class id (`screwdriver`, `tape-measure`, ...): the vocabulary of holder `fitsTool`. */
  toolClass: string;
  /**
   * Coarser classes the tool also fits (`chisel` -> `knife`), from the bank vocabulary's `broader`. A holder
   * listing one of them takes the tool, ranked below a holder that lists `toolClass` itself.
   */
  broader?: readonly string[] | undefined;
  /** Extent along the principal axis from the butt (or the lowest point) to the working end. */
  lengthMm: number;
  hang: HangPoint | null;
  /** Largest cross-section over the whole tool. */
  maxSection: { w: number; t: number; r: number };
  /** Measured class-specific dimensions in mm (`shaftDiameter`, `handleWidth`, ...), the keys of `fitsTool.dims`. */
  dims: Readonly<Record<string, number>>;
  /** Mass in grams when known; checked against a mount's `maxLoadG`. */
  massG?: number | undefined;
}

export interface DimRange {
  min: number;
  max: number;
}

/** One kind of object a holder takes, as published by the bank (`fitsTool`). */
export interface MountEntry {
  toolClass: string;
  dims?: Readonly<Record<string, DimRange>> | undefined;
  /** How many objects one holder takes; absent means one. */
  capacity?: number | undefined;
  /** Largest tool mass in grams one slot carries; absent means unchecked. */
  maxLoadG?: number | undefined;
}

export interface HolderSpec {
  /** Bank element id. */
  id: string;
  /** Bank category path, e.g. `holders/screwdrivers`; decides the mount style. */
  category: string;
  fitsTool: readonly MountEntry[];
  /** Element bounds in the element frame (origin = centre of its anchor cell, z = 0 at the wall). */
  bboxMm: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
}

export type ReasonCode =
  | 'not_a_mount'
  | 'class_mismatch'
  | 'dim_too_large'
  | 'dim_too_small'
  | 'dim_unknown'
  | 'slots_full'
  | 'slot_out_of_range'
  | 'slot_taken'
  | 'overload';

/** A localisable explanation: the UI maps `code` to a ru/en sentence and fills it from `params`. */
export interface Reason {
  code: ReasonCode;
  params: Readonly<Record<string, string | number | readonly string[]>>;
}

/** Whether a reason prevents hanging; `dim_unknown` only lowers the score. */
export const BLOCKING_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'not_a_mount',
  'class_mismatch',
  'dim_too_large',
  'dim_too_small',
  'slots_full',
  'slot_out_of_range',
  'slot_taken',
  'overload',
]);

/** How much room a measured tool dimension has inside the mount's range; negative = does not fit. */
export interface Clearance {
  key: string;
  valueMm: number;
  minMm: number;
  maxMm: number;
  /** min(value - min, max - value) in mm. */
  marginMm: number;
}

export interface Compatibility {
  ok: boolean;
  /** 0 when not ok; otherwise in (0.6, 1]: dimension-confirmed and dedicated mounts rank highest. */
  score: number;
  reasons: Reason[];
  clearances: Clearance[];
  /** Index into `fitsTool` of the entry that decided the result; null when no entry names the class. */
  entryIndex: number | null;
}

/** Code-unit comparison: the same order in every runtime, unlike `localeCompare` (ICU dependent). */
export function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** The `fitsTool` entry that decided a compatibility result; null when none named the class. */
export function matchedEntry(
  holder: HolderSpec,
  result: Pick<Compatibility, 'entryIndex'>,
): MountEntry | null {
  return result.entryIndex === null ? null : (holder.fitsTool[result.entryIndex] ?? null);
}
