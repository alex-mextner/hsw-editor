import { describe, expect, test } from 'bun:test';
import type { InputRequest } from '@/api/requests.ts';
import { applyRequestEvent, parseRequestEvent, sortRequests } from './requestsLogic.ts';

const compare = {
  id: 'r1',
  kind: 'compare',
  status: 'open',
  createdBy: { kind: 'agent', name: 'omp' },
  createdAt: '2026-10-22T10:00:00.000Z',
  payload: { modelRefIds: ['m1', 'm2'] },
};

function opened(overrides: Record<string, unknown> = {}): InputRequest {
  const event = parseRequestEvent('request_input', { request: { ...compare, ...overrides } });
  if (event?.type !== 'opened') throw new Error('fixture must parse');
  return event.request;
}

describe('parseRequestEvent', () => {
  test('reads a request_input event from an object and from raw SSE text', () => {
    const fromObject = parseRequestEvent('request_input', { request: compare });
    const fromText = parseRequestEvent('request_input', JSON.stringify({ request: compare }));
    expect(fromObject?.type).toBe('opened');
    expect(fromText).toEqual(fromObject);
  });

  test('parses every kind with its payload', () => {
    const dimension = parseRequestEvent('request_input', {
      request: {
        ...compare,
        id: 'r2',
        kind: 'dimension',
        itemId: 'i1',
        payload: { fields: [{ key: 'length', unit: 'mm', fitted: 41.2, min: 10 }] },
      },
    });
    const calibration = parseRequestEvent('request_input', {
      request: { ...compare, id: 'r3', kind: 'calibration', payload: { photoId: 'p1' } },
    });
    expect(dimension?.type === 'opened' && dimension.request.kind).toBe('dimension');
    expect(calibration?.type === 'opened' && calibration.request.kind).toBe('calibration');
    if (calibration?.type === 'opened' && calibration.request.kind === 'calibration') {
      expect(calibration.request.payload.mode).toBe('two-point');
    }
  });

  test('ignores unknown kinds, malformed payloads, broken JSON and unknown events', () => {
    expect(
      parseRequestEvent('request_input', { request: { ...compare, kind: 'teleport' } }),
    ).toBeNull();
    expect(
      parseRequestEvent('request_input', { request: { ...compare, payload: { fields: 3 } } }),
    ).toBeNull();
    expect(parseRequestEvent('request_input', '{not json')).toBeNull();
    expect(parseRequestEvent('request_input', null)).toBeNull();
    expect(parseRequestEvent('op', { request: compare })).toBeNull();
    expect(parseRequestEvent('request_resolved', { id: '' })).toBeNull();
  });

  test('reads request_resolved', () => {
    expect(
      parseRequestEvent('request_resolved', { id: 'r1', status: 'answered', answer: {} }),
    ).toEqual({
      type: 'resolved',
      id: 'r1',
      status: 'answered',
    });
  });
});

describe('applyRequestEvent', () => {
  test('keeps requests ordered by creation time and replaces a re-announced one', () => {
    const late = opened({ id: 'late', createdAt: '2026-10-22T11:00:00.000Z' });
    const early = opened({ id: 'early', createdAt: '2026-10-22T09:00:00.000Z' });
    let list: readonly InputRequest[] = [];
    list = applyRequestEvent(list, { type: 'opened', request: late });
    list = applyRequestEvent(list, { type: 'opened', request: early });
    list = applyRequestEvent(list, { type: 'opened', request: early });
    expect(list.map((entry) => entry.id)).toEqual(['early', 'late']);
  });

  test('drops a request once it is resolved by anyone', () => {
    const list = applyRequestEvent([opened()], { type: 'resolved', id: 'r1', status: 'cancelled' });
    expect(list).toEqual([]);
  });

  test('never lists a request that arrives already closed', () => {
    const closed = opened({ status: 'answered' });
    expect(applyRequestEvent([], { type: 'opened', request: closed })).toEqual([]);
  });
});

describe('sortRequests', () => {
  test('numeric and ISO timestamps compare on one scale; ties fall back to the id', () => {
    const a = opened({ id: 'b', createdAt: 1000 });
    const b = opened({ id: 'a', createdAt: 1000 });
    expect(sortRequests([a, b]).map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});
