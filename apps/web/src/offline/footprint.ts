/**
 * What an edit touches, as `entity -> fields`. Two sides changed the same wall while one was offline;
 * they only *conflict* when they wrote the same field of the same entity (or one removed/added the
 * entity the other edited). Moving a holder while an agent renamed it is not a conflict.
 *
 * Mine is read from the queued ops (declared intent); theirs from a structural diff between the wall
 * my queue is based on and the server's current wall, which needs no history endpoint and is immune to
 * history paging or compaction.
 *
 * Entity ids look like `item:i-1`, `photo:p-2`, `model:m-3`, `wall:`. The field `exists` stands for
 * "added or removed" and overlaps every other field of that entity.
 */
import type { LeafOp, Wall, WallItem } from '@hsw-editor/core';
import { assertNever } from './assertNever.ts';

export type Footprint = ReadonlyMap<string, ReadonlySet<string>>;

const EXISTS = 'exists';

class FootprintBuilder {
  private readonly map = new Map<string, Set<string>>();
  add(entity: string, field: string): void {
    const fields = this.map.get(entity);
    if (fields) fields.add(field);
    else this.map.set(entity, new Set([field]));
  }
  touches(entity: string): boolean {
    return this.map.has(entity);
  }
  build(): Footprint {
    return this.map;
  }
}

/** Fields written by `op`. Keep in step with the reducer in `packages/core/src/ops.ts`. */
export function opFootprint(ops: readonly LeafOp[]): Footprint {
  const fp = new FootprintBuilder();
  for (const op of ops) {
    switch (op.type) {
      case 'addItem':
        fp.add(`item:${op.item.id}`, EXISTS);
        break;
      case 'removeItem':
        fp.add(`item:${op.id}`, EXISTS);
        break;
      case 'moveItem':
        fp.add(`item:${op.id}`, 'position');
        break;
      case 'rotateItem':
        fp.add(`item:${op.id}`, 'rotation');
        break;
      case 'setParams':
        for (const key of Object.keys(op.set ?? {})) fp.add(`item:${op.id}`, `params.${key}`);
        for (const key of op.unset ?? []) fp.add(`item:${op.id}`, `params.${key}`);
        break;
      case 'setVariant':
        fp.add(`item:${op.id}`, 'variant');
        break;
      case 'lock':
        fp.add(`item:${op.id}`, 'lock');
        break;
      case 'attachItem':
        fp.add(`item:${op.id}`, 'attach');
        break;
      case 'addPhoto':
        fp.add(`photo:${op.photo.id}`, EXISTS);
        break;
      case 'removePhoto':
        fp.add(`photo:${op.id}`, EXISTS);
        break;
      case 'setCalibration':
        fp.add(`photo:${op.photoId}`, 'calibration');
        break;
      case 'setBoard':
        fp.add('wall:', 'board');
        break;
      case 'rename':
        if (op.itemId === undefined) fp.add('wall:', 'name');
        else fp.add(`item:${op.itemId}`, 'label');
        break;
      case 'addModelRef':
        fp.add(`model:${op.model.id}`, EXISTS);
        break;
      case 'removeModelRef':
        fp.add(`model:${op.id}`, EXISTS);
        break;
      case 'updateModelRef':
        for (const key of Object.keys(op.patch)) fp.add(`model:${op.id}`, key);
        break;
      default:
        return assertNever(op);
    }
  }
  return fp.build();
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * When the board changed, the reducer re-derives x/y of every item on a cell: that is a consequence of
 * `setBoard`, not a move, so only the cell and z count as position then.
 */
function diffItem(
  fp: FootprintBuilder,
  before: WallItem,
  after: WallItem,
  boardChanged: boolean,
): void {
  const entity = `item:${before.id}`;
  const derivedXY = boardChanged && before.cell !== undefined && after.cell !== undefined;
  const placement = (item: WallItem) =>
    derivedXY ? [item.cell, item.pose.z] : [item.cell, item.pose.x, item.pose.y, item.pose.z];
  if (!same(placement(before), placement(after))) fp.add(entity, 'position');
  if (
    !same(
      [before.pose.rotX, before.pose.rotY, before.pose.rotZ],
      [after.pose.rotX, after.pose.rotY, after.pose.rotZ],
    )
  ) {
    fp.add(entity, 'rotation');
  }
  for (const key of new Set([...Object.keys(before.params), ...Object.keys(after.params)])) {
    if (before.params[key] !== after.params[key]) fp.add(entity, `params.${key}`);
  }
  if (!same([before.variantId, before.bankId], [after.variantId, after.bankId]))
    fp.add(entity, 'variant');
  if (before.locked !== after.locked) fp.add(entity, 'lock');
  if (!same([before.parentId, before.slot], [after.parentId, after.slot])) fp.add(entity, 'attach');
  if (before.label !== after.label) fp.add(entity, 'label');
  if (
    !same(
      [before.kind, before.toolClass, before.modelRefId, before.photoId, before.source],
      [after.kind, after.toolClass, after.modelRefId, after.photoId, after.source],
    )
  ) {
    fp.add(entity, 'other');
  }
  // A field this vocabulary does not know about (a newer core schema) must still count as written.
  const known = (item: WallItem) => ({ ...item, pose: { ...item.pose, x: 0, y: 0 } });
  if (
    !fp.touches(entity) &&
    !same(derivedXY ? known(before) : before, derivedXY ? known(after) : after)
  ) {
    fp.add(entity, 'other');
  }
}

function diffById<T extends { readonly id: string }>(
  fp: FootprintBuilder,
  prefix: string,
  before: readonly T[],
  after: readonly T[],
  diffFields: (builder: FootprintBuilder, a: T, b: T) => void,
): void {
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const beforeIds = new Set<string>();
  for (const entry of before) {
    beforeIds.add(entry.id);
    const next = afterById.get(entry.id);
    if (!next) fp.add(`${prefix}:${entry.id}`, EXISTS);
    else if (!same(entry, next)) diffFields(fp, entry, next);
  }
  for (const entry of after) {
    if (!beforeIds.has(entry.id)) fp.add(`${prefix}:${entry.id}`, EXISTS);
  }
}

/** Everything that differs between two walls, in the same vocabulary as `opFootprint`. */
export function diffFootprint(before: Wall, after: Wall): Footprint {
  const fp = new FootprintBuilder();
  if (before.name !== after.name) fp.add('wall:', 'name');
  const boardChanged = !same(before.board, after.board);
  if (boardChanged) fp.add('wall:', 'board');
  diffById(fp, 'item', before.items, after.items, (b, itemBefore, itemAfter) => {
    diffItem(b, itemBefore, itemAfter, boardChanged);
  });
  diffById(fp, 'photo', before.photos, after.photos, (b, photoBefore, photoAfter) => {
    b.add(
      `photo:${photoBefore.id}`,
      same(photoBefore.calibration, photoAfter.calibration) ? 'other' : 'calibration',
    );
  });
  diffById(fp, 'model', before.models, after.models, (b, modelBefore, modelAfter) => {
    const left = new Map(Object.entries(modelBefore));
    const right = new Map(Object.entries(modelAfter));
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      if (!same(left.get(key), right.get(key))) b.add(`model:${modelBefore.id}`, key);
    }
  });
  return fp.build();
}

/** Entities both footprints write (see the module comment for what counts as overlapping). */
export function overlappingEntities(mine: Footprint, theirs: Footprint): string[] {
  const out: string[] = [];
  for (const [entity, myFields] of mine) {
    const theirFields = theirs.get(entity);
    if (!theirFields) continue;
    const clash =
      myFields.has(EXISTS) ||
      theirFields.has(EXISTS) ||
      [...myFields].some((field) => theirFields.has(field));
    if (clash) out.push(entity);
  }
  return out;
}

/**
 * `footprint` without what `removed` covers: fields of an edit that turned out to be already applied (my own
 * edit whose acknowledgement was lost) are not "theirs", so my follow-up edits on the same entity are not
 * conflicts with myself.
 */
export function subtractFootprint(footprint: Footprint, removed: Footprint): Footprint {
  const out = new Map<string, Set<string>>();
  for (const [entity, fields] of footprint) {
    const gone = removed.get(entity);
    const kept = gone ? [...fields].filter((field) => !gone.has(field)) : [...fields];
    if (kept.length > 0) out.set(entity, new Set(kept));
  }
  return out;
}
