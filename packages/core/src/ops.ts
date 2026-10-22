/**
 * The pure wall reducer. `applyOp(wall, op)` never mutates its input, never touches the clock, the
 * disk or a random source, and returns the inverse op that restores the previous document.
 *
 * Rules (tested as invariants):
 * - applying `inverse` to the result yields the original wall, except `rev`, which only moves forward;
 * - an op that changes nothing does not bump `rev` (`changed: false`), so retries are idempotent;
 * - a failing op (or any op of a failing batch) throws `OpError` and changes nothing: batches are atomic;
 * - ops on a locked item are refused, except `lock` itself;
 * - geometry problems (collisions, out-of-board poses) are reported as warnings, never as errors.
 */
import {
  type Board,
  boardSizeMm,
  cellCenter,
  cellInBoard,
  HEX_SYMMETRY_DEG,
  normalizeDeg,
} from './grid.ts';
import {
  type BatchOp,
  type LeafOp,
  ModelRefPatchSchema,
  ModelRefSchema,
  type Op,
  type Pose,
  type Wall,
  type WallItem,
} from './schema.ts';

export const OP_ERROR_CODES = [
  'item_not_found',
  'item_exists',
  'item_locked',
  'photo_not_found',
  'photo_exists',
  'model_not_found',
  'model_exists',
  'invalid_op',
] as const;
export type OpErrorCode = (typeof OP_ERROR_CODES)[number];

export class OpError extends Error {
  readonly code: OpErrorCode;
  /** Index inside a batch, when the failing op was part of one. */
  readonly opIndex: number | undefined;

  constructor(code: OpErrorCode, message: string, opIndex?: number) {
    super(message);
    this.name = 'OpError';
    this.code = code;
    this.opIndex = opIndex;
  }
}

export const WARNING_CODES = [
  'cell_out_of_board',
  'out_of_board',
  'cell_collision',
  'rotation_off_symmetry',
  'missing_parent',
  'missing_photo',
  'missing_model',
  'parent_not_holder',
  'slot_collision',
  'slot_without_parent',
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

export interface WallWarning {
  code: WarningCode;
  message: string;
  itemIds: string[];
}

export interface ApplyResult {
  wall: Wall;
  /** Op that, applied to `wall`, restores the input document (bar `rev`). For no-ops: harmless to apply. */
  inverse: Op;
  /** False when the op left the document unchanged; `wall` is then the input object and `rev` is unchanged. */
  changed: boolean;
  /** Geometry/reference problems of the resulting wall (whole-wall, not just the diff). */
  warnings: WallWarning[];
}

interface LeafResult {
  wall: Wall;
  inverse: LeafOp;
  changed: boolean;
}

export function applyOp(wall: Wall, op: Op): ApplyResult {
  const result = op.type === 'batch' ? applyBatch(wall, op) : applyLeaf(wall, op);
  const next = result.changed ? { ...result.wall, rev: wall.rev + 1 } : wall;
  return {
    wall: next,
    inverse: result.inverse,
    changed: result.changed,
    warnings: checkWall(next),
  };
}

function applyBatch(wall: Wall, op: BatchOp): { wall: Wall; inverse: BatchOp; changed: boolean } {
  let current = wall;
  let changed = false;
  const inverses: LeafOp[] = [];
  for (const [index, leaf] of op.ops.entries()) {
    try {
      const result = applyLeaf(current, leaf);
      current = result.wall;
      changed ||= result.changed;
      inverses.push(result.inverse);
    } catch (error) {
      if (error instanceof OpError) throw new OpError(error.code, error.message, index);
      throw error;
    }
  }
  const inverse: BatchOp = {
    type: 'batch',
    ops: inverses.reverse(),
    ...(op.label === undefined ? {} : { label: op.label }),
  };
  return { wall: current, inverse, changed };
}

function applyLeaf(wall: Wall, op: LeafOp): LeafResult {
  switch (op.type) {
    case 'addItem':
      return addItem(wall, op);
    case 'removeItem':
      return removeItem(wall, op);
    case 'moveItem':
      return moveItem(wall, op);
    case 'rotateItem':
      return rotateItem(wall, op);
    case 'setParams':
      return setParams(wall, op);
    case 'setVariant':
      return setVariant(wall, op);
    case 'lock':
      return lock(wall, op);
    case 'attachItem':
      return attachItem(wall, op);
    case 'addPhoto':
      return addPhoto(wall, op);
    case 'removePhoto':
      return removePhoto(wall, op);
    case 'setCalibration':
      return setCalibration(wall, op);
    case 'setBoard':
      return setBoard(wall, op);
    case 'rename':
      return rename(wall, op);
    case 'addModelRef':
      return addModelRef(wall, op);
    case 'updateModelRef':
      return updateModelRef(wall, op);
    case 'removeModelRef':
      return removeModelRef(wall, op);
  }
}

// ---- helpers ---------------------------------------------------------------------------------------

type Narrow<T extends LeafOp['type']> = Extract<LeafOp, { type: T }>;

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a).filter((key) => Reflect.get(a, key) !== undefined);
  const bKeys = Object.keys(b).filter((key) => Reflect.get(b, key) !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => sameJson(Reflect.get(a, key), Reflect.get(b, key)));
}

function itemIndex(wall: Wall, id: string): number {
  const index = wall.items.findIndex((item) => item.id === id);
  if (index < 0) throw new OpError('item_not_found', `item ${id} does not exist`);
  return index;
}

function editableItem(wall: Wall, id: string): { item: WallItem; index: number } {
  const index = itemIndex(wall, id);
  const item = wall.items[index];
  if (item === undefined) throw new OpError('item_not_found', `item ${id} does not exist`);
  if (item.locked) throw new OpError('item_locked', `item ${id} is locked`);
  return { item, index };
}

function withItem(wall: Wall, index: number, item: WallItem): Wall {
  return { ...wall, items: wall.items.map((existing, i) => (i === index ? item : existing)) };
}

function insertAt<T>(list: readonly T[], value: T, index: number | undefined): T[] {
  const at = Math.min(index ?? list.length, list.length);
  return [...list.slice(0, at), value, ...list.slice(at)];
}

/** Canonical stored form: derived x/y for snapped items, angles in [0, 360). */
function normalizeItem(board: Board, item: WallItem): WallItem {
  const pose: Pose = {
    ...item.pose,
    rotX: normalizeDeg(item.pose.rotX),
    rotY: normalizeDeg(item.pose.rotY),
    rotZ: normalizeDeg(item.pose.rotZ),
  };
  if (item.cell !== undefined) Object.assign(pose, cellCenter(board, item.cell));
  return { ...item, pose };
}

function assertReferencable(item: WallItem): void {
  if (item.kind === 'photo-ref') {
    if (item.photoId === undefined)
      throw new OpError('invalid_op', `${item.id}: photo-ref requires photoId`);
  } else if (item.bankId === undefined && item.modelRefId === undefined) {
    throw new OpError('invalid_op', `${item.id}: ${item.kind} requires bankId or modelRefId`);
  }
}

function noop(wall: Wall, inverse: LeafOp): LeafResult {
  return { wall, inverse, changed: false };
}

// ---- items -----------------------------------------------------------------------------------------

function addItem(wall: Wall, op: Narrow<'addItem'>): LeafResult {
  if (wall.items.some((item) => item.id === op.item.id)) {
    throw new OpError('item_exists', `item ${op.item.id} already exists`);
  }
  assertReferencable(op.item);
  const item = normalizeItem(wall.board, op.item);
  return {
    wall: { ...wall, items: insertAt(wall.items, item, op.index) },
    inverse: { type: 'removeItem', id: item.id },
    changed: true,
  };
}

function removeItem(wall: Wall, op: Narrow<'removeItem'>): LeafResult {
  const { item, index } = editableItem(wall, op.id);
  return {
    wall: { ...wall, items: wall.items.filter((_, i) => i !== index) },
    inverse: { type: 'addItem', item, index },
    changed: true,
  };
}

function moveItem(wall: Wall, op: Narrow<'moveItem'>): LeafResult {
  const { item, index } = editableItem(wall, op.id);
  const z = op.to.z ?? item.pose.z;
  const inverse: LeafOp = {
    type: 'moveItem',
    id: op.id,
    to:
      item.cell === undefined
        ? { x: item.pose.x, y: item.pose.y, z: item.pose.z }
        : { cell: item.cell, z: item.pose.z },
  };
  let next: WallItem;
  if ('cell' in op.to) {
    const center = cellCenter(wall.board, op.to.cell);
    next = { ...item, cell: op.to.cell, pose: { ...item.pose, ...center, z } };
  } else {
    const { cell: _previousCell, ...free } = item;
    next = { ...free, pose: { ...item.pose, x: op.to.x, y: op.to.y, z } };
  }
  if (sameJson(next, item)) return noop(wall, inverse);
  return { wall: withItem(wall, index, next), inverse, changed: true };
}

function rotateItem(wall: Wall, op: Narrow<'rotateItem'>): LeafResult {
  const { item, index } = editableItem(wall, op.id);
  if (op.rotX === undefined && op.rotY === undefined && op.rotZ === undefined) {
    throw new OpError('invalid_op', 'rotateItem needs at least one of rotX, rotY, rotZ');
  }
  const inverse: Narrow<'rotateItem'> = { type: 'rotateItem', id: op.id };
  const pose: Pose = { ...item.pose };
  if (op.rotX !== undefined) {
    inverse.rotX = item.pose.rotX;
    pose.rotX = normalizeDeg(op.rotX);
  }
  if (op.rotY !== undefined) {
    inverse.rotY = item.pose.rotY;
    pose.rotY = normalizeDeg(op.rotY);
  }
  if (op.rotZ !== undefined) {
    inverse.rotZ = item.pose.rotZ;
    pose.rotZ = normalizeDeg(op.rotZ);
  }
  if (sameJson(pose, item.pose)) return noop(wall, inverse);
  return { wall: withItem(wall, index, { ...item, pose }), inverse, changed: true };
}

function setParams(wall: Wall, op: Narrow<'setParams'>): LeafResult {
  const { item, index } = editableItem(wall, op.id);
  const set = op.set ?? {};
  const unset = op.unset ?? [];
  const overlap = unset.find((key) => key in set);
  if (overlap !== undefined) {
    throw new OpError('invalid_op', `param ${overlap} is both set and unset`);
  }
  const params = { ...item.params };
  const restoreSet: Record<string, number> = {};
  const restoreUnset: string[] = [];
  for (const key of [...Object.keys(set), ...unset]) {
    const previous = item.params[key];
    if (previous === undefined) restoreUnset.push(key);
    else restoreSet[key] = previous;
  }
  Object.assign(params, set);
  for (const key of unset) delete params[key];
  const inverse: Narrow<'setParams'> = {
    type: 'setParams',
    id: op.id,
    ...(Object.keys(restoreSet).length > 0 ? { set: restoreSet } : {}),
    ...(restoreUnset.length > 0 ? { unset: restoreUnset } : {}),
  };
  if (sameJson(params, item.params)) return noop(wall, inverse);
  return { wall: withItem(wall, index, { ...item, params }), inverse, changed: true };
}

function setVariant(wall: Wall, op: Narrow<'setVariant'>): LeafResult {
  const { item, index } = editableItem(wall, op.id);
  const inverse: Narrow<'setVariant'> = {
    type: 'setVariant',
    id: op.id,
    variantId: item.variantId ?? null,
    ...(op.bankId === undefined ? {} : { bankId: item.bankId ?? null }),
  };
  const { variantId: _variant, ...rest } = item;
  let next: WallItem = op.variantId === null ? rest : { ...rest, variantId: op.variantId };
  if (op.bankId !== undefined) {
    const { bankId: _bank, ...withoutBank } = next;
    next = op.bankId === null ? withoutBank : { ...withoutBank, bankId: op.bankId };
  }
  assertReferencable(next);
  if (sameJson(next, item)) return noop(wall, inverse);
  return { wall: withItem(wall, index, next), inverse, changed: true };
}

function lock(wall: Wall, op: Narrow<'lock'>): LeafResult {
  const index = itemIndex(wall, op.id);
  const item = wall.items[index];
  if (item === undefined) throw new OpError('item_not_found', `item ${op.id} does not exist`);
  const inverse: LeafOp = { type: 'lock', id: op.id, locked: item.locked };
  if (item.locked === op.locked) return noop(wall, inverse);
  return { wall: withItem(wall, index, { ...item, locked: op.locked }), inverse, changed: true };
}

function attachItem(wall: Wall, op: Narrow<'attachItem'>): LeafResult {
  const { item, index } = editableItem(wall, op.id);
  if (item.kind !== 'tool') {
    throw new OpError('invalid_op', `${op.id}: only tools hang on holders (kind is ${item.kind})`);
  }
  // A parent that no longer exists is allowed (like `addItem`): removing a holder leaves its tools pointing at
  // it with a `missing_parent` warning, and undoing a later re-attach has to be able to restore that state.
  const parent =
    op.parentId === null ? undefined : wall.items.find((candidate) => candidate.id === op.parentId);
  if (parent !== undefined && parent.kind !== 'holder') {
    throw new OpError('invalid_op', `${op.id}: ${op.parentId} is not a holder`);
  }
  const inverse: LeafOp = {
    type: 'attachItem',
    id: op.id,
    parentId: item.parentId ?? null,
    slot: item.slot ?? null,
  };
  const { parentId: _parent, slot: _slot, ...rest } = item;
  const slot = op.slot ?? undefined;
  // `parentId: null` with a slot restores a stored slot-without-parent item (the inverse of detaching one).
  const next: WallItem = {
    ...rest,
    ...(op.parentId === null ? {} : { parentId: op.parentId }),
    ...(slot === undefined ? {} : { slot }),
  };
  if (sameJson(next, item)) return noop(wall, inverse);
  return { wall: withItem(wall, index, next), inverse, changed: true };
}

// ---- photos ----------------------------------------------------------------------------------------

function photoIndex(wall: Wall, id: string): number {
  const index = wall.photos.findIndex((photo) => photo.id === id);
  if (index < 0) throw new OpError('photo_not_found', `photo ${id} does not exist`);
  return index;
}

function addPhoto(wall: Wall, op: Narrow<'addPhoto'>): LeafResult {
  if (wall.photos.some((photo) => photo.id === op.photo.id)) {
    throw new OpError('photo_exists', `photo ${op.photo.id} already exists`);
  }
  return {
    wall: { ...wall, photos: insertAt(wall.photos, op.photo, op.index) },
    inverse: { type: 'removePhoto', id: op.photo.id },
    changed: true,
  };
}

function removePhoto(wall: Wall, op: Narrow<'removePhoto'>): LeafResult {
  const index = photoIndex(wall, op.id);
  const photo = wall.photos[index];
  if (photo === undefined) throw new OpError('photo_not_found', `photo ${op.id} does not exist`);
  return {
    wall: { ...wall, photos: wall.photos.filter((_, i) => i !== index) },
    inverse: { type: 'addPhoto', photo, index },
    changed: true,
  };
}

function setCalibration(wall: Wall, op: Narrow<'setCalibration'>): LeafResult {
  const index = photoIndex(wall, op.photoId);
  const photo = wall.photos[index];
  if (photo === undefined)
    throw new OpError('photo_not_found', `photo ${op.photoId} does not exist`);
  const inverse: LeafOp = {
    type: 'setCalibration',
    photoId: op.photoId,
    calibration: photo.calibration ?? null,
  };
  const { calibration: _old, ...rest } = photo;
  const next = op.calibration === null ? rest : { ...rest, calibration: op.calibration };
  if (sameJson(next, photo)) return noop(wall, inverse);
  return {
    wall: { ...wall, photos: wall.photos.map((p, i) => (i === index ? next : p)) },
    inverse,
    changed: true,
  };
}

// ---- board / name ----------------------------------------------------------------------------------

function setBoard(wall: Wall, op: Narrow<'setBoard'>): LeafResult {
  const inverse: LeafOp = { type: 'setBoard', board: wall.board };
  if (sameJson(op.board, wall.board)) return noop(wall, inverse);
  const board = { ...op.board };
  const items = wall.items.map((item) =>
    item.cell === undefined ? item : normalizeItem(board, item),
  );
  return { wall: { ...wall, board, items }, inverse, changed: true };
}

function rename(wall: Wall, op: Narrow<'rename'>): LeafResult {
  if (op.itemId === undefined) {
    if (op.name === null) throw new OpError('invalid_op', 'the wall name cannot be cleared');
    const inverse: LeafOp = { type: 'rename', name: wall.name };
    if (op.name === wall.name) return noop(wall, inverse);
    return { wall: { ...wall, name: op.name }, inverse, changed: true };
  }
  const { item, index } = editableItem(wall, op.itemId);
  const inverse: LeafOp = { type: 'rename', itemId: op.itemId, name: item.label ?? null };
  const { label: _label, ...rest } = item;
  const next = op.name === null ? rest : { ...rest, label: op.name };
  if (sameJson(next, item)) return noop(wall, inverse);
  return { wall: withItem(wall, index, next), inverse, changed: true };
}

// ---- model refs ------------------------------------------------------------------------------------

function modelIndex(wall: Wall, id: string): number {
  const index = wall.models.findIndex((model) => model.id === id);
  if (index < 0) throw new OpError('model_not_found', `model ${id} does not exist`);
  return index;
}

function addModelRef(wall: Wall, op: Narrow<'addModelRef'>): LeafResult {
  if (wall.models.some((model) => model.id === op.model.id)) {
    throw new OpError('model_exists', `model ${op.model.id} already exists`);
  }
  return {
    wall: { ...wall, models: insertAt(wall.models, op.model, op.index) },
    inverse: { type: 'removeModelRef', id: op.model.id },
    changed: true,
  };
}

function removeModelRef(wall: Wall, op: Narrow<'removeModelRef'>): LeafResult {
  const index = modelIndex(wall, op.id);
  const model = wall.models[index];
  if (model === undefined) throw new OpError('model_not_found', `model ${op.id} does not exist`);
  return {
    wall: { ...wall, models: wall.models.filter((_, i) => i !== index) },
    inverse: { type: 'addModelRef', model, index },
    changed: true,
  };
}

const PATCH_KEYS = ['label', 'status', 'forItemId', 'score', 'notes', 'bankId'] as const;

function updateModelRef(wall: Wall, op: Narrow<'updateModelRef'>): LeafResult {
  const index = modelIndex(wall, op.id);
  const model = wall.models[index];
  if (model === undefined) throw new OpError('model_not_found', `model ${op.id} does not exist`);
  const next: Record<string, unknown> = { ...model };
  const restore: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    const value = op.patch[key];
    if (value === undefined) continue;
    restore[key] = model[key] ?? null;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  const inverse: LeafOp = {
    type: 'updateModelRef',
    id: op.id,
    patch: ModelRefPatchSchema.parse(restore),
  };
  if (sameJson(next, model)) return noop(wall, inverse);
  const updated = ModelRefSchema.parse(next);
  return {
    wall: { ...wall, models: wall.models.map((m, i) => (i === index ? updated : m)) },
    inverse,
    changed: true,
  };
}

// ---- validation ------------------------------------------------------------------------------------

/** Footprints are not known to the core, so only items anchored to the same cell can collide. */
const COLLIDING_KINDS: ReadonlySet<string> = new Set(['holder', 'board-part']);
const POSE_EPSILON_MM = 1e-6;

/** Non-fatal problems of a wall; an empty list means a clean layout. */
export function checkWall(wall: Wall): WallWarning[] {
  const warnings: WallWarning[] = [];
  const size = boardSizeMm(wall.board);
  const photoIds = new Set(wall.photos.map((photo) => photo.id));
  const modelIds = new Set(wall.models.map((model) => model.id));
  const byCell = new Map<string, string[]>();
  const kindById = new Map(wall.items.map((item) => [item.id, item.kind]));
  const bySlot = new Map<string, string[]>();
  for (const item of wall.items) {
    if (item.cell !== undefined) {
      if (!cellInBoard(wall.board, item.cell)) {
        warnings.push({
          code: 'cell_out_of_board',
          message: `item ${item.id} is on cell ${item.cell.col},${item.cell.row}, outside the ${wall.board.cols}x${wall.board.rows} board`,
          itemIds: [item.id],
        });
      }
      if (COLLIDING_KINDS.has(item.kind)) {
        const key = `${item.cell.col},${item.cell.row}`;
        byCell.set(key, [...(byCell.get(key) ?? []), item.id]);
      }
      if (
        COLLIDING_KINDS.has(item.kind) &&
        Math.abs(
          item.pose.rotZ / HEX_SYMMETRY_DEG - Math.round(item.pose.rotZ / HEX_SYMMETRY_DEG),
        ) > 1e-9
      ) {
        warnings.push({
          code: 'rotation_off_symmetry',
          message: `item ${item.id} is rotated ${item.pose.rotZ} deg, not a multiple of ${HEX_SYMMETRY_DEG}`,
          itemIds: [item.id],
        });
      }
    }
    const { x, y } = item.pose;
    if (
      x < -POSE_EPSILON_MM ||
      x > size.width + POSE_EPSILON_MM ||
      y < -POSE_EPSILON_MM ||
      y > size.height + POSE_EPSILON_MM
    ) {
      warnings.push({
        code: 'out_of_board',
        message: `item ${item.id} at ${x.toFixed(1)},${y.toFixed(1)} mm is outside the ${size.width.toFixed(0)}x${size.height.toFixed(0)} mm board`,
        itemIds: [item.id],
      });
    }
    if (item.parentId !== undefined) {
      const parentKind = kindById.get(item.parentId);
      if (parentKind === undefined) {
        warnings.push({
          code: 'missing_parent',
          message: `item ${item.id} refers to missing holder ${item.parentId}`,
          itemIds: [item.id],
        });
      } else if (parentKind !== 'holder') {
        warnings.push({
          code: 'parent_not_holder',
          message: `item ${item.id} hangs on ${item.parentId}, which is a ${parentKind}, not a holder`,
          itemIds: [item.id, item.parentId],
        });
      }
      if (item.slot !== undefined) {
        const key = `${item.parentId}#${item.slot}`;
        const group = bySlot.get(key);
        if (group === undefined) bySlot.set(key, [item.id]);
        else group.push(item.id);
      }
    } else if (item.slot !== undefined) {
      warnings.push({
        code: 'slot_without_parent',
        message: `item ${item.id} claims mount slot ${item.slot} but hangs on no holder`,
        itemIds: [item.id],
      });
    }
    const photoRefs = [item.photoId, item.source.photoId];
    for (const photoId of photoRefs) {
      if (photoId !== undefined && !photoIds.has(photoId)) {
        warnings.push({
          code: 'missing_photo',
          message: `item ${item.id} refers to missing photo ${photoId}`,
          itemIds: [item.id],
        });
      }
    }
    if (item.modelRefId !== undefined && !modelIds.has(item.modelRefId)) {
      warnings.push({
        code: 'missing_model',
        message: `item ${item.id} refers to missing model ${item.modelRefId}`,
        itemIds: [item.id],
      });
    }
  }
  for (const [cell, ids] of byCell) {
    if (ids.length > 1) {
      warnings.push({
        code: 'cell_collision',
        message: `cell ${cell} is occupied by ${ids.join(', ')}`,
        itemIds: ids,
      });
    }
  }
  for (const [slot, ids] of bySlot) {
    if (ids.length > 1) {
      warnings.push({
        code: 'slot_collision',
        message: `mount slot ${slot} holds ${ids.join(', ')}`,
        itemIds: ids,
      });
    }
  }
  return warnings;
}

/** Hard structural invariants (unique ids); a stored wall violating them is corrupt. */
export function checkIntegrity(wall: Wall): string[] {
  const problems: string[] = [];
  const duplicates = (label: string, ids: readonly string[]): void => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`duplicate ${label} id ${id}`);
      seen.add(id);
    }
  };
  duplicates(
    'item',
    wall.items.map((item) => item.id),
  );
  duplicates(
    'photo',
    wall.photos.map((photo) => photo.id),
  );
  duplicates(
    'model',
    wall.models.map((model) => model.id),
  );
  return problems;
}
