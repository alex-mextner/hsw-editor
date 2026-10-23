/**
 * Pure helpers of the "Add from photo" wizard: the scale reference the user chose, what to show for an object
 * (top classes, merge/split/group possibilities) and how a failed analysis is classified. No React, no network.
 */
import {
  type DimensionKey,
  type Draft,
  type DraftObject,
  MAX_DIMENSION_MM,
  MIN_DIMENSION_MM,
} from '@hsw-editor/tools/contract';
import type { CalibrationInput } from '../api.ts';

export const MAX_PHOTOS = 20;
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
export const PHOTO_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

/** How the photos get their scale: the honeycomb grid, a known mm/px, or two points with a real distance. */
export type ScaleChoice =
  | { readonly kind: 'auto' }
  | { readonly kind: 'mmPerPx'; readonly mmPerPx: number }
  | {
      readonly kind: 'twoPoint';
      readonly pointsPx: readonly [readonly [number, number], readonly [number, number]];
      readonly distanceMm: number;
    };

export const AUTO_SCALE: ScaleChoice = { kind: 'auto' };

/** The `calibration` field of the draft request; `null` lets the server detect the grid itself. */
export function calibrationOf(scale: ScaleChoice): CalibrationInput | null {
  if (scale.kind === 'mmPerPx') return { mmPerPx: scale.mmPerPx };
  if (scale.kind === 'twoPoint') return { pointsPx: scale.pointsPx, distanceMm: scale.distanceMm };
  return null;
}

export type PhotoProblem = 'type' | 'size' | 'count';

/** Why a file cannot be uploaded; `null` when it can. HEIC has no MIME type in some browsers: the extension decides. */
export function photoProblem(file: Pick<File, 'type' | 'size' | 'name'>): PhotoProblem | null {
  const byType = PHOTO_TYPES.some((type) => type === file.type);
  const byName = /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  if (!byType && !byName) return 'type';
  return file.size > MAX_PHOTO_BYTES ? 'size' : null;
}

export interface Intake {
  readonly accepted: readonly File[];
  readonly rejected: ReadonlyArray<{ readonly file: File; readonly problem: PhotoProblem }>;
}

/** Splits dropped files into the ones to keep (up to the photo limit, after those already chosen) and the refused. */
export function takePhotos(existing: readonly File[], dropped: readonly File[]): Intake {
  const accepted: File[] = [...existing];
  const rejected: Array<{ file: File; problem: PhotoProblem }> = [];
  const added: File[] = [];
  for (const file of dropped) {
    const problem = photoProblem(file);
    if (problem !== null) rejected.push({ file, problem });
    else if (accepted.length >= MAX_PHOTOS) rejected.push({ file, problem: 'count' });
    else {
      accepted.push(file);
      added.push(file);
    }
  }
  return { accepted: added, rejected };
}

export interface ClassScore {
  readonly classId: string;
  readonly score: number;
}

/** The best `n` class suggestions of an object, best first. */
export function topClasses(object: Pick<DraftObject, 'suggestions'>, n = 3): ClassScore[] {
  return [...object.suggestions].sort((a, b) => b.score - a.score).slice(0, n);
}

/** Objects that take part in the commit: the accepted ones that have a scale. */
export function committable(draft: Draft): DraftObject[] {
  return draft.objects.filter((object) => object.status === 'accepted' && !object.needsScale);
}

/** Objects the user can still decide on (not yet in the library). */
export function reviewable(draft: Draft): DraftObject[] {
  return draft.objects.filter((object) => object.status !== 'added');
}

/** Merge joins parts of one tool segmented apart: it needs two or more objects of one photo. */
export function canMerge(draft: Draft, keys: readonly string[]): boolean {
  if (keys.length < 2) return false;
  const picked = keys.map((key) => draft.objects.find((object) => object.key === key));
  const first = picked[0];
  return (
    first !== undefined &&
    picked.every((object) => object !== undefined && object.photo === first.photo)
  );
}

/** "Same tool in several photos" needs two or more objects from different photos. */
export function canGroup(draft: Draft, keys: readonly string[]): boolean {
  if (keys.length < 2) return false;
  const photos = new Set<number>();
  for (const key of keys) {
    const object = draft.objects.find((candidate) => candidate.key === key);
    if (object === undefined) return false;
    photos.add(object.photo);
  }
  return photos.size === keys.length;
}

/** A confidence in 0..1 as whole percent. */
export function percent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/** Whether an analysis failure means the vision service itself is down (as opposed to a bad photo). */
export function isVisionUnavailable(message: string | null): boolean {
  return message !== null && /vision|sidecar|8795|not reachable|unavailable/i.test(message);
}

/** The photo an object belongs to, by index. */
export function photoOf(
  draft: Draft,
  object: Pick<DraftObject, 'photo'>,
): Draft['photos'][number] | undefined {
  return draft.photos.find((photo) => photo.index === object.photo);
}

/** What a typed dimension field holds: a size to send, nothing to send (empty), or a refusal with the reason. */
export type TypedDimension =
  | { readonly kind: 'ok'; readonly valueMm: number }
  | { readonly kind: 'empty' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'range' };

/** Reads a dimension field (comma or point decimals). Sizes outside the sane range of that dimension are refused, never clamped. */
export function parseTypedDimension(raw: string, dimension: DimensionKey): TypedDimension {
  const text = raw.trim().replace(',', '.');
  if (text === '') return { kind: 'empty' };
  const valueMm = Number(text);
  if (!Number.isFinite(valueMm)) return { kind: 'invalid' };
  if (valueMm < MIN_DIMENSION_MM[dimension] || valueMm > MAX_DIMENSION_MM) return { kind: 'range' };
  return { kind: 'ok', valueMm };
}
