/**
 * Reads GLB models (bank holders, generated tools) into the triangle soups and rigid-body inputs the physics
 * works on. Runs in the browser, a Web Worker and bun: bank GLBs are meshopt-compressed and carry no textures.
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Matrix4, type InstancedMesh, type Mesh } from 'three';
import type { ToolBody } from './body.ts';

export interface GlbSolid {
  positions: Float32Array;
  indices: Uint32Array;
  /** `extras` of the glTF scene (generated tools: holding interface, parameters, physics). */
  extras: Record<string, unknown>;
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

/** Flattens a GLB (one or more meshes, node transforms, instancing) into one triangle soup in the GLB root frame, mm. */
export async function readGlbSolid(glb: ArrayBuffer): Promise<GlbSolid> {
  const gltf = await loader.parseAsync(glb, '');
  gltf.scene.updateMatrixWorld(true);
  const positions: number[] = [];
  const indices: number[] = [];
  const place = new Matrix4();
  gltf.scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    // EXT_mesh_gpu_instancing: every instance is a part of the solid.
    const instanced = (node as InstancedMesh).isInstancedMesh ? (node as InstancedMesh) : null;
    for (let copy = 0; copy < (instanced ? instanced.count : 1); copy += 1) {
      if (instanced) {
        instanced.getMatrixAt(copy, place);
        place.premultiply(mesh.matrixWorld);
      } else {
        place.copy(mesh.matrixWorld);
      }
      appendMesh(mesh, place, positions, indices);
    }
  });
  const scenes = gltf.parser.json.scenes as { extras?: Record<string, unknown> }[] | undefined;
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    extras: scenes?.[0]?.extras ?? {},
  };
}

function appendMesh(mesh: Mesh, matrix: Matrix4, positions: number[], indices: number[]): void {
  const attribute = mesh.geometry.getAttribute('position');
  const m = matrix.elements;
  const base = positions.length / 3;
  // A mirrored placement (negative determinant) turns triangles inside out: flip the winding back.
  const flip = matrix.determinant() < 0;
  for (let i = 0; i < attribute.count; i += 1) {
    const x = attribute.getX(i);
    const y = attribute.getY(i);
    const z = attribute.getZ(i);
    positions.push(
      (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
      (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
      (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
    );
  }
  const index = mesh.geometry.getIndex();
  const count = index ? index.count : attribute.count;
  for (let i = 0; i + 2 < count; i += 3) {
    const corner = (k: number): number => base + (index ? index.getX(i + k) : i + k);
    indices.push(corner(0), corner(flip ? 2 : 1), corner(flip ? 1 : 2));
  }
}

function numbers3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value as unknown[];
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? [x, y, z] : null;
}

/**
 * A generated tool GLB as a rigid body: mesh, mass and centre of gravity from `extras.physics`, the hang point from
 * `extras.holding.hang`. Null when the file carries no mass (a GLB from before `physics` existed).
 */
export async function readToolBody(id: string, glb: ArrayBuffer): Promise<ToolBody | null> {
  const solid = await readGlbSolid(glb);
  const physics = solid.extras.physics as { massG?: unknown; comMm?: unknown } | undefined;
  const com = numbers3(physics?.comMm);
  if (typeof physics?.massG !== 'number' || com === null) return null;
  const holding = solid.extras.holding as
    | { hang?: { point?: unknown; kind?: unknown; diameterMm?: unknown } | null }
    | undefined;
  const hangPoint = numbers3(holding?.hang?.point);
  const hang =
    hangPoint !== null && typeof holding?.hang?.kind === 'string'
      ? {
          point: hangPoint,
          kind: holding.hang.kind,
          diameterMm:
            typeof holding.hang.diameterMm === 'number' ? holding.hang.diameterMm : undefined,
        }
      : undefined;
  return { id, mesh: solid, massG: physics.massG, comMm: com, hang };
}
