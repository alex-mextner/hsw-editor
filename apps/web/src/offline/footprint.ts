/**
 * What an edit touches, as `entity -> fields`. Two sides changed the same wall while one was offline;
 * they only *conflict* when they wrote the same field of the same entity (or one removed/added the
 * entity the other edited). Moving a holder while an agent renamed it is not a conflict.
 *
 * Mine is read from the queued ops (declared intent); theirs from a structural diff between the wall
 * my queue is based on and the server's current wall, which needs no history endpoint and is immune to
 * history paging or compaction.
 *
 * An entity key is `item:<id>`, `photo:<id>`, `model:<id>` or `wall:` (`entityKey`). The field `exists` stands for
 * "added or removed" and overlaps every other field of that entity. Both sides use the same `FIELD` names: a name
 * written on one side only would silently stop overlaps from matching.
 */
import type { LeafOp, Wall, WallItem } from '@hsw-editor/core';
import { assertNever } from './assertNever.ts';
import { deepEqual } from './equal.ts';

export type Footprint = ReadonlyMap<string, ReadonlySet<string>>;

export type EntityKind = 'item' | 'photo' | 'model' | 'wall';

export function entityKey(kind: EntityKind, id = ''): string {
  return `${kind}:${id}`;
}

export const FIELD = {
  exists: 'exists',
  position: 'position',
  rotation: 'rotation',
  variant: 'variant',
  lock: 'lock',
  attach: 'attach',
  label: 'label',
  calibration: 'calibration',
  board: 'board',
  name: 'name',
  /** A change this vocabulary has no name for (a field added to the core schema later). */
  other: 'other',
} as const;

const param = (key: string): string => `params.${key}`;

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

/** Fields written by `ops`. A new core op fails to compile here until it is given a footprint. */
export function opFootprint(ops: readonly LeafOp[]): Footprint {
  const fp = new FootprintBuilder();
  for (const op of ops) {
    switch (op.type) {
      case 'addItem':
        fp.add(entityKey('item', op.item.id), FIELD.exists);
        break;
      case 'removeItem':
        fp.add(entityKey('item', op.id), FIELD.exists);
        break;
      case 'moveItem':
        fp.add(entityKey('item', op.id), FIELD.position);
        break;
      case 'rotateItem':
        fp.add(entityKey('item', op.id), FIELD.rotation);
        break;
      case 'setParams':
        for (const key of Object.keys(op.set ?? {})) fp.add(entityKey('item', op.id), param(key));
        for (const key of op.unset ?? []) fp.add(entityKey('item', op.id), param(key));
        break;
      case 'setVariant':
        fp.add(entityKey('item', op.id), FIELD.variant);
        break;
      case 'lock':
        fp.add(entityKey('item', op.id), FIELD.lock);
        break;
      case 'attachItem':
        fp.add(entityKey('item', op.id), FIELD.attach);
        break;
      case 'addPhoto':
        fp.add(entityKey('photo', op.photo.id), FIELD.exists);
        break;
      case 'removePhoto':
        fp.add(entityKey('photo', op.id), FIELD.exists);
        break;
      case 'setCalibration':
        fp.add(entityKey('photo', op.photoId), FIELD.calibration);
        break;
      case 'setBoard':
        fp.add(entityKey('wall'), FIELD.board);
        break;
      case 'rename':
        if (op.itemId === undefined) fp.add(entityKey('wall'), FIELD.name);
        else fp.add(entityKey('item', op.itemId), FIELD.label);
        break;
      case 'addModelRef':
        fp.add(entityKey('model', op.model.id), FIELD.exists);
        break;
      case 'removeModelRef':
        fp.add(entityKey('model', op.id), FIELD.exists);
        break;
      case 'updateModelRef':
        for (const key of Object.keys(op.patch)) fp.add(entityKey('model', op.id), key);
        break;
      default:
        return assertNever(op);
    }
  }
  return fp.build();
}

type ItemView = readonly [field: string, pick: (item: WallItem) => unknown];

/** The item fields the ops above write, as projections of an item; `diffItem` compares each. */
const ITEM_VIEWS: readonly ItemView[] = [
  [FIELD.rotation, (item) => [item.pose.rotX, item.pose.rotY, item.pose.rotZ]],
  [FIELD.variant, (item) => [item.variantId, item.bankId]],
  [FIELD.lock, (item) => item.locked],
  [FIELD.attach, (item) => [item.parentId, item.slot]],
  [FIELD.label, (item) => item.label],
  [FIELD.other, (item) => [item.kind, item.toolClass, item.modelRefId, item.photoId, item.source]],
];

/**
 * When the board changed, the reducer re-derives x/y of every item on a cell: that is a consequence of
 * `setBoard`, not a move, so only the cell and z count as position then.
 */
function placement(item: WallItem, derivedXY: boolean): unknown {
  return derivedXY ? [item.cell, item.pose.z] : [item.cell, item.pose.x, item.pose.y, item.pose.z];
}

function diffItem(
  fp: FootprintBuilder,
  before: WallItem,
  after: WallItem,
  boardChanged: boolean,
): void {
  const entity = entityKey('item', before.id);
  const derivedXY = boardChanged && before.cell !== undefined && after.cell !== undefined;
  if (!deepEqual(placement(before, derivedXY), placement(after, derivedXY))) {
    fp.add(entity, FIELD.position);
  }
  for (const [field, pick] of ITEM_VIEWS) {
    if (!deepEqual(pick(before), pick(after))) fp.add(entity, field);
  }
  for (const key of new Set([...Object.keys(before.params), ...Object.keys(after.params)])) {
    if (before.params[key] !== after.params[key]) fp.add(entity, param(key));
  }
  // A field this vocabulary does not know about (a newer core schema) must still count as written.
  const withoutDerived = (item: WallItem): unknown =>
    derivedXY ? { ...item, pose: { ...item.pose, x: 0, y: 0 } } : item;
  if (!fp.touches(entity) && !deepEqual(withoutDerived(before), withoutDerived(after))) {
    fp.add(entity, FIELD.other);
  }
}

function diffById<T extends { readonly id: string }>(
  fp: FootprintBuilder,
  kind: EntityKind,
  before: readonly T[],
  after: readonly T[],
  diffFields: (fp: FootprintBuilder, a: T, b: T) => void,
): void {
  const afterById = new Map(after.map((entry) => [entry.id, entry]));
  const beforeIds = new Set<string>();
  for (const entry of before) {
    beforeIds.add(entry.id);
    const next = afterById.get(entry.id);
    if (!next) fp.add(entityKey(kind, entry.id), FIELD.exists);
    else if (!deepEqual(entry, next)) diffFields(fp, entry, next);
  }
  for (const entry of after) {
    if (!beforeIds.has(entry.id)) fp.add(entityKey(kind, entry.id), FIELD.exists);
  }
}

/** Everything that differs between two walls, in the same vocabulary as `opFootprint`. */
export function diffFootprint(before: Wall, after: Wall): Footprint {
  const fp = new FootprintBuilder();
  if (before.name !== after.name) fp.add(entityKey('wall'), FIELD.name);
  const boardChanged = !deepEqual(before.board, after.board);
  if (boardChanged) fp.add(entityKey('wall'), FIELD.board);
  diffById(fp, 'item', before.items, after.items, (builder, itemBefore, itemAfter) => {
    diffItem(builder, itemBefore, itemAfter, boardChanged);
  });
  diffById(fp, 'photo', before.photos, after.photos, (builder, photoBefore, photoAfter) => {
    builder.add(
      entityKey('photo', photoBefore.id),
      deepEqual(photoBefore.calibration, photoAfter.calibration) ? FIELD.other : FIELD.calibration,
    );
  });
  diffById(fp, 'model', before.models, after.models, (builder, modelBefore, modelAfter) => {
    const left = new Map(Object.entries(modelBefore));
    const right = new Map(Object.entries(modelAfter));
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      if (!deepEqual(left.get(key), right.get(key))) {
        builder.add(entityKey('model', modelBefore.id), key);
      }
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
      myFields.has(FIELD.exists) ||
      theirFields.has(FIELD.exists) ||
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
