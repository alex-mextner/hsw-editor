/** Test fixtures: a `ToolPhysics` of a given rating and problems. */
import type { PhysicsProblem, ToolPhysics } from '@hsw-editor/physics';

export function physicsOf(
  toolId: string,
  rating: number,
  problems: readonly PhysicsProblem[],
): ToolPhysics {
  return {
    toolId,
    holderId: 'holder',
    hang: {
      score: rating,
      status: rating > 0.7 ? 'stable' : rating > 0.4 ? 'marginal' : 'unstable',
      reasons: [],
      marginsG: { left: 1, right: 1, outward: 1, inward: 1, up: 1, down: 1 },
      massG: 120,
      contactCount: 2,
      penetrationMm: 0,
      swingDeg: null,
      rest: null,
    },
    removal: null,
    problems: [...problems],
    rating,
  };
}

export const errorProblem = (code: string): PhysicsProblem => ({
  code,
  severity: 'error',
  params: {},
});
export const warningProblem = (code: string): PhysicsProblem => ({
  code,
  severity: 'warning',
  params: {},
});
