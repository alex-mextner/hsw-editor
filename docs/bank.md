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

## Tool classes

`TOOL_CLASSES` (`packages/bank/src/toolClasses.ts`) is the vocabulary of `toolClasses[]` / `fitsTool[].toolClass`: ru/en names plus ru/en
synonyms (the recogniser maps detector labels through them; a phrase is listed under one class only). The classes an index declares win,
the built-in classes it lacks are added (`toolClassVocabulary`), so a seed written before a class existed still resolves it; an index
that declares none gets the built-in list.

Finer ids carry `broader`, the coarse class they refine (never chained, `validateBankIndex` rejects an unknown target or a chain):

| Finer class | `broader` |
|---|---|
| `chisel` | `knife` |
| `punch` | `screwdriver` |
| `hacksaw` | `saw` |
| `level`, `square` | `ruler` |
| `long-nose-pliers`, `locking-pliers`, `water-pump-pliers`, `crimper` | `pliers` |
| `hex-key-set` | `hex-key` |

A holder that lists only the coarse class still serves the finer tool:

- `compatibility()` accepts a `ToolInterface.broader` entry and ranks it `SCORE_BROADER_PENALTY` below an exact one; `toolInterfaceOf`
  fills `broader` from the vocabulary.
- The bank tool filter, `listElements({ toolClass | fits })` and the holder suggestion expand a class through `acceptedToolClasses` /
  `expandToolClasses`. Only the ranked paths (`holdersForToolClass`, the selection ordering of the bank browser) put exact holders first;
  the filters keep index order.
- A class an index declares without `broader` turns the built-in link off for that index. The committed seed declares exactly
  `TOOL_CLASSES` (a test pins it) and `exportSeed` takes the vocabulary from `TOOL_CLASSES`, not from the built root, so a stale built
  bank cannot freeze old classes into the seed. An index written before the finer classes still resolves `broader` through the
  built-in list, but pickers that list `index.toolClasses` offer only what that index declares.
- Search documents of a coarse holder also carry the words of its finer classes (`finerToolClasses`), so "chisel" finds the knife rack.

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
| `GET /bank/assets/<glb\|thumb\|variant>/<16 hex>.<glb\|webp>` | Asset bytes, `Cache-Control: public, max-age=31536000, immutable` (names are content hashes → safe for the service worker), `X-Bank-Index-Hash: <contentHash of the served index>`. A name no retained generation has: `404` `{ "error": "asset_not_found", "path", "indexHash", "referencedByIndex", "message", "hint" }`, `Cache-Control: no-store`. |
| `GET /api/bank/health[?deep=1]` | `{ ok, served: { root, contentHash }, elements, unavailable, withheld[], generations[], rejected[], retainedDamaged[], deep?: { problems[] } }`; 503 when no bank can be served. `rejected`: unusable roots ranked above the served one (unreadable/inconsistent index); `withheld`: elements of the served root left out because their files are damaged; `retainedDamaged`: damaged older roots (only the retention of old asset names suffers); `ok` is false for the first three. `deep=1` also hashes every file and decodes every GLB (cached 30 s). |
| `POST /api/bank/elements/:id/variant` body `{ params: { key: number } }` | `VariantResponse` `{ glbUrl, bboxMm, dimsMm, footprint, mountingCells, paramHash, params, cached }`. 400 invalid, 404 unknown element, 409 element has no generator, 500 render/build failed, 503 OpenSCAD unavailable. Values are clamped to the element's `params` ranges. Results are cached by a hash of the parameters plus the mesh-tool/compressor code, at most 2 variant builds run at once, and `variant/` files older than 14 days (or beyond 256 MiB, oldest first) are removed by `bank:ingest`. |

Asset URLs are `/bank/assets/` + `asset.path` from the index. Read routes answer only `GET`/`HEAD` and the variant route
only `POST` (otherwise 405 with `Allow`); the asset extension must match its kind (`.glb` under `glb/` and `variant/`,
`.webp` under `thumb/`).

Mounting in the server: `apps/server/src/bank-routes.ts` is a server module (`bankModule` in `modules.ts`) that runs after
the loopback guard and before the wall API. It calls `createBankHandler({ paths })`, where `paths.bankDir` is `$HSW_BANK_DIR`
or `<HSW_EDITOR_HOME>/bank`; the handler returns `null` for URLs that are not bank routes. It serves the current generation of
the built bank, falls back to older generations and finally the committed seed, reloads when the `index.json` of any root
changes (including a built bank appearing after the seed was loaded), and never needs a restart after `bank:ingest`. When the
index of the first root that has one cannot be read or verified (an ingest mid-write, a failed read, damage) the bank already
in use stays (the damaged root is listed under `rejected`, `ok: false`, retried every 5 s or as soon as the file changes);
a fresh process with no bank in use falls through to the next root, an older generation first.

A root whose `index.json` is unreadable or inconsistent is **not served** (logged once, listed under `rejected` in
`/api/bank/health`) and the next best root takes over. A root whose index is fine but whose files for some elements are
missing or truncated **is** served, with exactly those elements moved to `unavailable` (the ETag changes with the view),
so one lost file costs one element, not the whole bank. The check (existence + recorded size, no hashing) runs when a root
is loaded, when any root's `index.json` changed (re-validated at most every 500 ms, concurrent requests share one run),
every 5 s while a root is rejected, and, debounced to once per 2 s, when an asset request proves the served root is damaged.
It does not watch files inside a served generation: `bank:verify` / `/api/bank/health?deep=1` is the full check.
A hashed asset is served only from a root whose own index lists it **with the recorded size**, so a truncated copy in a
damaged generation is never sent under the `immutable` header while an intact copy of the same name exists in an older one.

## Integrity: generations, verification, retention

The built bank is never edited in place. Layout of the bank dir (`HSW_BANK_DIR`, else `<HSW_EDITOR_HOME>/bank`):

```
current -> generations/<UTC stamp>-<contentHash12>     one atomic symlink swap publishes a bank
generations/<id>/{index.json, search-index.json, report.json, glb/, thumb/}   complete, verified, immutable
generations/.staging-*                                  a build in progress, never served
variant/                                                content-addressed OpenSCAD variants, shared
```

- `bank:ingest` (and `bank:adopt`) assemble the tree in `.staging-*`, run the **full** verification (schema, `contentHash`,
  every file's existence/size/sha256, GLB bounds = `bboxMm`) and only then rename it into `generations/` and swap `current`.
  A tree that fails is deleted and `current` stays as it was (`BankVerificationError`, exit code 1).
- Elements that cannot be built or whose files are missing are **withheld**: they are not in `elements[]`, they are listed
  in the optional index field `unavailable: [{ id, name, reason }]` (and in `report.failed`), so a client can say why a
  wall item has no model instead of crashing on a 404.
- The previous generations stay on disk (3 in total, `HSW_BANK_KEEP_GENERATIONS`), so an index a browser tab fetched before
  a rebuild keeps resolving its hashed asset names. The ingest report lists `removed` elements (published before, gone now).
- `bun run bank:verify [--seed] [--all] [--root <dir>] [--quick] [--no-bounds] [--json]` is the gate: exit `0` consistent, `1` problems
  (missing glb/thumbnail, size or sha256 mismatch, edited index, wrong GLB bounds), `2` usage error, `3` nothing built. CI runs
  `bank:verify --seed` and `bun run check` includes it; `GET /api/bank/health` exposes the same verdict of a running server that mounts the bank handler.
- `bun run bank:adopt <dir>` publishes a flat bank (legacy tree, seed copy, another machine's export) as a verified generation
  (exit `0` published, `1` refused, `2` usage). The source's own index must verify (schema, `contentHash`); elements with a
  missing/corrupt file or GLB bounds that disagree with the index are withheld into `unavailable`.
- A flat bank written by an older ingest (`<bankDir>/index.json`, `glb/`, `thumb/`) is adopted as the first generation by the next
  `bank:ingest` and its flat files are removed, so old asset names stay resolvable from that retained generation.
- `bank:ingest --only <text>` publishes a partial bank without pruning older generations and does not report the rest as `removed`.
- `bank:ingest --seed` stages and verifies the new seed next to `packages/bank/seed` and swaps it in only when complete.

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

## User elements

A user can bring their own holder or panel into the bank (STL, GLB or 3MF): `hsw-editor bank add`, the *Add element* dialog of
the web bank panel, or the routes in [api.md](api.md#user-elements-apibankuser-job-bankuserimport). The result is a normal
`BankElement` with `source: "user"` (the *mine* badge), id `my-<slug>`, `provenance.origin: "user-upload"` and
`license.redistributable: false` (never exported to the seed).

**Storage** (`<home>/bank-user`, `HSW_BANK_USER_DIR`): a bank tree in the format of a generation (`index.json` with only the user
elements, content-hashed `glb/` LOD0/LOD1 and `thumb/`), plus `meta/<id>.json` (import settings, original name/hash, repair
report), `sources/<id>/original.<ext>` (the file as uploaded, so an element can be re-converted) and `uploads/` (24 h staging).
It is deliberately NOT a bank generation: `bank:ingest` publishes a complete new bank from the HSW sources and would drop it.
`bank:ingest`, `bank:adopt`, `bank:verify` and the seed export never read or write it. `bun scripts/bank/verify.ts --root <home>/bank-user` verifies it
like any other bank tree. The daemon is the single writer: writes are serialised, assets are written before the index that
references them, and the index is replaced atomically (tmp + fsync + rename), so a crash leaves the previous state. A corrupt
`index.json` is never overwritten by a later write (`500 user_bank_corrupt`).

**Serving** (`createBankHandler({ userRoot })`): the user tree is a second root next to the generations. The served view is the
built bank plus the user elements, recomposed in memory (counts and `contentHash` are recomputed, so the index ETag changes with
the user data), search index included; assets are served from whichever root lists them. The user root's `index.json` is part of
the snapshot signature, and writers call `handler.invalidate()` so the next request sees the change at once. A damaged user
element (missing/truncated file) is withheld into `unavailable`, a corrupt user index is ignored (listed under `user.problems` of
`/api/bank/health`); neither affects the built bank, and a rebuilt bank (`bank:ingest`, generations, retention, withheld
elements) never touches the user elements.

**Conversion** (`scripts/bank/user/user_mesh.py`, run in the bank venv like `mesh_tool.py` and reusing its orientation, silhouette
and thumbnail code; kept out of `scripts/bank/py` because that directory is hashed into the cache key of every built element):

- Units: STL/3MF are millimetres; a glTF is metres, so with `unit: auto` a GLB smaller than 2 units across is scaled by 1000
  (`mm|cm|m|in` override). Output is always millimetres.
- Frame: STL and 3MF are Z-up, glTF is Y-up. `orient: { out, up }` names the SOURCE axis that points away from the wall and the
  one that points up; the pipeline maps them with a proper rotation to the wall frame (x right, y up, z out, wall face at z = 0, see
  "Geometry frame"). The default is guessed (hex plug end, else the largest flat face on the bounding box).
- Anchor: `back-bbox` (default) finds the lattice phase from the wall-facing silhouette and puts the origin on the nearest cell
  centre, `origin` keeps the source origin, `panel` anchors on the centre of the bounding box. The detected footprint is the lattice
  cells under the silhouette; detected mounting cells are the silhouette's holes (M3 screws), else the footprint.
- Parts: a 3MF/GLB with several parts imports the biggest by default; `partId` picks one, `*` merges all.
- Watertight check and repair: vertices are welded, the mesh is probed for watertightness; if it is not and `repair` is on, holes
  are filled and winding/normals fixed in process; a mesh still not watertight is handed to `3d mesh --repair` (meshfix; STL/3MF
  with one part, only when the `3d` CLI and meshfix are installed, override the binary with `HSW_3D_BIN`). The outcome is reported
  (`watertight`, `repaired`, `warnings`); a mesh that stays broken is still imported with a warning, because footprint and
  thumbnail may then be off.
- Thumbnail: the bank's headless pyrender/EGL renderer; on a machine without EGL a software rasteriser draws the same tile.
- Compression: the same meshopt LOD0/LOD1 pipeline as the built bank (`compress.ts`); geometry hashes make an identical
  re-import a `409 duplicate_element`.

**Editing**: `PATCH` changes metadata only (name, category, tags, tool classes, `fitsTool` ranges, footprint cells, mounting kind
and peg cells); changing geometry settings or the file is a re-import with `replaceId` (the id is kept; old assets are swept after an hour,
so tabs holding the previous index still resolve them). `footprint` must contain `{0,0}`, mounting cells must be footprint cells, a
mounting kind other than `none` needs at least one.
