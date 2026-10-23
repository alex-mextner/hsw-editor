# Tool physics

How a generated tool behaves as a physical object: mass, centre of gravity, inertia, and what follows from them for hanging
on a wall. Code lives in `packages/tools/src/physics/`. Ticket [#167](https://github.com/alex-mextner/hsw-editor/issues/167).

## Mass, centre of gravity and inertia

`packages/tools/src/physics/mass.ts`:

```ts
import { massProperties, massPropertiesOfModel, integrateMesh, materialDensityGcm3, partFill } from '@hsw-editor/tools';

const m = massProperties('hammer', presetValues('hammer', 'claw-450g')); // lod 1
m.massG; m.comMm; m.inertiaGmm2; m.parts; // per part: material, density, fill, volume, mass, CoM
```

Units are mm, g and g·mm² in the tool frame (origin on the axis at the butt, +Y to the working end).

**Maths.** Every part is one closed outward-oriented shell, so everything is an exact surface integral
(divergence theorem: each triangle spans a tetrahedron with the origin; Tonon / Eberly closed forms for volume, first and
second moments). `integrateMesh(mesh)` returns `∫dV`, the centroid and `∫xᵢxⱼ dV`. Per part the inertia tensor about its own
centroid is `ρ(∫r² I − ∫xxᵀ)`; parts are combined with the parallel-axis theorem about the combined CoM. Part mass is
`volume × density × fill`.

### Densities (g/cm³)

| material                                                          | density | source                    |
| ----------------------------------------------------------------- | ------- | ------------------------- |
| steel (chrome vanadium, black oxide, zinc plated, dark steel, ...) | 7.85    | EN 10027 steels           |
| stainless                                                         | 7.9     | EN 10088                  |
| cast iron                                                         | 7.2     | grey iron 7.1-7.3         |
| aluminium (also anodised)                                         | 2.70    | EN 573                    |
| brass / copper                                                    | 8.5 / 8.96 | CuZn37 / pure Cu       |
| plastic (ABS, PP, PVC dip) / glossy plastic                       | 1.05 / 1.1 | ABS 1.04-1.06, PC/ABS 1.1 |
| rubber, TPE                                                       | 1.15    | TPE/NBR 1.0-1.3           |
| wood: beech .72, oak .75, walnut .65, pine .5, ash .68, hickory .83, varnished .7; cork .25 | by `Material.name` (`wood <species>`) | Wood Handbook air-dry |
| glass / paper / fabric                                            | 2.5 / .8 / .4 | handbook values     |
| paint (labels, lacquer, badges)                                   | 1.2     | coating                   |
| paint whose name contains `cast` / `frame`                        | 7.2 / 7.85 | painted casting / steel tube, not a coating |

### Fill heuristic

The generated meshes are solid shells; real tools are often hollow. `partFill(part, classId?)` is the effective mass fraction
and lives in tables in `mass.ts` (role × material kind, a few `role/name` cases, a few `classId/role/kind` overrides):

- plastic housings, lids, frames: 0.3 (1.5-2.5 mm moulding); multimeter case face 0.8 (battery and PCB lumped in); solid plastic
  handles 0.9; PVC-dip handle 0.4 (a coat on the steel arm that the jaw part already holds)
- metal ferrule, hoop, bolster, tube frame: 0.4 (tubes); heads (forged but with eye) 0.9; blades, jaws, plates: 1
- rubber grips, over a core: 0.6; labels: 0.02-0.05 (the label mesh overlaps the body it is printed on)
- **above 1** where unmodelled internals are lumped into their shell: tape-measure case 1.4 (a 5 m steel coil is about 125 g),
  cordless drill battery 1.4, housing 1.4 (motor), gearbox 4 (steel planetary gears); battery pack and soldering-station body 1
  (cells, transformer)
- aluminium spirit-level profile 0.25 (hollow extrusion); C-clamp cast frame 0.3; saw handle 0.3; combination-square head 0.5

### Validation

Masses at LOD 1 are checked by `physics/mass.test.ts` against catalogue ranges.

| class / preset            | computed mass | CoM y (mm) / length | real-world range                    |
| ------------------------- | ------------- | ------------------- | ----------------------------------- |
| hammer claw-450g          | 651 g         | 281 / 331 (head 15% from the end) | 16 oz claw hammer 300-700 g (head 450 g) |
| hammer sledge-2kg         | 1708 g        | 358 / 402           | 4 lb sledge 1.8-2.3 kg              |
| screwdriver slotted-classic (100 mm shaft) | 81 g | 73 / 195 | slotted 6.5 x 100: 60-200 g, handle heavy |
| screwdriver phillips-ergonomic | 130 g    | 72 / 205            | 60-200 g                            |
| tape-measure 5m-black-red | 226 g         | 34 / 144            | 5 m x 19-25 mm: 150-450 g           |
| cordless-drill blue-18v   | 1434 g        | 122 / 212           | 18 V with 2-3 Ah battery 900-1800 g |
| cordless-drill yellow-20v | 1705 g        | 130 / 226           | 900-1800 g                          |
| cordless-drill orange-12v | 923 g         | 105 / 170           | 12 V compact 800-1300 g             |
| wrench-combination 8      | 40 g          | 72 / 139            | 8 mm: 20-150 g (25-45 g)            |
| wrench-combination 13     | 90 g          | 98 / 189            | 13 mm: 20-150 g (80-130 g)          |
| pliers-combination cp-180-red | 272 g     | 128 / 180           | 180 mm: 150-350 g                   |
| spirit-level level-600    | 589 g         | 300 / 600           | 600 mm aluminium: 400-700 g         |
| spray-can paint-400ml     | 440 g         | 88 / 195            | 400 ml full: 400-650 g              |

Every registered class at LOD 1 also returns finite positive mass, a CoM inside the bounds, and a symmetric positive-definite
inertia tensor.

## How a tool really hangs (`packages/physics`)

User requirement tg#24290: tools have mass and a centre of gravity, so they really hang. `@hsw-editor/physics` is pure
TypeScript (no DOM, no three.js in the core; `./glb` is the only IO entry). Everything is in the wall frame: mm, x right, y up
(gravity is `-Y`), z out of the wall; the board is the plane `z = 0`. The reference case is the user's levitating-tools
screenshot ([`docs/references/user-levitating-tools-2026-10-22.jpg`](references/user-levitating-tools-2026-10-22.jpg)): the old
`placeTool` anchor put tools on top of their holders, so every part below is checked against that wall.

### Column rasters

A solid becomes a grid of `(x, z)` columns of 0.5 mm (`columns.ts`); each column keeps the occupied intervals along `y`. A
vertical ray through every triangle accumulates the winding number of its crossings, so overlapping shells (generators and the
bank union their parts without a boolean) and shared edges are harmless. Why columns: gravity points along `-Y`, so "what is under
this point" is a column lookup. A **settle** (drop a tool until its first contact) is `min` over columns of the gap between a
tool span and the obstacle span below it; a **rise** (lift) is the same upwards; a **pull** is the same on a raster built with
`+Z` up. Exact to the cell, ~1 ms for a 2 000-column tool.

### Seating (`seatTool`)

The tool is lowered from above its holder's own rim over the real holder mesh in every sensible orientation (working end down or up, four quarter turns
about its own axis) and at every lateral position of the slot window; positions that rest on nothing are discarded, and the
**lowest centre of gravity** wins (gravity: the tool falls as deep as the slot lets it). A coarse lattice pass (step grows for
roomy cavities, a bounded settle prunes with a sparse subset of columns, which is a valid lower bound) is refined at 0.5 mm. So a
shaft ends up inside the hole with the handle on the plate, a hammer hangs its head on the fork prongs with the handle through the
gap, a drill stands in its tray, never on top of the holder. Only the holder must be clear where a lowering starts: a tool
hanging over the slot (the holder of the row above, another tool) is not a floor to land on, and a neighbour that overlaps the start
volume does not stop the fall; where the tool ends up inside it, the hang analysis reports `penetrates` instead of the search
hiding the collision by choosing another start. Tools with a hole or loop (`hang.kind`) are also hung on a free-standing
rod of the holder (`findPegs`: blobs of the holder's slice at depth z narrower than the hole): the hole is put concentric
with the rod, rotated so that the centre of gravity is below the hole, and lowered until the hole's top rests on the rod. The tool's
natural end (compat's tip-down classes) and facing win unless they cannot be held and the alternative can. A tool that rests
tilted against the slot walls (a caliper beam in a slot) is leaned about its contact patch in 1.5-8 degree steps until it is in
equilibrium; `report.rest` carries that pose.

### Contacts and equilibrium

`findContacts` extracts, for the rest pose, where an obstacle touches the tool (vertical: within 0.6 mm; lateral: within the 3 mm a
tool has inside its slot; the wall plane) with the direction of force each can give. Patches are reduced to the extreme points of their
convex hull (a convex combination covers the patch). `equilibrium.ts` tests whether the contacts can balance gravity plus a
disturbance: every contact is a Coulomb friction cone (8 edges, mu = 0.35 PETG on plastic/steel; contacts more than 0.6 mm apart
carry no friction because a loose contact cannot pinch), a wrench is balanced iff it lies in the cone spanned by the generators
(non-negative least squares, residual below 3 % of the weight, torques about the centre of gravity scaled by 50 mm). Margins are the
largest disturbance in g (bisection) towards left, right, outward, inward, up, down.

### The hang report (`analyseHangPose`)

| reason | meaning | how it is decided |
| --- | --- | --- |
| `levitating` | nothing touches the tool (params: gap in mm to what is below) | no contact at all |
| `penetrates` | tool geometry inside the holder deeper than 1.5 mm: not seated in the slot | column overlap |
| `falls` | contacts cannot carry the weight (nothing supports from below) | force balance infeasible |
| `tips` | weight carried but the centre of gravity is outside the support, or a lateral bump of 0.3 g turns it over | torque infeasible / margin below 0.3 g |
| `slides_off` | a 0.3 g bump moves it sideways (not tipping) | force-only balance infeasible at the bump |
| `swings` | hangs from a line contact (peg, hook): free to turn; the sway of the centre of gravity under the bump is 20 mm or more | hinge detection, `l * sin(atan 0.3 g)` |
| `needs_retention` | a pull of 0.15 g outward walks it off its mount | outward margin |
| `overloaded` | mass above the mount's per-slot capacity (`fitsTool.maxLoadG`, else a documented default) | compare |

`score` is 0..1 (1 solid; a hinge `0.95 - 0.45 * min(1, sway / 150 mm)`; failures cap it), `status` is stable >= 0.8, marginal >= 0.45,
else unstable. The reference disturbances (0.3 g bump about a shoulder brushing past, 0.15 g pull) and the friction coefficient are
options (`HangOptions`); wall lean (`wallTiltDeg`) presses the tool towards the board. The reference bump and pull are conventions,
not cliffs: a margin within 10 % of the reference (0.29 g where 0.3 g is asked, which is where friction alone often caps it) is
not reported.

### Removal ergonomics (`RemovalProbe`)

The extraction paths a hand uses are swept against the holder's lips, neighbouring holders and tools, shelves and the board:
a lift, a pull, or a short lift (4-120 mm) followed by a pull, each optionally after tilting about the seat (12 and 25 degrees, about
x or z). Straight motions along the wall axes are decided exactly on the column rasters (a rise or a pull is stopped by the first
obstacle span in its way); the cheapest free path is then verified with **manifold-3d**: the tool is posed every 12 mm along the
path, `minGap` measures the clearance to neighbours and the boolean intersection volume (above the volume the seat already
shares with the holder by rounding, and above 6 mm^3: a shaft brushing the rim of its hole is wiggled through by a hand, a real
collision is tens) is the collision test. The rasters only order the candidates: what they see above the tool is judged without the holder itself (a rasterised
shaft overlaps its rasterised hole by a cell, which says nothing about a lid), and a way out they call blocked is still verified
exactly, as a short lift followed by a pull forward. A tool resting tilted in its slot is also lifted along its own axis, which
is how it went in. Verdicts: `free`, `needs_tilt`, `needs_two_hands` (tool heavier than
2.5 kg, a neighbour closer than 12 mm to the grip, or more than 450 mm of lift), `blocked` (with the ids in the way).
`convenience` is 0.6 + 0.4 * clearance / 40 mm for a free path, 0.5 with a tilt, 0.3 with two hands, 0 blocked.

The exact measurements are the expensive part (`minGap` between two dense meshes a few millimetres apart costs 100 ms or more, and most
of a second when it is asked to look 60 mm around), so they are only made where they can change the answer: every pose and every solid is
first tested with the boxes (a box gap is never more than the true gap, so a solid whose box is at least as far as the closest neighbour so
far cannot lower the clearance, and one whose box does not touch the tool's box cannot intersect it); a gap is asked in growing steps (8, 16,
32, 60 mm: a near neighbour answers the small search in a millisecond and later searches only look as far as it); the rest gap is first
looked for below the room a finger needs and only then up to the whole search distance; and a tool that is cramped at rest (it needs two
hands whatever the way out) is not measured along the way at all: its `clearanceMm` is the rest gap, an upper bound, and its convenience
is capped at 0.3 anyway. Gaps and the sweep look at every body within reach of the tool's way, not only at those in the box the rasters use.
A rack of three screwdrivers went from 26 s (cramped) or 3 s (slim) to 0.3-0.6 s per tool, the whole showcase wall from 54 s to 3 s
(`apps/server` physics report), with the same verdicts and paths.

### Holder ranking and auto-hang

`rankHolders(tool, candidates)` seats the tool in every candidate holder and sorts by
`foldFitAndRating(compatScore, physicsRating({stability, convenience}))` of `@hsw-editor/compat` (fit counts 0.3, stability twice as much as
convenience in the rest). The Suggested holders list and the choice of holder on drop use it, so a holder that fits on paper but does
not hold the tool loses to one that does.

### Wall analysis

`analyseWallPhysics({tools, holders, others, wasm})` judges every hung tool in the pose it is in against its holder and all
other holders and tools, and returns `PhysicsProblem[]` (`code`, `severity` error or warning, `params`) per tool plus the rating.
Tools without a holder are not judged here (they are flagged as unmounted elsewhere). Overhanging the board edge is not a
problem (tg#24300).

### Limits of the model

Static, rigid, quasi-planar: no dynamics, no flexing holders, friction is one coefficient, contact normals are the axis directions
of the raster (a sloped surface is approximated within 0.5 mm), a peg is detected as a free-standing blob in one depth slice, a
magnet is the option `EquilibriumOptions.magnetPullG` (an inward pull in weights of the tool at the centre of its wall contacts, so
friction on the board can carry it; the bank does not publish magnet strength yet, so no holder sets it) and a clip adds no pull-in force, and the lattice seat search needs the
slot to be reachable from above. All constants live in `HangOptions`, `EquilibriumOptions`, `ContactOptions` and `RemovalOptions`.

### Tests

`packages/physics/src/*.test.ts` (synthetic solids: a snug slot is stable, free-standing on a shelf tips, 6 mm above levitates, 12 mm
inside penetrates, a peg-hung bar swings with its lever, a slippery shelf slides, an edge drops a lever, overload; seat through a
plate hole and onto a rod; removal free / pull / blocked / cramped / heavy; wall report; ranking) and
`apps/web/src/physics/regression.test.ts` (the screenshot: every tool placed the old way is flagged, every tool seated by `seatTool` is held).

## In the editor

Code: `apps/web/src/physics` (data layer), `apps/web/src/features/physics` (panels), `apps/web/src/scene/physics` (amber marks).

**Pipeline.** The wall check runs in a Web Worker: `run.ts` builds a `PhysicsScene` from the open wall (`assets.ts`) and `client.ts`
sends it. `workerCore.ts` runs `analyseWallPhysics` with manifold-3d (`RemovalProbe`), and `run.ts` publishes `physicsStore` as
`running` (keeping the last report as `previous`), then `ready` or `error`. One check is in flight at a time and the newest wall wins:
the answer to a superseded wall is dropped, so a report never shows for a wall that has already changed. An unforced run of an
unchanged scene is skipped. `usePhysicsLive()` (mounted next to `useInvalidZones`) re-runs 400 ms after the last change to the wall,
the bank, the tool model index, a rebuilt tool model or a regenerated variant, and not while an item is dragged. The persisted setting `physics checks`
(`hsw-editor.physics`, default on, `physicsEnabledStore`) switches the worker, the report and the seating off; off also clears the
report. The worker keeps the last 150 loaded models and 400 posed solids (LRU).

**Which model is a tool.** Only a generated model is analysed: a stand-in box would have an invented centre of gravity.
`resolveToolModel(item, wall)` (`apps/web/src/toolmodels`, the one answer the scene, the selection frame and the invalid zones
share) gives it: a library tool's stored model, a generator class, or the model rebuilt for the size the item asks for (its
`lod1` GLB under the scene's key). A model still being built for the item's size is not judged (the scene draws the class default
meanwhile, and judging that would judge a tool nobody sees); the live check runs again when it lands (`toolModelVersion`). The GLB carries
`extras.physics` (mass, centre of gravity); a model without it, or one that cannot be downloaded, leaves the tool out of the report.
Holders and board parts use the bank GLB at lod 0, the same file and key as the invalid zones. The load a slot carries is the matched
`fitsTool` entry's `maxLoadG`, else `defaultLoadCapacityG(category)`. Those defaults are an assumption (PETG printed parts on M3
screws in the honeycomb board): hooks and pegs 1500 g, slot and rack holders 1000 g, cups 800 g, trays, bins and shelves 3000 g. The
bank schema does not publish `maxLoadG` yet, so today the defaults always apply.

**Seat on hang.** Hanging stays instant and uses the compatibility pose (`placeTool`); drag and drop previews never wait for physics.
A moment later the worker lowers the tool into the real holder mesh (`seatTool`: slot anchor from `mountSlots` and the slot index,
window half the slot pitch capped at 14 mm, `tipDown` from `prefersTipDown`). The result is one extra undo step, a batch labelled
`seat` (`rotateItem` then `moveItem`). If the wall changed meanwhile nothing is submitted; if no seat exists the compatibility pose
stays and the check flags it. Only upright holders are seated.

**Resize.** After a dimension edit, `rehangResizedTool` (`wall/rehang.ts`) waits for the rebuilt model and then seats it in its own
slot as one undo step labelled `rehang` (the compatibility pose of a drop when there is no seat: physics off, a rotated holder),
so a longer shaft goes deeper into its hole instead of floating above it.

**Seat tools.** The Physics section's "Seat tools" button and the palette command `physics.seat` ("Seat tools in their holders")
run `seatAllTools`: every hung tool, one after the other, each among the holders and the tools already dealt with (the ones still
waiting hang at the poses the wall was built with, often sunk into their holders, and would only block the slots the physics is
about to use), applied as ONE undo step labelled `seat all`. Locked tools and tools without a slot number (reported as not
seated: which slot they take is anybody's guess) are left alone and stay obstacles for the others; a tool that is already where
the physics puts it makes no move, but is hidden from the tools seated before it until its turn. This is how a wall built before physics existed, or by an agent from
compatibility poses, ends up with its tools inside their holders.

**Auto-hang picks the stable holder.** After a drop, `settleAfterDrop` takes every compatible holder with a free slot within the snap
radius (120 mm), runs `rankHolders` on them in the worker, and moves the tool to another holder only if its `combined` rank is at
least 0.05 better than the current one's.

**Suggested holders.** `usePhysicsRatings(toolItemId, holderIds)` seats the tool in each suggested holder (standing alone, no
neighbours) and returns `{stability, convenience, status, reasons}` as ratings arrive; `useRankedCandidates` starts from the
compatibility order and re-ranks with `rankWithPhysics` (30 % fit, 70 % physics) without making rows already shown jump. Each
card carries a chip (Stable / Marginal / Unstable, and Awkward when convenience is below 0.5) with the reasons as tooltip.

**Amber marks, not red.** `<PhysicsZones/>` marks every tool with a problem of severity `error` (levitating, penetrates, falls, tips,
overloaded, removal blocked) with amber `#f5a524` diagonal stripes on a dark neutral, in two passes (surface and faint see-through) over
its own model; tools with only warnings (swings, slides off, needs retention, awkward removal) get a thin amber outline. The stripes
run the opposite diagonal and have a wider period (9 px) than the red invalid-zone stripes, so the two stay apart even in monochrome:
red means geometry (two bodies share volume), amber a tool that overlaps nothing but hangs badly. Hover shows the reason sentences.
A tool that overhangs the board edge is never red (tg#24300): it is judged only by the physics check (a tool half off the board shows
up as levitating or tips). A legend chip next to the invalid-zones legend reads "N tools have physics problems" / "Physics OK".

**Wall report and inspector.** The Physics section of the wall view has a Check again button, a status line and the list of tools with
problems (errors first, then the worst rating); clicking a row selects the tool. The palette command "Check wall physics"
(`physics.check`) runs the check and opens that list. A selected tool shows its hang chip with the score, each problem as an amber
sentence, the removal verdict with the path ("lift 15 mm, pull", with a tilt prefix when needed) and the convenience, its mass in
grams and, when the tool leans against the holder walls, the rest-pose note (`hang.rest`).

## Daemon, agent tool and CLI

`apps/server/src/physics` judges a stored wall with the same maths. Holders and board parts are bank element GLBs at the item's pose
and dimensions (`readGlbSolid`); tools are the generated class model (`gen:<class>`, else `toolClass`, LOD 1, the item's `params`) or
the library tool (`tool:<id>`), read through `exportGlb` + `readToolBody`. Each tool is judged on its `parentId` holder and every other
tool is an obstacle at its own pose. manifold-3d is loaded once, lazily; decoded solids are cached and identical concurrent requests
share one analysis. Items without a holder or a model come back under `skipped`.

- REST: `GET /api/walls/:id/physics`, `GET /api/walls/:id/items/:itemId/physics` ([api.md](api.md#physics)).
- Agent: the omp host tool `wall_analyse_hang` (`{itemId?}`, [omp.md](omp.md)); the system prompt tells the agent to run it after placing
  tools and to move unstable tools to a better holder before finishing.
- CLI: `hsw-editor wall physics <id> [--item ID] [--json]`.

Every problem carries an English `text` sentence (`describeProblemEn`); the page has its own ru/en catalogue for the same codes.

## Reviewing the seats

```sh
bun apps/web/scripts/physics-seat-sheet.ts [class] [--out DIR]   # default ~/.cache/hsw-editor/proofs/physics
```

renders, for each tool of the screenshot, the tool where the old compat anchor put it (`old-<class>.png`, red) and where `seatTool`
seats it (`seat-<class>.png`, green; front and side views) and prints both verdicts. Measured on 2026-10-23 with the seed bank:

| tool in holder | old anchor | seat |
| --- | --- | --- |
| hammer in fork | falls (nothing under it) | stable, head on the prongs, handle through the gap |
| caliper in cradle | penetrates, levitating | stable (leans 1.5 degrees against the slot) |
| pliers in rack | penetrates | stable, jaws in the slot |
| tape measure in cradle | penetrates | stable |
| cordless drill in cradle | penetrates | marginal (tips, needs retention: no front lip) |
| wrench in rack | penetrates, tips | stable |
| screwdriver in rail (tip 4 mm in a 5 mm hole) | penetrates, levitating | marginal (needs retention) |
| spray can, tape roll on a peg | stable | stable |
