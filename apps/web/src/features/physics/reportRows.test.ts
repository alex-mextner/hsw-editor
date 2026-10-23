import { describe, expect, test } from 'bun:test';
import type { WallPhysicsReport } from '@hsw-editor/physics';
import { errorProblem as error, physicsOf, warningProblem as warning } from './physicsFixtures.ts';
import { reportRows } from './reportRows.ts';

describe('reportRows', () => {
  test('only tools with problems; errors first, then the worst rating, then id', () => {
    const report: WallPhysicsReport = {
      flagged: 5,
      tools: [
        physicsOf('fine', 0.95, []),
        physicsOf('warn-low', 0.2, [warning('swings')]),
        physicsOf('err-high', 0.6, [warning('swings'), error('tips')]),
        physicsOf('err-low-b', 0.1, [error('falls')]),
        physicsOf('err-low-a', 0.1, [error('levitating')]),
      ],
    };
    expect(reportRows(report).map((row) => `${row.physics.toolId}:${row.severity}`)).toEqual([
      'err-low-a:error',
      'err-low-b:error',
      'err-high:error',
      'warn-low:warning',
    ]);
  });

  test('no report, no rows', () => {
    expect(reportRows(null)).toEqual([]);
  });
});
