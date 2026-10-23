import type { ToolPhysics, WallPhysicsReport } from '@hsw-editor/physics';

export type RowSeverity = 'error' | 'warning';

export interface ReportRow {
  readonly physics: ToolPhysics;
  /** `error` when any problem is an error (the tool is drawn striped), else `warning` (outline only). */
  readonly severity: RowSeverity;
}

export function severityOf(physics: ToolPhysics): RowSeverity | null {
  if (physics.problems.length === 0) return null;
  return physics.problems.some((problem) => problem.severity === 'error') ? 'error' : 'warning';
}

/** Tools with problems, errors first, then the worst rating first; ties keep a stable order by id. */
export function reportRows(report: WallPhysicsReport | null): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const physics of report?.tools ?? []) {
    const severity = severityOf(physics);
    if (severity !== null) rows.push({ physics, severity });
  }
  return rows.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.physics.rating !== b.physics.rating) return a.physics.rating - b.physics.rating;
    return a.physics.toolId < b.physics.toolId ? -1 : a.physics.toolId > b.physics.toolId ? 1 : 0;
  });
}
