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

## HTTP contract (planned: implemented by `@hsw-editor/bank/node`, mounted by `apps/server` in the pipeline PR)

| Route | Result |
|---|---|
| `GET /api/bank/index` | `BankIndex` (one JSON, all elements). `ETag: "<contentHash>"`, `Cache-Control: no-cache` (304 when unchanged). |
| `GET /api/bank/search-index` | Serialised MiniSearch index matching the same `ETag`; feed it to `createBank`. |
| `GET /api/bank/elements/:id` | one `BankElement`, 404 if unknown. |
| `GET /api/bank/search?q=&category=&tool=&mounting=&limit=` | `{ results: [{ id, score }] }` ranked. |
| `GET /bank/assets/<glb\|thumb\|variant>/<16 hex>.<glb\|webp>` | Asset bytes, `Cache-Control: public, max-age=31536000, immutable` (names are content hashes → safe for the service worker). |
| `POST /api/bank/elements/:id/variant` body `{ params: { key: number } }` | `VariantResponse` `{ glbUrl, bboxMm, dimsMm, footprint, paramHash, params, cached }`. 400 invalid, 404 unknown element, 409 element has no generator, 503 OpenSCAD unavailable. Values are clamped to the element's `params` ranges. Results are cached by parameter hash. |

Asset URLs are `/bank/assets/` + `asset.path` from the index.
