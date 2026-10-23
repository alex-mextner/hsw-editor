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
  a refit. A photo without a scale still gets masks, classes and colours, the objects say `needsScale`.
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

`custom` import suggests classes from the CLIP crop embedding fused from two sources:

1. the sidecar's text prompts per class (`recognitionCategories()` is written to `tools-prototypes/classes.json` and passed
   as `categories`), corrected by the class bias;
2. retrieval against **prototype images rendered from our own generators** (`scripts/prototypes.ts`: every class x preset x
   colour variant x 8 views on the CLIP grey background, embedded by `scripts/py/embed.py` through the same encoder).

`scripts/eval-recognition.ts` reports top-1 / top-3 on the labelled carpet crops (`eval/carpet-labels.json`). Numbers are in
the PR that introduced the fusion. Without the prototype files the sidecar's text scores are used. The optional AI hook is
the sidecar's `ai_assist` (off by default, hard cases only).
