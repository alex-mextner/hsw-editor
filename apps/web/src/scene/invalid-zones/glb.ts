/**
 * Flattens a bank GLB (meshopt-compressed, one or more meshes, node transforms) into one triangle soup in the
 * GLB root frame, millimetres: the frame the item pose applies to (`InstancedModel` draws the same root-relative
 * mesh transforms). Runs in a Web Worker and under bun (no DOM needed: bank GLBs carry no textures).
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {
  Color,
  Matrix4,
  SRGBColorSpace,
  type InstancedMesh,
  type Material,
  type Mesh,
} from 'three';
import type { SolidMesh } from './engine.ts';
import { isRedish, type ColourPart, type Rgb } from './stripeColour.ts';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

export async function readGlbSolid(glb: ArrayBuffer): Promise<SolidMesh> {
  const gltf = await loader.parseAsync(glb, '');
  gltf.scene.updateMatrixWorld(true);
  const positions: number[] = [];
  const indices: number[] = [];
  const colours: ColourPart[] = [];
  const place = new Matrix4();
  gltf.scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    // Material colour, used as is for a plain mesh and as the factor of the vertex colours for a painted one.
    const base = materialColour(mesh);
    const painted = base && mesh.geometry.getAttribute('color') ? base : null;
    const rgb = base && !painted ? srgb(base) : null;
    // EXT_mesh_gpu_instancing: every instance is a part of the solid.
    const instanced = (node as InstancedMesh).isInstancedMesh ? (node as InstancedMesh) : null;
    for (let copy = 0; copy < (instanced ? instanced.count : 1); copy += 1) {
      if (instanced) {
        instanced.getMatrixAt(copy, place);
        place.premultiply(mesh.matrixWorld);
      } else {
        place.copy(mesh.matrixWorld);
      }
      const first = positions.length;
      const firstIndex = indices.length;
      appendMesh(mesh, place, positions, indices);
      if (positions.length === first) continue;
      if (painted)
        colours.push(...paintedParts(mesh, painted, positions, indices, first, firstIndex));
      else if (rgb) colours.push({ ...boxOf(positions, first), rgb });
    }
  });
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    colours,
  };
}

/**
 * Material colour of a mesh (the first material of a multi-material mesh; GLTFLoader gives every glTF primitive its
 * own mesh, so that is the only one in practice).
 */
function materialColour(mesh: Mesh): Color | null {
  const material: Material | undefined = Array.isArray(mesh.material)
    ? mesh.material[0]
    : mesh.material;
  if (!material || !('color' in material) || !(material.color instanceof Color)) return null;
  return material.color.clone();
}

function srgb(colour: Color): Rgb {
  const rgb = { r: 0, g: 0, b: 0 };
  colour.getRGB(rgb, SRGBColorSpace);
  return [rgb.r, rgb.g, rgb.b];
}

interface Bucket {
  readonly sum: [number, number, number];
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  count: number;
}

const newBucket = (): Bucket => ({
  sum: [0, 0, 0],
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
  count: 0,
});

/**
 * A mesh painted with vertex colours (a red handle and a grey shaft in ONE mesh) split into at most two colour parts:
 * the red-ish triangles and the rest, each with the box of its triangles and the mean colour of its triangles. A
 * triangle on the red/grey border counts for one side by its mean colour, but its box covers all three vertices, so a
 * border box can reach a little into the other part (acceptable: the colour is a heuristic).
 * `first`/`firstIndex` mark what `appendMesh` just appended to `positions`/`indices` (the vertices of this copy).
 */
function paintedParts(
  mesh: Mesh,
  base: Color,
  positions: readonly number[],
  indices: readonly number[],
  first: number,
  firstIndex: number,
): ColourPart[] {
  const attribute = mesh.geometry.getAttribute('color');
  const firstVertex = first / 3;
  const red = newBucket();
  const other = newBucket();
  const triangle = new Color();
  for (let i = firstIndex; i + 2 < indices.length; i += 3) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < 3; k += 1) {
      const local = (indices[i + k] ?? 0) - firstVertex;
      r += attribute.getX(local) / 3;
      g += attribute.getY(local) / 3;
      b += attribute.getZ(local) / 3;
    }
    triangle.setRGB(r, g, b).multiply(base);
    const rgb = srgb(triangle);
    const bucket = isRedish(rgb) ? red : other;
    bucket.count += 1;
    for (let k = 0; k < 3; k += 1) {
      bucket.sum[k] = (bucket.sum[k] ?? 0) + (rgb[k] ?? 0);
      const vertex = (indices[i + k] ?? 0) * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[vertex + axis] ?? 0;
        bucket.min[axis] = Math.min(bucket.min[axis] ?? Infinity, value);
        bucket.max[axis] = Math.max(bucket.max[axis] ?? -Infinity, value);
      }
    }
  }
  return [red, other].flatMap((bucket) =>
    bucket.count === 0
      ? []
      : [
          {
            min: bucket.min,
            max: bucket.max,
            rgb: [
              bucket.sum[0] / (3 * bucket.count),
              bucket.sum[1] / (3 * bucket.count),
              bucket.sum[2] / (3 * bucket.count),
            ] satisfies Rgb,
          },
        ],
  );
}

/** Box of the xyz triples appended to `positions` from float index `from` on. */
function boxOf(positions: readonly number[], from: number): Pick<ColourPart, 'min' | 'max'> {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = from; i + 2 < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis] ?? 0;
      if (value < (min[axis] ?? Infinity)) min[axis] = value;
      if (value > (max[axis] ?? -Infinity)) max[axis] = value;
    }
  }
  return { min, max };
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
