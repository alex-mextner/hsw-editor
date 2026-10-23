import { describe, expect, test } from 'bun:test';
import { GENERIC_TOOL_CLASS, payloadOf } from './actions.ts';
import { buildEntries } from './model.ts';

const label = { en: 'Screwdriver', ru: 'Отвёртка' };
const CLASS = {
  id: 'screwdriver',
  family: 'drivers',
  familyLabel: label,
  name: label,
  bankClass: 'screwdriver',
  keywords: { en: [], ru: [] },
  schema: {},
  presets: [],
  dimsMm: { x: 20, y: 200, z: 20 },
  holdingDims: { shaftDiameter: 6, width: 18 },
};
const TOOL = {
  id: 'screwdriver',
  name: { en: 'Mine' },
  classId: null,
  bankClass: null,
  dimensionsMm: { length: 100, width: 10, thickness: 10, source: 'photo' as const },
  dimsMm: { x: 10, y: 100, z: 10 },
  holdingDims: {},
  tags: [],
  confidence: 1,
  createdAt: 'a',
  updatedAt: 'b',
  triangles: 1,
};

describe('payloadOf', () => {
  const entries = buildEntries([CLASS], [TOOL]);
  test('a built-in class drags with its bank class, box and measured dimensions', () => {
    const entry = entries.find((candidate) => candidate.key === 'class:screwdriver');
    expect(entry && payloadOf(entry, 'ru')).toEqual({
      toolClass: 'screwdriver',
      label: 'Отвёртка',
      dimsMm: { x: 20, y: 200, z: 20 },
      params: { shaftDiameter: 6 },
      generatorClass: 'screwdriver',
    });
  });
  test('measured dimensions named like the box overrides do not resize the box', () => {
    const entry = entries.find((candidate) => candidate.key === 'class:screwdriver');
    expect(entry && payloadOf(entry, 'en').params).toEqual({ shaftDiameter: 6 });
  });
  test('a user tool carries its id; a generic loft has no bank class', () => {
    const entry = entries.find((candidate) => candidate.key === 'tool:screwdriver');
    expect(entry && payloadOf(entry, 'en')).toMatchObject({
      toolClass: GENERIC_TOOL_CLASS,
      label: 'Mine',
      customToolId: 'screwdriver',
    });
  });
});
