# Tools: realistic tool models and the user tool library

`packages/tools` (`@hsw-editor/tools`) owns everything about tool models: parametric generators for the built-in
classes, the custom-tool data model, the fit of a generator to a photo silhouette, the recognition prototypes and the
on-disk user library. Tickets: [#44](https://github.com/alex-mextner/hsw-editor/issues/44) generators,
[#45](https://github.com/alex-mextner/hsw-editor/issues/45) custom tools and API/CLI,
[#46](https://github.com/alex-mextner/hsw-editor/issues/46) UI, [#47](https://github.com/alex-mextner/hsw-editor/issues/47) recognition.

## Built-in classes (generators)

```ts
import { generate, listToolClasses, presetValues, exportGlb } from '@hsw-editor/tools';
const model = generate('screwdriver', { handle: 'ergonomic', tip: 'phillips', shaftLength: 120 }, 0 /* LOD */);
const glb = exportGlb(model); // Uint8Array, millimetres
```

- A class (`defineToolClass`) declares a **typed parameter schema** (`num` with min/max/default in mm, `choice`, `color`),
  **presets** (real catalogue sizes) and `build()`, which returns **named parts** (`handle`, `grip`, `ferrule`, `shaft`,
  `tip`, ...) each with a PBR material (`metal`, `plastic`, `rubber` with colour and a grip-texture hint, `wood`, `glass`).
  Values are clamped to the schema on every call, so API input and photo fits cannot produce an invalid model.
- Every part is **one closed, outward-oriented shell** (checked by `analyzeMesh`: each directed edge used once, positive
  volume). `bun test packages/tools/src/registry.test.ts` builds every class at LOD0 and LOD1, every preset, every numeric
  extreme and every choice option and asserts that.
- **Frame** (mm): origin on the principal axis at the butt, `+Y` towards the working end, `+Z` towards the viewer when the
  tool lies face up, `+X` right: the wall frame of `packages/core` (glTF Y-up, no rotation or scale in a mm scene).
- **LOD0 / LOD1**: LOD1 keeps the silhouette with a fraction of the triangles (editor wall view); LOD0 has the grip flutes,
  teeth, ticks and so on (close-up, thumbnails).
- **Holding interface** (`model.holding`, also in the GLB scene `extras`): principal axis, hang point, named zones along the
  axis (handle / shaft / head ...), the cross-section extents sampled every 2 mm (`w`, `t`, `r` = farthest point from the
  axis), the maximum section and class-specific `dims` (`shaftDiameter`, `handleDiameter`, `jawOpening`, ...). This is what
  a holder has to fit; it feeds the bank `fitsTool` hints and the holder suggestion.
- **`bankClass`**: the bank vocabulary id of the class (`TOOL_CLASSES`, `docs/bank.md`); a test fails when it names an unknown id. Use the finest
  honest id (`chisel`, not `knife`); the coarser class follows from its `broader` link.
- GLB: one node and mesh per part, materials with `extras.kind`/`extras.grip`, scene `extras` with `classId`, `params`,
  `holding`.

REST: `GET /api/tools/classes`, `GET /api/tools/classes/:id` (schema, presets, `thumb`, `dimsMm`, `holdingDims`), `GET /api/tools/classes/:id/model.glb?preset=&p={json}&lod=`,
`GET /api/tools/classes/:id/holding?...`, `GET /api/tools/classes/:id/thumb.webp?preset=&p=` (see [api.md](api.md)).

**Class thumbnails** are rendered on demand by the software renderer (`renderThumbWebp`) and cached in memory and in
`$HSW_EDITOR_HOME/cache/tool-thumbs/`. The cache key hashes the class id, the resolved parameters and the generated GLB
bytes, so changing a generator invalidates its thumbnails without a version bump; concurrent requests render once.
`apps/server/src/tools/thumbs.test.ts` renders every class (default and every preset) and checks the output is not blank.

### Contact sheets (visual review)

```sh
bun packages/tools/scripts/sheet.ts <class|family ...> [--tile 300] [--lod 1] [--out DIR]
```

Software renderer (no GPU, no dependencies): one row per preset with front / side / iso views and a working-end close-up.
Reviewed sheets live under `~/.cache/hsw-editor/proofs/tools/` and are attached to the PRs.

## Tool models on the wall

Ticket [#162](https://github.com/alex-mextner/hsw-editor/issues/162). A tool item on the wall is drawn as its generated model (LOD0 close,
LOD1 far), not as a box: PBR parts (metals reflect a generated studio environment, so they work offline), instanced per model.

- **Asset store** (`packages/tools/src/node/assets.ts`, `ToolAssetStore`, data under `$HSW_EDITOR_HOME/tools-assets/`): LOD0/LOD1 GLBs of every
  built-in class (its default build) and every library tool under content-hash names, plus `index.json`. Same guarantees as the bank: files are
  written before the index that lists them and atomically, a file is served only while it hashes to its name, a damaged or lost file is
  rebuilt (the request that hit it and the next index call), `health()`/`?deep=1` report problems, orphans are swept after a day. Routes:
  [api.md](api.md#tools) (`/tools/assets/glb/*`, `/api/tools/assets/index|health`). The web client loads the index once (`toolmodels/assets.ts`),
  and the scene wraps every model load in the bank's `AssetBoundary` (placeholder + retry with backoff; a retry revalidates the tool index).
- **Which model**: `toolmodels/resolve.ts`. The model reference's `source.by` names the generator (`gen:<class>`) or library tool (`tool:<id>`) a tool was
  added from, else the bank class (then its `broader` classes) picks a generator. No generator: the box stand-in stays.
- **Sizes**: the dimension widget's width/length/thickness and the item's named class parameters (`shaftDiameter`, ...) are wishes; a wish that is not the
  class default is built in a worker (`toolmodels/regenWorker.ts`, one build at a time, only the newest wish per class waits, cached by entry + wish,
  both LODs as blob URLs). `solveToolDims` (`packages/tools/src/wallModel.ts`) finds the class values: parameters that move an axis are scaled together (a longer
  screwdriver gets a longer handle *and* blade), every part is held to what a real one measures, and a size no real tool has builds the nearest real one
  (`reached: false`; the inspector says "closest buildable"). While a rebuild runs the class default is drawn. After a size edit of a hung tool it is hung again
  in its slot (`wall/rehang.ts`, one more undo step).
- **Realistic sizes** (`packages/tools/src/realism.ts`): per class, the overall length/width/thickness and named parts (handle, blade, head) of real tools, and ratios
  such as blade/handle. `realism.test.ts` fails when any default or preset leaves them; the solver never leaves them. Tools may hang beyond the board edge: the scene
  never clips them and the camera frames the board plus whatever overhangs it (`scene/wallExtent.ts`).
- **Holding interface**: a hung tool's `ToolInterface` (length, hang point, widest section, dims) is the model's own (`toolmodels/holdingInterface.ts`), so
  `@hsw-editor/compat` seats the real shape. Box sizes (`width`/`length`/`thickness`) are never holding dimensions.
- **Invalid zones** check the tool's LOD1 mesh; a tool still may interpenetrate the holder it hangs on (`parentId`).
- **Offline**: models are runtime-cached (`cache-first`, immutable), the index is stale-while-revalidate; "Offline storage → Tool models" downloads and pins every model.
  The Pages demo ships the tools of the showcase wall (`scripts/tools/demo-assets.ts`, run by `bun run build`).
- **Showcase wall** (`apps/web/src/demo/showcase.ts`, layout `showcaseLayout.ts`): real seed holders with a dozen generated classes hung by the compat maths;
  it is the demo wall, a test fixture and `bun apps/web/scripts/showcase-wall.ts --api <daemon>` puts it on a running daemon for visual checks.

## Custom tools

```
photo(s) --sidecar photo_to_objects--> objects (mask, crop, class top-k, closed-form width profile in mm, part colours)
         --fit--> class generator fitted to the profile  (or generic loft of the profile when nothing fits)
         --review--> user confirms / renames / merges / splits / discards / enters real dimensions / overrides the class
         --commit--> ~/.local/share/hsw-editor/tools/<id>/
```

- **Fit** (`custom/fit.ts`): closed form first. The generator is built at LOD1, its section widths along Y are compared
  with the observed profile; uniform length scaling, orientation test (front/side x flipped), coordinate descent over the
  mm dimension parameters and greedy choice of style options. No renderer in the loop; ~100-250 generator builds
  (tens of ms each). The result carries the profile IoU used as confidence. Several suggested classes are tried and the
  best `0.65 * IoU + 0.35 * recognition score` wins; below IoU 0.5 the generic loft is used.
- **Colours**: the sidecar's colour segments along the axis map to parts by overlap (one dominant colour per part; metal
  stays metal unless the photo shows black oxide). User colour edits are stored per part (`partColors`).
- **Dimensions**: from the photo scale (grid, two points, mm/px) or typed by the user; the user's numbers win and trigger
  a refit. A scale reference is optional: without one the profile (in pixels, `profilePx`) is scaled by the class-typical length
  of the chosen or best suggested class and the object is flagged `dimensionsEstimated` (saved as `dimensionsMm.source:
  "estimated"`); typing one real length replaces the estimate. Only an object with no class and no typed size says `needsScale`.
  A photo of tools never builds or places a wall; tools are only added to the collection.
- **Several photos of one tool**: group the objects; the most informative observation is the primary, the suggestions of
  the others are merged, all photos are kept in `source/`.
- **Tags**: free-form labels on a tool (`tags`, normalised: trimmed, lower-cased, de-duplicated, 1-40 characters, at most 20) for
  filtering the library. Set on import (`hsw-editor tools import --tag`), on the draft object, in the commit body or
  by PATCH; tools written before tags existed read as untagged.
- **Unknown objects**: generic loft, one part per colour segment, thickness from the user / the sidecar's profile kind.

### Storage

```
~/.local/share/hsw-editor/tools/<id>/tool.json  model.glb  model-lod1.glb  thumb.webp  source/<crop|cutout|mask|photo files>
~/.local/share/hsw-editor/tools/.drafts/<draft>/draft.json photos/ vision/<n>/ preview/
~/.local/share/hsw-editor/tools/.trash/<id>-<ts>/
~/.local/share/hsw-editor/tools-prototypes/   recognition prototypes + classes.json (optional, built by a script)
```

`tool.json` (`CustomToolSchema`, zod) holds class, params, observed profile, colour segments, part colours, dimensions
and their source, fit quality and the candidate classes, so a tool can be rebuilt without the sidecar. Removal moves to
`.trash`. Single writer: the daemon.

### HTTP API, jobs, CLI

See [api.md](api.md#tools) and [cli.md](cli.md#tools). Job kind `tools.analyze` (`{ draftId }`) runs the sidecar and fits
every object; progress per photo over the standard job SSE.

## Recognition (class suggestion)

`custom` import suggests classes from the crop embeddings fused from three sources:

1. the sidecar's text prompts per class (`recognitionCategories()` is written to `tools-prototypes/classes.json` and passed
   as `categories`), corrected by the class bias;
2. retrieval against **prototype images rendered from our own generators** (`scripts/prototypes.ts`: every class x preset x
   colour variant x 8 views on the CLIP grey background, embedded by `scripts/py/embed.py` through the same encoder);
3. the same retrieval with **DINOv2-small** embeddings (`dino-prototypes.f32` next to the CLIP prototypes, written by `embed.py protos`;
   the sidecar writes `embeddings-dino.npy` next to `embeddings.npy` and the object record's `embedding.dino`). Image-to-image retrieval
   with DINOv2 is the strongest single signal on the carpet crops. Without the DINOv2 files (model not installed, or an index built
   with `--no-dino`) the fusion is CLIP-only exactly as before. The index is built at ingestion (`embed.py protos`) and loaded from disk;
   nothing runs at request time except embedding the crops.

`scripts/eval-recognition.ts` reports top-1 / top-3 / top-5 on the 33 labelled carpet crops (`eval/carpet-labels.json`;
`--registered-only` drops the 5 crops of things the library has no class for: 4 boxes and a charger).
Measured 2026-10-23 with all 45 generator classes, 3632 prototype images (`bun run tools:prototypes`, `embed.py protos`,
CLIP-B/32 via `threed_vision`), default `k = 3`:

| method | 33 crops top-1 / top-3 / top-5 | 28 library crops top-1 / top-3 / top-5 |
| --- | --- | --- |
| CLIP text prompts, class-bias corrected | 0.42 / 0.70 / 0.76 | 0.50 / 0.82 / 0.89 |
| prototype retrieval only (w = 1) | 0.33 / 0.58 / 0.67 | 0.39 / 0.68 / 0.79 |
| fused, w = 0.3 | 0.52 / 0.73 / 0.82 | n/a |
| fused, w = 0.5 (default) | 0.52 / 0.79 / 0.82 | 0.61 / 0.93 / 0.96 |
| fused, w = 0.7 | 0.55 / 0.73 / 0.82 | 0.64 / 0.86 / 0.96 |

With DINOv2 retrieval added (`bun packages/tools/scripts/eval-recognition.ts <protos> <crops> [--registered-only] --loo`; defaults
`w = 0.7`, `wd = 0.3`, `dinoTemp = 4`, `k = 3`, chosen by leave-one-out over a (w, wd, dinoTemp) grid):

| method | 33 crops top-1 / top-3 / top-5 | 28 library crops top-1 / top-3 / top-5 |
| --- | --- | --- |
| DINOv2 retrieval only | 0.52 / 0.76 / 0.79 | 0.61 / 0.89 / 0.93 |
| fused CLIP text + CLIP prototypes + DINOv2 (defaults) | **0.70 / 0.79 / 0.82** | **0.82 / 0.93 / 0.96** |
| same, parameters chosen leave-one-out (not tuned on the crop they score) | 0.64 / 0.79 / n/a | 0.75 / 0.93 / n/a |

Before this: 0.52 / 0.79 / 0.82 on the 33 crops and 0.61 / 0.93 / 0.96 on the 28 (the table above). The ticket target of top-1 >= 0.75
on the 33 crops is **not reached**: 5 of the 33 crops (4 boxes, a charger) have no class in the library, so 28 / 33 = 0.85 is the ceiling;
on the 28 crops the library can name, the defaults reach 0.82 (0.75 leave-one-out; the crops are few, the defaults were picked on them,
so the leave-one-out line is the honest estimate for new photos). Rows 1-2 use the same 33 labelled crops of ONE photo (#486 asks
for more photos).

The VisionSpike baseline (top-1 0.61 / top-3 0.79 on the 33 crops) used the coarse bank classes, so it is not the same task as
choosing among 45 fine classes (pliers-combination vs water-pump-pliers vs side-cutters). Against the same 45-class text
prompts, fusion adds +0.10 top-1 and +0.09 top-3 on all 33 crops (+0.11 / +0.11 on the 28), and reaches the baseline top-3 of
0.79 on all 33 crops; top-1 on all 33 (0.52) stays below the baseline 0.61 because the boxes and the charger can never match.
Remaining misses: pliers and screwdriver crops mistaken for scissors, snips or other pliers, a tape measure taken for a
multimeter, a bit set taken for a battery pack. Without the prototype files the sidecar's text scores are used. The optional AI hook is
the sidecar's `ai_assist` (off by default, hard cases only).

## UI: Tool Library and Add from photo

Ticket [#46](https://github.com/alex-mextner/hsw-editor/issues/46). Code: `apps/web/src/features/tools/` (the Tools tab
of the left panel; commands in `apps/web/src/commands`).

- **Panel**: built-in classes and the user's tools in one list, grouped by type (the class family) with counts and
  collapsible groups, ru/en search over names, keywords, family and tags (`ё` = `е`, prefixes, typos), tag chips and
  a "my tools only" toggle for the user's tools (the "Mine" badge). Thumbnails are the server-rendered
  `GET /api/tools/classes/:id/thumb.webp` / `GET /api/tools/:id/thumb.webp`; a missing one shows a tinted fallback glyph.
  Search text, tags and collapsed groups survive reloads.
- **On the wall**: a click puts the tool in front of the middle of the viewport; a drag uses the `ToolDragPayload`
  of `scene/toolDrop.ts` (class = the tool's `bankClass`, box, measured `holdingDims` as `params`, `customToolId` for a
  user tool, recorded in the model ref as `source.by = "tool:<id>"`), so mount glow, refusal and hanging are the same
  as for tools already on the wall. Selecting tool items filters the bank (`toolFilterStore`, #57).
- **Suggested holders** (inspector, tool selected): bank holders ranked by `compatibility()` of `@hsw-editor/compat`
  (class, measured dimensions against the mount ranges), with fit score and thumbnail; one click adds the holder and
  hangs the tool on it.
- **Detail page** (info button on a card): orbit 3D preview of the generated model, class parameters and presets
  (live preview; "Save to my library" stores a customised class as a user tool), real dimensions and colours per part of
  a user tool (refit through `PATCH /api/tools/:id`), materials of the parts read from the GLB, and the holding
  interface drawn along the axis (width and thickness silhouettes, zones, hang point, widest section, measured dims).
- **Add from photo** (wizard, "add to collection"): photos from any angle (several tools per photo, or one tool in several photos) + an optional scale reference (the
  honeycomb grid when the photo shows one, two points with a real distance, or a known mm/px; without any, sizes are estimated and flagged) -> `POST /api/tools/drafts`, job `tools.analyze`
  -> review grid (crop, top-3 classes with confidence and a manual override, name, accept / discard, merge, same-tool
  group, split, real dimensions, live 3D preview of the fitted model, comparison with the built-in candidates by
  silhouette IoU) -> `commit` into the user library with tags. Without the vision sidecar (`GET /api/tools/vision`
  says so, or the job fails with `vision_unavailable`) the wizard shows "The vision service is not available" and
  nothing is analysed or invented.
- **Commands**: `tools.library.show` (`g t`), `tools.library.search {query}`, `tools.fromPhoto`, `tools.add {id}`
  (`class:<id>`, `tool:<id>` or a bare id).
