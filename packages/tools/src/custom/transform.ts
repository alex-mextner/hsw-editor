import { scaling } from '../math.ts';
import { transformMesh } from '../mesh.ts';
import { type ToolModel, boundsOfParts, buildHolding, totalTriangles } from '../model.ts';

/**
 * Scale a built model along Z (thickness) about the axis; bounds and holding interface are recomputed.
 * Non-uniform scaling keeps every shell closed and outward oriented.
 */
export function scaleMeshZ(model: ToolModel, factor: number): ToolModel {
  const parts = model.parts.map((p) => ({
    ...p,
    mesh: transformMesh(p.mesh, scaling(1, 1, factor)),
  }));
  const bounds = boundsOfParts(parts);
  return {
    ...model,
    parts,
    bounds,
    holding: buildHolding(
      {
        parts,
        zones: model.holding.zones.map((z) => ({ name: z.name, y0: z.y0, y1: z.y1 })),
        dims: model.holding.dims,
        ...(model.holding.hang
          ? {
              hang: {
                ...model.holding.hang,
                point: [
                  model.holding.hang.point[0],
                  model.holding.hang.point[1],
                  model.holding.hang.point[2] * factor,
                ] as const,
              },
            }
          : {}),
      },
      bounds,
      model.lod === 0 ? 2 : 4,
    ),
    triangles: totalTriangles(parts),
  };
}
