# Vendored from oh-my-pi

**Do not hand-edit `omp-render/`, `NOTICE` or this file.** Regenerate with:

```sh
bun run vendor:omp-render            # or: bun scripts/vendor-omp-render.ts [--source <oh-my-pi checkout>]
```

- Upstream: https://github.com/can1357/oh-my-pi
- Commit: `0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0`
- Packages: `packages/collab-web` (@oh-my-pi/collab-web 16.3.6), `packages/utils/src` (marked, marked-list, math-delimiters)
- Wire types: the published `@oh-my-pi/pi-wire@18.12.6` (an npm dependency, not vendored)
- License: MIT, see `NOTICE` (also listed in the repository `THIRD_PARTY_NOTICES.md`)

The source checkout is `--source`, else `$OH_MY_PI_SOURCE`, else a sparse clone pinned to the commit above under
`~/.cache/hsw-editor/oh-my-pi-src`.

## Layout

| Path | Upstream |
| --- | --- |
| `omp-render/tool-render` | `packages/collab-web/src/tool-render` |
| `omp-render/components/transcript` | `packages/collab-web/src/components/transcript` |
| `omp-render/lib/format.ts` | `packages/collab-web/src/lib/format.ts` |
| `omp-render/styles/tokens.css` | `packages/collab-web/src/styles/tokens.css` |
| `omp-render/utils/marked.ts` | `packages/utils/src/marked.ts` |
| `omp-render/utils/marked` | `packages/utils/src/marked` |
| `omp-render/utils/marked-list.ts` | `packages/utils/src/marked-list.ts` |
| `omp-render/utils/math-delimiters.ts` | `packages/utils/src/math-delimiters.ts` |

Hand-written, not generated: `index.ts` (barrel), `../render-types.ts`, `../omp-render.css` (token bridge).

## Transformations

Everything is byte-identical to upstream except:

1. Import specifiers: `../../lib/client` -> `render-types.ts` (ours); `@oh-my-pi/pi-utils/{marked,marked-list,math-delimiters}` -> the copied `omp-render/utils/*`
   (`@oh-my-pi/pi-utils` is not a dependency: it pulls native binaries).
2. CSS (`*.css`): selectors are scoped under `.omp-scope`; `:root`/`html`/`body` become the scope element; `animation: rise` -> `omp-rise`.
   Render inside `<div class="omp-scope">` and import `../omp-render.css` for the token bridge.

## Type checking

Upstream compiles without `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`, which this repo enables.
See `apps/web/tsconfig.json` (vendor excluded) and `apps/web/tsconfig.omp-vendor.json`.
