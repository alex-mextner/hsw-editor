# Invalid zones

The 3D editor marks **only the parts of models that are actually invalid** with red diagonal stripes: where an item overlaps another item,
and where it protrudes past what the board allows. Tracking issue: [#48](https://github.com/alex-mextner/hsw-editor/issues/48).
The marks are advisory like every geometry warning: the op reducer is unchanged, nothing blocks an op or a save.

## Rules (`packages/core/src/validity.ts`)

- **Overlap.** Two solid items (everything but `photo-ref`) must not share volume. Touching faces are fine. A tool may interpenetrate the
  holder named by its `parentId` (the mating interface); other pairs are checked.
- **Board prism.** Every solid must lie in `x in [0, width]`, `y in [0, height]`, `z >= 0` of `boardSizeMm(board)`. Bank elements are modelled with
  the wall face at `z = 0` (screw bosses/plugs sit on it, see the bank geometry frame in `packages/bank`), so anything at `z < 0` is behind the wall. Mounting cells that
  fall off the board are caught by the same rule: their body is outside the prism.
- **Tolerances** (`ValidityTolerances`, configurable): a region is reported only if its thinnest width is `>= 0.05 mm` **and** its volume `>= 0.5 mm^3`.
  Coincident faces and float noise stay below that; a 0.1 mm sliver of two real holders does not.
- **Depth** shown to the user is the thinnest width of the shared volume measured along the world axes and both items' own axes (the
  directions a pair separates along), so two holders rotated 33 degrees that overlap by 0.5 mm along their faces read `0.5 mm`, not the
  axis-aligned extent of a diagonal sliver.

## Why small overlaps were not marked (tg#23742)

The previous markers were grid-cell footprint tests, not geometry tests:

- `checkWall` in `packages/core/src/ops.ts` (`COLLIDING_KINDS` / `byCell`): "footprints are not known to the core, so only items anchored to the same
  cell can collide".
- The web editor's `layoutProblems` (`apps/web/src/wall/footprint.ts`, in the WebEditor branch) skips every item without a `cell`
  or a `bankId` and flags only two items that claim the **same footprint cell**.
- A body overhang, a free-placed holder, a tool, or a tall holder in front of another (bodies grow up to 100 mm in `z`) overlap without sharing a
  cell and are never reported; and the marker was the whole instance (`tint` in the editor's `ItemsLayer.tsx`), never a region.

The new check works on the real meshes, so any real interpenetration above the tolerance is found, wherever the cells are.

## Engine (`apps/web/src/scene/invalid-zones`)

1. Item world boxes (`itemWorldAabb`) -> sweep-and-prune broadphase; a pair must overlap by more than the depth tolerance on every axis.
2. Narrowphase: exact boolean intersection of the two posed solids with manifold-3d (WASM) -> the shared volume is the overlap region
   (mesh + exact volume + depth). The same boolean against five disjoint slabs outside the board prism gives protrusion regions.
3. Results are cached per `(solid, pose)` of the operands (LRU), so moving one item recomputes only the pairs that involve it.
4. Everything runs in a Web Worker (`worker.ts`); the client (`client.ts`) keeps one solve in flight and always solves the newest scene.
5. GLB fetches run in parallel and off the message chain, so a solve never waits for a download: items whose solid is still loading are skipped and listed as `pending`, and the scene is re-solved once after the last pending solid lands.
6. A mesh that is not a closed solid falls back to its bounding box.

Deterministic: same input gives identical reasons and region geometry in any item order (`engine.test.ts`).

### Rendering

`<InvalidZones result theme describeRegion/>` (scene origin = board corner, millimetres x 0.001, like the board mesh) draws the region meshes with `stripeMaterial.ts`: a `MeshStandardMaterial` with a screen-space
45 degree stripe hook (about 6 CSS px period, anti-aliased with `fwidth`), alternating the lit red with a neutral (white on dark, near black on
light), so the zone is recognisable by pattern and luminance as well as by hue. Two passes: the surface pass (normal depth test,
polygon offset) and a faint see-through pass (`GreaterDepth`) for parts hidden inside other geometry, which is where most overlaps live. A thin
outline marks the region border. The material is fragment-only and uses `gl_FragCoord`, so it works unchanged on `InstancedMesh` and over the
photo overlay. Region meshes are merged into one geometry (one draw call per pass); hovering a region lists its reasons.

## Benchmark and choice

200 real bank holders on a 90 x 60 board, one holder dragged across its neighbours (`bun apps/web/scripts/bench-invalid-zones.ts`, exits 1 over budget):

| Option | Per pair | Region | Verdict |
| --- | --- | --- | --- |
| manifold-3d boolean intersection (chosen) | 1.5-3 ms shallow, up to ~12 ms for a deep/coincident overlap (median 2.7, p95 15 over 1157 random dense pairs) | exact mesh + volume | the only one meeting "any real overlap > 0.05 mm" with exact regions |
| three-mesh-bvh `intersectsGeometry` | 0.1 ms | boolean only, touching counts | useful only as a cull; no region, no depth |
| voxel occupancy / SDF (1-2 mm) | 0.25 ms per pair, 5.7 s one-off for 103 models at 1 mm | approximate | cannot represent a 0.1 mm sliver |

Drag step on the warm cache (3 fixture holders / the full 103-element seed): p50 11 / 7.7 ms, p95 15 / 16.9 ms, max 18 / 18.6 ms with ~1.4-1.9
booleans per step; cold full solve of the 200 items 2-17 ms for a valid layout (about 190 ms with ~50 overlapping pairs). The worker
cost is off the render thread, so rendering stays at 60 fps while the stripes follow at >= 55 Hz.

## Tests

`bun test packages/core/src/validity.test.ts apps/web/src/scene/invalid-zones` — box volumes within 1 % of the analytic value, rotated 45
degrees octagon prism, touching faces, 0.04 / 0.06 mm tolerance edge, 0.1 / 0.5 / 1 mm overlaps of real bank holder GLBs at 0, 60, 33 and
120 degrees, a brute-force vertex-in-solid oracle (`oracle.testkit.ts`) that shares no code with the engine, determinism, cache behaviour.
