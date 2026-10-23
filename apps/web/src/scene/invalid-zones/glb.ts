/**
 * Flattens a bank GLB (meshopt-compressed, one or more meshes, node transforms) into one triangle soup in the
 * GLB root frame, millimetres: the frame the item pose applies to (`InstancedModel` draws the same root-relative
 * mesh transforms). Runs in a Web Worker and under bun (no DOM needed: bank GLBs carry no textures).
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Matrix4, type InstancedMesh, type Mesh } from 'three';
import type { SolidMesh } from './engine.ts';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

export async function readGlbSolid(glb: ArrayBuffer): Promise<SolidMesh> {
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
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
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
