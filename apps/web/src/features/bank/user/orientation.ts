/**
 * Orientation choices. A source mesh has no wall frame, so the user says which SOURCE axis points out of the
 * wall (`out`) and which points up (`up`). The two must lie on different axes (the schema refuses otherwise), so
 * the `up` choices depend on the chosen `out`.
 */
import { SIGNED_AXES, type MeshFormat, type Orientation, type SignedAxis } from '@hsw-editor/bank';

/** Six faces that can be on the wall side: `out` is the opposite direction, so any signed axis is valid. */
export const OUT_CHOICES: readonly SignedAxis[] = SIGNED_AXES;

/** The four axes perpendicular to `out`. */
export function upChoices(out: SignedAxis): readonly SignedAxis[] {
  return SIGNED_AXES.filter((axis) => axis[1] !== out[1]);
}

/**
 * New orientation after the user picked `out`: keeps the current `up` when still perpendicular, otherwise the
 * first valid one so the pair never becomes invalid.
 */
export function withOut(out: SignedAxis, currentUp: SignedAxis): Orientation {
  const valid = upChoices(out);
  return { out, up: valid.includes(currentUp) ? currentUp : (valid[0] ?? currentUp) };
}

export function withUp(out: SignedAxis, up: SignedAxis): Orientation {
  return upChoices(out).includes(up) ? { out, up } : withOut(out, up);
}

/** STL / 3MF are Z-up, a glTF is Y-up: the axis that is "top" in the source's own convention. */
export function topAxisOf(format: MeshFormat): 'z' | 'y' {
  return format === 'glb' ? 'y' : 'z';
}

export interface AxisLabel {
  /** `+Z`, `-X`, ... */
  readonly axis: string;
  readonly role: 'top' | 'bottom' | null;
}

export function axisLabel(axis: SignedAxis, format: MeshFormat): AxisLabel {
  const top = topAxisOf(format);
  const role = axis[1] === top ? (axis[0] === '+' ? 'top' : 'bottom') : null;
  return { axis: `${axis[0]}${axis[1]?.toUpperCase() ?? ''}`, role };
}
