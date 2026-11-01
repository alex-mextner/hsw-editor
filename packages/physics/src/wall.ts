/**
 * Physics of a whole wall: every hung tool judged in the pose it is in, against the holder it hangs on and
 * everything around it. Pure and deterministic; the caller supplies posed meshes and masses.
 */
import { physicsRating } from '@hsw-editor/compat';
import type { ManifoldToplevel } from 'manifold-3d';
import { SolidBody, type Placement, type ToolBody } from './body.ts';
import { analyseHangPose, type HangOptions, type HangReason, type HangReport } from './hang.ts';
import { RemovalProbe, type RemovalOptions, type RemovalReport } from './removal.ts';

export interface WallTool {
  /** Wall item id. */
  id: string;
  body: ToolBody;
  placement: Placement;
  /** Holder item id the tool hangs on (`parentId`); tools without one are not judged. */
  holderId: string | null;
  /** Largest mass (g) the holder's mount carries per tool; undefined = unchecked. */
  maxLoadG?: number | undefined;
  /** How far (mm) the tool may reach below the holder; undefined = unchecked (see `protrudeLimitMm`). */
  protrudeLimitMm?: number | undefined;
}

export interface WallHolder {
  /** Wall item id (also the id of the body). */
  id: string;
  body: SolidBody;
}

export interface WallPhysicsInput {
  tools: readonly WallTool[];
  holders: readonly WallHolder[];
  /** Shelves, board parts and other solids that are not holders. */
  others?: readonly SolidBody[];
  hang?: Partial<HangOptions>;
  removal?: Partial<RemovalOptions>;
  /** manifold-3d: when given, removal is analysed too. */
  wasm?: ManifoldToplevel;
}

export type ProblemSeverity = 'error' | 'warning';

/** One thing a user should know about a tool, with parameters for a localised sentence. */
export interface PhysicsProblem {
  /** `levitating`, `penetrates`, `falls`, `tips`, `swings`, `slides_off`, `needs_retention`, `wedged`, `protrudes`, `overloaded`, `removal_blocked`, `removal_needs_tilt`, `removal_two_hands`. */
  code: string;
  severity: ProblemSeverity;
  params: Readonly<Record<string, number | string | readonly string[]>>;
}

export interface ToolPhysics {
  toolId: string;
  holderId: string;
  hang: HangReport;
  removal: RemovalReport | null;
  problems: PhysicsProblem[];
  /** Hang score and removal convenience folded into one 0..1 rating (hang counts twice as much). */
  rating: number;
}

export interface WallPhysicsReport {
  tools: ToolPhysics[];
  /** Tools with at least one problem. */
  flagged: number;
}

const HANG_ERRORS: ReadonlySet<HangReason['code']> = new Set<HangReason['code']>([
  'levitating',
  'penetrates',
  'falls',
  'tips',
  'wedged',
  'overloaded',
]);

export function hangProblems(report: HangReport): PhysicsProblem[] {
  return report.reasons.map((r) => ({
    code: r.code,
    severity: HANG_ERRORS.has(r.code) ? 'error' : 'warning',
    params: r.params,
  }));
}

export function removalProblems(report: RemovalReport): PhysicsProblem[] {
  switch (report.verdict) {
    case 'free':
      return [];
    case 'needs_tilt':
      return [
        { code: 'removal_needs_tilt', severity: 'warning', params: { path: report.path ?? '' } },
      ];
    case 'needs_two_hands':
      return [
        {
          code: 'removal_two_hands',
          severity: 'warning',
          params: { reasons: report.reasons.map((r) => r.code), path: report.path ?? '' },
        },
      ];
    case 'blocked':
      return [
        { code: 'removal_blocked', severity: 'error', params: { blockedBy: report.blockedBy } },
      ];
  }
}

/** One hung tool judged on its holder against everything around it (other tools at their own poses). */
function analyseTool(
  item: WallTool,
  holderId: string,
  holder: WallHolder,
  input: WallPhysicsInput,
  toolSolids: ReadonlyMap<string, SolidBody>,
  probe: RemovalProbe | null,
): ToolPhysics {
  const neighbours = [...input.holders.map((h) => h.body), ...(input.others ?? [])].filter(
    (b) => b !== holder.body,
  );
  // Other tools are obstacles at their own poses.
  const obstacles = [
    holder.body,
    ...neighbours,
    ...[...toolSolids].filter(([id]) => id !== item.id).map(([, body]) => body),
  ];
  const hang = analyseHangPose({
    tool: item.body,
    placement: item.placement,
    obstacles,
    holder: holder.body,
    options: {
      ...input.hang,
      ...(item.maxLoadG === undefined ? {} : { maxLoadG: item.maxLoadG }),
      ...(item.protrudeLimitMm === undefined ? {} : { protrudeLimitMm: item.protrudeLimitMm }),
    },
  });
  const seat = hang.rest?.placement ?? item.placement;
  const removal =
    probe === null
      ? null
      : probe.analyse({
          tool: item.body,
          placement: seat,
          holder: holder.body,
          neighbours: obstacles.filter((b) => b !== holder.body),
          ...(input.removal ? { options: input.removal } : {}),
        });
  const problems = [...hangProblems(hang), ...(removal ? removalProblems(removal) : [])];
  return {
    toolId: item.id,
    holderId,
    hang,
    removal,
    problems,
    rating: physicsRating({ stability: hang.score, convenience: removal?.convenience ?? null }),
  };
}

export function analyseWallPhysics(input: WallPhysicsInput): WallPhysicsReport {
  const probe = input.wasm === undefined ? null : new RemovalProbe(input.wasm);
  const holderById = new Map(input.holders.map((h) => [h.id, h]));
  const tools: ToolPhysics[] = [];
  // Every hung tool is an obstacle for the others, at its own pose; built once.
  const toolSolids = new Map(
    input.tools.map((t) => [
      t.id,
      new SolidBody(t.id, t.body.mesh, t.placement.rotation, t.placement.position),
    ]),
  );
  for (const item of input.tools) {
    if (item.holderId === null) continue;
    const holder = holderById.get(item.holderId);
    if (holder === undefined) continue;
    tools.push(analyseTool(item, item.holderId, holder, input, toolSolids, probe));
  }
  probe?.dispose();
  return { tools, flagged: tools.filter((t) => t.problems.length > 0).length };
}
