/**
 * Mass, centre of gravity and inertia tensor of a generated tool.
 *
 * Every part is one closed outward-oriented shell, so volume, centroid and second moments are exact
 * surface integrals (divergence theorem: each triangle spans a tetrahedron with the origin; Tonon /
 * Eberly closed forms). Parts are then combined with the parallel-axis theorem. A part's mass is
 * `volume * density * fill`, where `fill` stands in for the hollowness of real tools whose generated
 * meshes are solid shells (plastic housings, hollow-ground blades, ...). `fill` scales mass uniformly
 * through the part, i.e. the part is treated as a homogeneous body of reduced density.
 *
 * Units: mm, g, g/mm^3 internally (densities are given in g/cm^3 = 1e-3 g/mm^3). Tool frame axes.
 *
 * Densities (g/cm^3), by `Material.kind` and `Material.name`:
 *
 * | material                                   | g/cm^3 | source                                   |
 * |--------------------------------------------|--------|------------------------------------------|
 * | carbon / chrome vanadium / black oxide /   | 7.85   | steel handbook (EN 10027 steels 7.85)    |
 * |   zinc plated / dark steel / any other steel|       |                                          |
 * | stainless                                  | 7.9    | EN 10088                                 |
 * | cast iron                                  | 7.2    | grey iron 7.1-7.3                        |
 * | aluminium (also anodised)                  | 2.70   | EN 573                                   |
 * | brass                                      | 8.5    | CuZn37 8.4-8.7                           |
 * | copper                                     | 8.96   | pure Cu                                  |
 * | plastic (ABS / PP / PVC dip)               | 1.05   | ABS 1.04-1.06, PP 0.9-1.1                |
 * | glossy plastic                             | 1.1    | PC/ABS blends 1.1                        |
 * | rubber / elastomer                         | 1.15   | TPE/NBR 1.0-1.3                          |
 * | wood beech / oak / walnut / pine / ash /   | .72 / .75 / .65 / .5 / .68 / .83 | air-dry timber tables (Wood Handbook) |
 * |   hickory; varnished (generic hardwood)    | .7     |                                          |
 * | cork (soldering iron grip)                 | .25    | agglomerated cork 0.2-0.3                |
 * | glass                                      | 2.5    | soda-lime glass                          |
 * | paper (tape, labels)                       | .8     | paper/card 0.7-1.1                       |
 * | fabric                                     | .4     | woven strap, loose                       |
 * | paint (cast frames, enamel, can lacquer)   | 1.2 for thin coats; bodies of painted metal are treated as steel/cast iron (see `paintBaseDensity`) | |
 */
import type { V3 } from '../math.ts';
import type { Material, MaterialKind } from '../materials.ts';
import type { Mesh } from '../mesh.ts';
import type { ToolModel, Lod } from '../model.ts';
import type { AnyValues } from '../params.ts';
import { generate } from '../registry.ts';

export type Mat9 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface PartMass {
  name: string;
  role: string;
  materialKind: MaterialKind;
  densityGcm3: number;
  fill: number;
  volumeMm3: number;
  massG: number;
  comMm: V3;
}

export interface MassProperties {
  massG: number;
  /** centre of gravity, tool frame, mm */
  comMm: V3;
  /** inertia tensor about the CoM, row-major 3x3, g*mm^2, tool frame axes */
  inertiaGmm2: Mat9;
  volumeMm3: number;
  parts: PartMass[];
}

/** Exact integrals of a closed outward-oriented mesh, taken about the origin. */
export interface MeshIntegral {
  volumeMm3: number;
  centroidMm: V3;
  /** ∫ x_i x_j dV about the origin, mm^5: [xx, yy, zz, xy, yz, xz]. */
  secondMoments: readonly [number, number, number, number, number, number];
}

export function integrateMesh(mesh: Mesh): MeshIntegral {
  const p = mesh.positions;
  const idx = mesh.indices;
  let vol = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  let xx = 0;
  let yy = 0;
  let zz = 0;
  let xy = 0;
  let yz = 0;
  let xz = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = (idx[t] ?? 0) * 3;
    const b = (idx[t + 1] ?? 0) * 3;
    const c = (idx[t + 2] ?? 0) * 3;
    const ax = p[a] ?? 0;
    const ay = p[a + 1] ?? 0;
    const az = p[a + 2] ?? 0;
    const bx = p[b] ?? 0;
    const by = p[b + 1] ?? 0;
    const bz = p[b + 2] ?? 0;
    const cx = p[c] ?? 0;
    const cy = p[c + 1] ?? 0;
    const cz = p[c + 2] ?? 0;
    // det = a . (b x c) = 6 * signed volume of the tetrahedron (0, a, b, c)
    const det = ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    const sumX = ax + bx + cx;
    const sumY = ay + by + cy;
    const sumZ = az + bz + cz;
    vol += det / 6;
    sx += (det / 24) * sumX;
    sy += (det / 24) * sumY;
    sz += (det / 24) * sumZ;
    const k = det / 120;
    xx += k * (ax * ax + bx * bx + cx * cx + sumX * sumX);
    yy += k * (ay * ay + by * by + cy * cy + sumY * sumY);
    zz += k * (az * az + bz * bz + cz * cz + sumZ * sumZ);
    xy += k * (ax * ay + bx * by + cx * cy + sumX * sumY);
    yz += k * (ay * az + by * bz + cy * cz + sumY * sumZ);
    xz += k * (ax * az + bx * bz + cx * cz + sumX * sumZ);
  }
  const centroidMm: V3 = vol === 0 ? [0, 0, 0] : [sx / vol, sy / vol, sz / vol];
  return { volumeMm3: vol, centroidMm, secondMoments: [xx, yy, zz, xy, yz, xz] };
}

const STEEL = 7.85;
const WOOD_DENSITY: Record<string, number> = {
  beech: 0.72,
  oak: 0.75,
  walnut: 0.65,
  pine: 0.5,
  ash: 0.68,
  hickory: 0.83,
  varnished: 0.7,
};

/** Density in g/cm^3 of a material (table in the file header). */
export function materialDensityGcm3(m: Material): number {
  const name = m.name.toLowerCase();
  switch (m.kind) {
    case 'metal':
      if (name.includes('stainless')) return 7.9;
      if (name.includes('cast iron')) return 7.2;
      if (name.includes('alumin')) return 2.7;
      if (name.includes('brass')) return 8.5;
      if (name.includes('copper')) return 8.96;
      return STEEL;
    case 'plastic':
      return name.includes('glossy') ? 1.1 : 1.05;
    case 'rubber':
      return 1.15;
    case 'wood': {
      if (name.includes('cork')) return 0.25;
      const species = name.replace(/^wood\s+/, '');
      return WOOD_DENSITY[species] ?? 0.7;
    }
    case 'glass':
      return 2.5;
    case 'paper':
      return 0.8;
    case 'fabric':
      return 0.4;
    case 'paint':
      return 1.2;
  }
}

/**
 * Painted castings and tube frames are metal under the paint; labels, badges and lacquer are not.
 * Only `Material.name` tells them apart, so the heuristic is name based.
 */
function paintBaseDensity(m: Material): number {
  const name = m.name.toLowerCase();
  if (name.includes('cast')) return 7.2;
  if (name.includes('frame')) return STEEL;
  return materialDensityGcm3(m);
}

/** Density used for a part: `materialDensityGcm3`, except painted metal bodies (see `paintBaseDensity`). */
export function partDensityGcm3(part: { material: Material }): number {
  return part.material.kind === 'paint'
    ? paintBaseDensity(part.material)
    : materialDensityGcm3(part.material);
}

/**
 * Effective fill: the fraction of `volume * density` that a real tool of this part has. The generated
 * meshes are solid shells, real tools are not: housings are thin-walled, ferrules are tubes, labels are
 * stickers drawn as a skin that overlaps the body. A value above 1 lumps unmodelled internals (battery
 * cells, motor, tape coil, steel gears) into the shell that encloses them. Roles are listed per material
 * kind; `FILL_BY_NAME` and `FILL_BY_CLASS` hold the few cases a role cannot express. Tuned so the
 * validation presets in `docs/physics.md` land in catalogue mass ranges.
 */
const FILL_BY_ROLE: Record<MaterialKind, Readonly<Record<string, number>>> = {
  // Thin sheet (blade, jaw plates, plates of a hex-key set) and forged solids are 1. Sleeves are tubes.
  metal: { ferrule: 0.4, hoop: 0.4, bolster: 0.4, frame: 0.4, fastener: 0.5, head: 0.9, cap: 0.5 },
  // Housings 0.3 (wall 1.5-2.5 mm moulding + ribs); solid handles 0.9; internals as noted per class.
  plastic: {
    body: 0.3,
    lid: 0.3,
    frame: 0.3,
    face: 0.8,
    handle: 0.9,
    cap: 0.35,
    head: 0.5,
    control: 0.5,
    lever: 0.4,
    latch: 0.5,
    label: 0.05,
    display: 0.3,
    battery: 1,
  },
  // Rubber over a solid core 0.6 (a grip sleeve is mostly the core's neighbour, not a solid cylinder).
  rubber: { grip: 0.6, body: 0.6, head: 0.6, cord: 0.3 },
  wood: {},
  paint: { label: 0.02, body: 1 },
  glass: {},
  paper: { label: 0.02, core: 0.7 },
  fabric: {},
};

/** (role, name) cases where one role needs two answers. */
const FILL_BY_NAME: Readonly<Record<string, number>> = {
  // Tape measure: shell 0.3 plus ~125 g of steel coil, spring and ratchet inside (5 m x 25 mm x 0.13 mm = 16 cm3).
  'body/case': 1.4,
  // Hacksaw tube bow is a thin-wall tube.
  'frame/bow': 0.4,
  // PVC dip and two-component handles are 0.5-1 mm coats on a steel arm that the jaw part already holds.
  'handle/PVC dip': 0.4,
  'handle/two-component handle': 0.5,
};

/** Per `classId/role/materialKind` overrides: classes that hide heavy internals or differ from the role default. */
const FILL_BY_CLASS: Readonly<Record<string, number>> = {
  // Hollow-ground aluminium extrusion: 3 mm walls in a 25 x 60 mm box section.
  'spirit-level/body/metal': 0.25,
  // Motor, PCB and wiring inside the housing; steel planetary gearbox inside the plastic gearbox shell;
  // Li-ion cells inside the battery shell (about half the pack volume is cells, rest air and plastic).
  'cordless-drill/body/plastic': 1.4,
  'cordless-drill/head/plastic': 4,
  'cordless-drill/battery/plastic': 1.4,
  'battery-pack/body/plastic': 1,
  // Mains transformer in the station body; pencil irons have no body part.
  'soldering-iron/body/plastic': 1,
  'soldering-iron/body/metal': 1,
  // Heating element, PCB, cord and stick feed in the gun housing.
  'glue-gun/body/plastic': 0.5,
  // Blade carriage and lock inside the knife body; die-cast metal knife body is part-hollow.
  'utility-knife/body/plastic': 0.5,
  'utility-knife/body/metal': 0.5,
  // Saw handle is a flat open moulding, much thinner than its silhouette.
  'saw-hand/handle/plastic': 0.3,
  // Cast C-frame is a 12 mm webbed section; the mesh is a fat solid.
  'c-clamp/body/paint': 0.3,
  'bar-clamp/body/paint': 0.5,
  // Cast head of a combination square is hollowed.
  'square-try/head/paint': 0.5,
  // These case meshes are already thin-walled boxes (walls ~1.3 mm), not solid blocks.
  'bit-case/body/plastic': 1,
  'bit-case/lid/plastic': 1,
  'drill-bit-case/body/metal': 1,
  'drill-bit-case/lid/metal': 1,
};

export function partFill(
  part: { role: string; material: Material; name: string },
  classId?: string,
): number {
  const byClass =
    classId === undefined
      ? undefined
      : FILL_BY_CLASS[`${classId}/${part.role}/${part.material.kind}`];
  if (byClass !== undefined) return byClass;
  const mat = part.material;
  const byName =
    FILL_BY_NAME[`${part.role}/${part.name}`] ?? FILL_BY_NAME[`${part.role}/${mat.name}`];
  if (byName !== undefined) return byName;
  return FILL_BY_ROLE[mat.kind][part.role] ?? 1;
}

const MM3_PER_CM3 = 1000;

export function massPropertiesOfModel(model: Pick<ToolModel, 'classId' | 'parts'>): MassProperties {
  const parts: PartMass[] = [];
  const locals: { m: number; inertiaCom: number[] }[] = [];
  let mass = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let volume = 0;
  for (const part of model.parts) {
    const integral = integrateMesh(part.mesh);
    const density = partDensityGcm3(part);
    const fill = partFill(part, model.classId);
    const m = (integral.volumeMm3 * density * fill) / MM3_PER_CM3;
    const rho = integral.volumeMm3 === 0 ? 0 : m / integral.volumeMm3;
    const [px, py, pz] = integral.centroidMm;
    const [xx, yy, zz, xy, yz, xz] = integral.secondMoments;
    const v = integral.volumeMm3;
    // Second moments about the part's own centroid, then the tensor.
    const cxx = xx - v * px * px;
    const cyy = yy - v * py * py;
    const czz = zz - v * pz * pz;
    const cxy = xy - v * px * py;
    const cyz = yz - v * py * pz;
    const cxz = xz - v * px * pz;
    locals.push({
      m,
      inertiaCom: [
        rho * (cyy + czz),
        -rho * cxy,
        -rho * cxz,
        -rho * cxy,
        rho * (cxx + czz),
        -rho * cyz,
        -rho * cxz,
        -rho * cyz,
        rho * (cxx + cyy),
      ],
    });
    parts.push({
      name: part.name,
      role: part.role,
      materialKind: part.material.kind,
      densityGcm3: density,
      fill,
      volumeMm3: v,
      massG: m,
      comMm: integral.centroidMm,
    });
    mass += m;
    cx += m * px;
    cy += m * py;
    cz += m * pz;
    volume += v;
  }
  const comMm: V3 = mass > 0 ? [cx / mass, cy / mass, cz / mass] : [0, 0, 0];
  const inertia = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  parts.forEach((pm, i) => {
    const local = locals[i];
    if (!local) return;
    const dx = pm.comMm[0] - comMm[0];
    const dy = pm.comMm[1] - comMm[1];
    const dz = pm.comMm[2] - comMm[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    const d = [dx, dy, dz];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const shift = local.m * ((r === c ? d2 : 0) - (d[r] ?? 0) * (d[c] ?? 0));
        inertia[r * 3 + c] = (inertia[r * 3 + c] ?? 0) + (local.inertiaCom[r * 3 + c] ?? 0) + shift;
      }
    }
  });
  return {
    massG: mass,
    comMm,
    inertiaGmm2: inertia as unknown as Mat9,
    volumeMm3: volume,
    parts,
  };
}

export function massProperties(
  toolClass: string,
  params: AnyValues = {},
  lod: Lod = 1,
): MassProperties {
  return massPropertiesOfModel(generate(toolClass, params, lod));
}
