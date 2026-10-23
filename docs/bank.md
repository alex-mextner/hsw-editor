# HSW element bank

Ready-made HSW (honeycomb storage wall) elements: holders, hooks, bins, inserts, panels. Package
`@hsw-editor/bank` (`packages/bank`) owns the schema, the search/data layer and the ingestion pipeline.

## Geometry frame (read this before using a GLB)

Everything in the bank — GLB vertices, `bboxMm`, `dimsMm`, cell offsets — is in the **wall frame of
`packages/core`**: millimetres, **x right, y up, z out of the wall towards the room**, right-handed.
That is also glTF's Y-up convention, so `GLTFLoader` output needs **no rotation and no unit scale if the
scene is in millimetres** (scale 0.001 for a metre scene).

- `z = 0` is the wall face of the element (the plane its plugs sit in), the body grows towards `+z`.
- The origin `(x, y) = (0, 0)` is the centre of the element's **anchor cell**. Placing an element at a
  honeycomb cell centre `c` puts the origin on `c`; rotation by multiples of 60° about the z axis keeps it
  on the lattice.
- Source CAD files are Z-up (STL/3MF/STEP/SCAD). The pipeline maps them with a proper rotation (never a
  mirror): per element a pair of source axes `out` (away from the wall) and `up`; `x_wall = up × out`.
  A part printed on its back has `out = +z`, `up = +y`.

### Cells

The lattice is the one of `packages/core` (`HSW_COL_PITCH_MM` / `HSW_ROW_PITCH_MM` in `grid.ts`, landing with the Core PR): `colPitchMm = 20.4382` between neighbouring
columns, `rowPitchMm = 23.6`, odd columns shifted up by half a row. A cell offset from the anchor is
`{ dCol, dRow2 }`: `dCol` columns to the right, `dRow2` **half-rows** up (`dRow2 ≡ dCol mod 2`), i.e.
`(dCol * 20.4382, dRow2 * 11.8)` mm — independent of the parity of the anchor cell's column.
`footprint.cells` are the cells under the wall-facing silhouette, `mounting.cells` those that carry an
attachment.

## Data model

`packages/bank/src/schema.ts` is authoritative (zod; TS types by `z.infer`; JSON schema is generated to
`packages/bank/schema/bank-index.schema.json` by `bun run bank:schema`). `BankIndex` =
`{ version, contentHash, grid, counts, categories, toolClasses, elements[] }`. A `BankElement` carries:
`id`, `name{ru,en}`, `category` (tree id such as `holders/screwdrivers`), `tags{ru,en}`, `toolClasses[]`,
`fitsTool[]` (recogniser hint: tool class + measured-dimension ranges + capacity), `footprint`,
`bboxMm`/`dimsMm`, `mounting`, `params[]` (dimension-widget definitions: key, label, unit, min, max,
default, step), `family` + `variantLabel` (size ladders / A-B-C variants of one design), `generated`,
`assets{lod0,lod1,thumbnail,triangles}`, `printNotes`, `provenance`, `license{spdx,observed,attribution,redistributable}`.

Variants of one design are separate elements sharing `family`; use `bank.familyOf(element)`.

## Data layer (`@hsw-editor/bank`, browser-safe)

```ts
const bank = createBank(index, serializedSearchIndex?);
bank.getElement(id); bank.listElements({ category, toolClass, mounting, maxDimsMm, maxCells,
  fits: { toolClass, dims }, sort, offset, limit }); bank.search('отвертка', filter?, limit?); bank.familyOf(el);
```

Search is MiniSearch over ru/en names, tags, tool-class synonyms and category names with a light
stemmer (`text.ts`): AND over the query words first, OR + fuzzy as fallback.

## HTTP contract (`createBankHandler` in `@hsw-editor/bank/node`, mounted by `apps/server`)

| Route | Result |
|---|---|
| `GET /api/bank/index` | `BankIndex` (one JSON, all elements). `ETag: "<contentHash>"`, `Cache-Control: no-cache` (304 when unchanged). |
| `GET /api/bank/search-index` | Serialised MiniSearch index matching the same `ETag`; feed it to `createBank`. |
| `GET /api/bank/elements/:id` | one `BankElement`, 404 if unknown. |
| `GET /api/bank/search?q=&category=&tool=&mounting=&limit=` | `{ results: [{ id, score }] }` ranked. |
| `GET /bank/assets/<glb\|thumb\|variant>/<16 hex>.<glb\|webp>` | Asset bytes, `Cache-Control: public, max-age=31536000, immutable` (names are content hashes → safe for the service worker). |
| `POST /api/bank/elements/:id/variant` body `{ params: { key: number } }` | `VariantResponse` `{ glbUrl, bboxMm, dimsMm, footprint, mountingCells, paramHash, params, cached }`. 400 invalid, 404 unknown element, 409 element has no generator, 500 render/build failed, 503 OpenSCAD unavailable. Values are clamped to the element's `params` ranges. Results are cached by a hash of the parameters plus the mesh-tool/compressor code, at most 2 variant builds run at once, and `variant/` files older than 14 days (or beyond 256 MiB, oldest first) are removed by `bank:ingest`. |

Asset URLs are `/bank/assets/` + `asset.path` from the index. Read routes answer only `GET`/`HEAD` and the variant route
only `POST` (otherwise 405 with `Allow`); the asset extension must match its kind (`.glb` under `glb/` and `variant/`,
`.webp` under `thumb/`).

Mounting in the server: `apps/server/src/bank-routes.ts` is a server module (`bankModule` in `modules.ts`) that runs after
the loopback guard and before the wall API. It calls `createBankHandler({ roots: [bankDir, paths.seedDir], paths })`, where
`bankDir` is `$HSW_BANK_DIR` or `<HSW_EDITOR_HOME>/bank`, and the handler returns `null` for URLs that are not bank routes.
It serves the built bank and falls back to the committed seed, reloads when the `index.json` of any root changes (including
a built bank appearing after the seed was loaded), keeps serving the bank in use when a new index cannot be read (an
ingest mid-write), and never needs a restart after `bank:ingest`.

## Ingestion pipeline (`bun run bank:ingest`)

```
bun run bank:ingest [--force] [--only <id-text>] [--generated-only] [--report] [--seed] [--json]
bun run bank:verify [--seed]            # files, hashes, schema, GLB bounds == index bboxMm
bun run bank:build-variant <id> key=value ...   # OpenSCAD variant, cached by parameter hash
bun run bank:schema [--check]           # regenerate / verify packages/bank/schema/bank-index.schema.json
```

Stages: inventory the HSW project (`sources/catalog`, `sources/downloaded-library`, `refit/geometry`, `models`; override the
root with `HSW_SOURCES_DIR`) -> content hashes + `mesh_tool.py probe` (cached by file hash) -> cluster identical geometry
(exact hash, or sorted extents/volume/area within tolerance for STEP/STL/3MF copies; mirror images stay separate) ->
join with the hand-written curation (`packages/bank/curation/sources.ts`) -> render parametric families
(`packages/bank/generators/families.json` + `families.scad`) with OpenSCAD -> `mesh_tool.py build` (orient into the wall
frame, anchor, footprint cells, smooth normals, thumbnail rendered headlessly with pyrender/EGL) -> meshopt GLB LOD0/LOD1 ->
content-hashed assets + `index.json` + `search-index.json` + `report.json` in `<data home>/bank` (`HSW_EDITOR_HOME`, else `$XDG_DATA_HOME/hsw-editor`, i.e. `~/.local/share/hsw-editor`, the same directory the daemon serves).

- Idempotent/incremental: per-element artefacts are cached under `~/.cache/hsw-editor/bank-build/elements/<key>` where the
  key covers the source hash, part, orientation, the mesh-tool/compressor code and the per-element build inputs (colour,
  back-slab thickness, views). A fingerprint over all inputs (`packages/bank/src` recursively, curation, generators,
  `scripts/bank/py`, the element keys) makes an unchanged rerun a no-op that only stats the source files; the hash of every
  rendered STL is remembered next to it (`<key>.stl.sha256`), so a rerun does not re-read the meshes.
- Python (trimesh, shapely, pyrender, cascadio for STEP) lives in `scripts/bank/py`, environment in `~/.cache/hsw-editor/bank-venv`
  (`uv sync` runs automatically). Child processes run in a `systemd-run --user --scope` with memory/CPU caps; set
  `HSW_BANK_NO_WRAPPER=1` to disable the scope. `HSW_BANK_LOCK=1` additionally holds `/tmp/3d-cli-heavy.lock`: once around
  the whole OpenSCAD render pool (its 4 workers stay parallel) and around each mesh-tool run, and children get
  `HSW_HEAVY_LOCK_HELD=1` so they never queue on it again. If the whole pipeline is already started under
  `flock /tmp/3d-cli-heavy.lock ...`, export `HSW_HEAVY_LOCK_HELD=1` (it is then not taken a second time, which would deadlock).
- The report lists ingested, skipped (deliberate, with reason), failed, uncurated geometries and curation orphans. A
  geometry without a curation entry is reported and not ingested; nothing is silently dropped.
- Orientation of source parts is guessed (`provenance.orientation = 'auto'`): a hex plug end or the largest flat face on the
  bounding box is taken as the wall face. The project's own refit holders and the generated families are exact
  (`curated` / `generator`). Review `auto` elements visually before relying on their placement.

### Licence policy

Only permissive terms may be committed to this MIT repo: the project's own work (`MIT`) and original CC-BY works.
Everything else (CC-BY-NC, CC-BY-NC-SA, CC-BY-SA, CC-BY-ND, Standard Digital File License, unknown, bare "Attribution" wording with any NonCommercial/ShareAlike/NoDerivatives qualifier, and remixes whose upstream terms are not
verified) is indexed with `license.redistributable = false`, kept out of `packages/bank/seed`, and ingested locally from
the HSW source tree on the machine that has it (`bank:ingest`). The attribution and source URL of every element stay in the
index. A duplicate cluster is as restricted as its most restricted member.

### Seed

`bun run bank:ingest --seed` copies the redistributable subset (index, search index, hashed GLB/thumbnails,
`ATTRIBUTION.md`) to `packages/bank/seed` and fails above 5 MiB. The budget counts the UTF-8 bytes of every file in the
seed (assets, JSON, attribution); the seed is built in a temporary directory and swapped in only when it fits, so a failed
export leaves the committed seed untouched. A fresh clone serves it without any source files.

### Parametric families and variants

A family (`families.json`) names an OpenSCAD generator part, declares parameter ranges (`params`, the dimension widget)
and a grid of real sizes; each grid point becomes a `generated: true` element (`provenance.generator` has the exact values).
`POST /api/bank/elements/:id/variant` or `bun run bank:build-variant` renders any other value inside the ranges (clamped and
snapped to the step), cached by parameter hash under `variant/`. Source elements without a generator declare variants as
sibling elements of one `family` instead.
