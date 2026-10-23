import type { Op } from '@hsw-editor/core';
import type { MessageKey } from '@/i18n/index.ts';

export interface OpDescription {
  readonly key: MessageKey;
  /** Number of ops merged into this entry (batches); shown as a multiplier when above one. */
  readonly count?: number;
}

/** Message key summarising an op for the history strip; same-type batches show the shared action times N. */
export function describeOp(op: Op): OpDescription {
  switch (op.type) {
    case 'addItem':
      return { key: 'history.addItem' };
    case 'removeItem':
      return { key: 'history.removeItem' };
    case 'moveItem':
      return { key: 'history.moveItem' };
    case 'rotateItem':
      return { key: 'history.rotateItem' };
    case 'setParams':
      return { key: 'history.setParams' };
    case 'setVariant':
      return { key: 'history.setVariant' };
    case 'lock':
      return { key: op.locked ? 'history.lock' : 'history.unlock' };
    case 'attachItem':
      return { key: 'history.attachItem' };
    case 'addPhoto':
      return { key: 'history.addPhoto' };
    case 'removePhoto':
      return { key: 'history.removePhoto' };
    case 'setCalibration':
      return { key: 'history.setCalibration' };
    case 'setBoard':
      return { key: 'history.setBoard' };
    case 'rename':
      return { key: 'history.rename' };
    case 'addModelRef':
    case 'updateModelRef':
    case 'removeModelRef':
      return { key: 'history.modelRef' };
    case 'batch': {
      const first = op.ops[0];
      const uniform = first !== undefined && op.ops.every((leaf) => leaf.type === first.type);
      if (!uniform) return { key: 'history.batch', count: op.ops.length };
      return { ...describeOp(first), count: op.ops.length };
    }
  }
}
