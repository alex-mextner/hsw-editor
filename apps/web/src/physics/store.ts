/**
 * State of the wall physics check (tool hang stability and removal ergonomics, `@hsw-editor/physics`): the last
 * report and whether a check is running. Module-level so panels, the viewport overlay and the palette read the
 * same report. `runPhysicsCheck` (run.ts) fills it.
 */
import { createValueStore } from '#state-backend';
import type { PhysicsProblem, ToolPhysics, WallPhysicsReport } from '@hsw-editor/physics';

export type PhysicsView =
  | { readonly status: 'idle' }
  | { readonly status: 'running'; readonly previous: WallPhysicsReport | null }
  | { readonly status: 'ready'; readonly report: WallPhysicsReport; readonly at: number }
  | { readonly status: 'error'; readonly message: string };

export const physicsStore = createValueStore<PhysicsView>({ status: 'idle' });

/** The last finished report (also while a newer check runs), or null. */
export function reportOf(view: PhysicsView): WallPhysicsReport | null {
  if (view.status === 'ready') return view.report;
  if (view.status === 'running') return view.previous;
  return null;
}

/** Physics verdict of one wall tool item, or undefined when it was not analysed (no holder, no model yet). */
export function toolPhysics(view: PhysicsView, itemId: string): ToolPhysics | undefined {
  return reportOf(view)?.tools.find((t) => t.toolId === itemId);
}

/** Problems of one tool (empty when fine or unknown). */
export function toolProblems(view: PhysicsView, itemId: string): readonly PhysicsProblem[] {
  return toolPhysics(view, itemId)?.problems ?? [];
}
