/**
 * Wall -> engine scene: which solid each item is, and where it stands right now (live drag poses included).
 * Pure: the editor-specific lookups (bank models, tool boxes) are injected, so this stays testable under bun.
 */
import type { Aabb, WallItem } from '@hsw-editor/core';
import type { EngineItem } from './engine.ts';
import type { SolidSource } from './protocol.ts';

export interface ItemSolid {
  readonly solidKey: string;
  readonly source: SolidSource;
}

export interface LivePose {
  readonly x: number;
  readonly y: number;
  readonly rotZ: number;
}

export interface EngineScene {
  readonly items: EngineItem[];
  readonly sources: Map<string, SolidSource>;
}

/** Items without a solid (photo references, unresolvable models) are left out. */
export function engineScene(
  items: readonly WallItem[],
  solidOf: (item: WallItem) => ItemSolid | null,
  dragging: ReadonlyMap<string, LivePose>,
): EngineScene {
  const scene: EngineScene = { items: [], sources: new Map() };
  for (const item of items) {
    const solid = solidOf(item);
    if (!solid) continue;
    scene.sources.set(solid.solidKey, solid.source);
    const live = dragging.get(item.id);
    scene.items.push({
      id: item.id,
      kind: item.kind,
      parentId: item.parentId,
      solidKey: solid.solidKey,
      pose: live ? { ...item.pose, x: live.x, y: live.y, rotZ: live.rotZ } : item.pose,
    });
  }
  return scene;
}

/** Local-frame box from the centre/size pair the editor uses for models and tool stand-ins. */
export function boxFromCentreDims(
  centre: { x: number; y: number; z: number },
  dims: { x: number; y: number; z: number },
): Aabb {
  return {
    min: { x: centre.x - dims.x / 2, y: centre.y - dims.y / 2, z: centre.z - dims.z / 2 },
    max: { x: centre.x + dims.x / 2, y: centre.y + dims.y / 2, z: centre.z + dims.z / 2 },
  };
}
