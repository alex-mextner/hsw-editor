import { describe, expect, test } from 'bun:test';
import { ToolSummarySchema } from './api.ts';

const SUMMARY = {
  id: 'socket',
  name: { en: 'Socket' },
  classId: 'socket',
  bankClass: 'socket',
  dimsMm: { x: 20, y: 45, z: 20 },
  holdingDims: {},
  tags: [],
  confidence: 0.8,
  createdAt: '2026-10-23T10:00:00Z',
  updatedAt: '2026-10-23T10:00:00Z',
  triangles: 100,
};

describe('ToolSummarySchema', () => {
  test.each(['photo', 'user', 'estimated'])('accepts a size whose source is %s', (source) => {
    const parsed = ToolSummarySchema.safeParse({
      ...SUMMARY,
      dimensionsMm: { length: 45, width: 20, thickness: 20, source },
    });
    expect(parsed.success).toBe(true);
  });

  test('refuses an unknown size source', () => {
    const parsed = ToolSummarySchema.safeParse({
      ...SUMMARY,
      dimensionsMm: { length: 45, width: 20, thickness: 20, source: 'guess' },
    });
    expect(parsed.success).toBe(false);
  });
});
