# hsw-editor

A local web service with a 3D wall editor for **HSW** honeycomb tool walls. Drop a photo of your tools (and the junk around them),
get a first-draft wall of HSW holder elements, then refine it by hand or with an AI agent. Everything runs on your machine
and works offline.

**Status:** skeleton. The monorepo, daemon, CLI, CI and roadmap exist; features are tracked as issues below.

## Why

- Designing a tool wall from a photo is slow by hand. Fitting should be fast and **not need AI** (AI is optional for hard cases).
- Humans and agents (omp / oh-my-pi) edit the same wall through one op stream with undo/redo.
- Walls live on disk (`~/.local/share/hsw-editor/walls/`), the app is an offline-capable PWA, no cloud.

## Layout

```
apps/web        Vite + React 19 + R3F + shadcn (base-ui) + Tailwind v4, PWA
apps/server     Bun daemon: REST/SSE, wall store, asset serving
packages/core   wall schema, ops, validation
packages/compat tool-to-holder compatibility, auto-attach, re-hang and the bank tool-filter model (pure)
packages/overlay photo calibration, rectification, wall<->photo mapping, snapping (pure)
packages/bank   HSW element bank index
packages/commands  action registry, hotkeys, command palette engine (docs/hotkeys.md)
packages/tools  realistic parametric tool models (GLB, holding interface), custom tool fit and the user tool library
services/vision Python sidecar (uv + FastAPI): detect, segment, calibrate, fit
cli/hsw_editor.py  lifecycle CLI on the shared agent-tools service manager
docs/specs/     design spec
```

## Quickstart

Requires Bun >= 1.4.2, Python 3 and the [agent-tools](https://git.hyperide.ai/ultrabricks/agent-tools) checkout
(`~/dev/agent-tools/lib`, or set `AGENT_TOOLS_LIB`). No network is needed if the lib is present.

```sh
bun install
bun run build
scripts/install.sh        # idempotent: deps, web build, ~/.local/bin/hsw-editor symlink
hsw-editor doctor
hsw-editor start          # http://127.0.0.1:8794
hsw-editor open
```

Development: `bun run dev` (Vite on :5194, proxies `/api` to :8794) and `bun run dev:server`.
Checks: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build` (or `bun run check`).
Vision sidecar: `cd services/vision && uv sync && uv run pytest`.

### state-lib (optional, private)

The UI state layer can use `@ultrabricks/state-lib` (not on npm). `bun run setup:state-lib` builds it from a local checkout
into `vendor/state-lib/` (gitignored; override the source with `STATE_LIB_RUNTIME`). Without it, or with
`VITE_STATE_BACKEND=baseline`, the app uses a dependency-free baseline store. CI always runs the baseline backend.

## CLI


| Command                                                              | Effect                                                                                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `hsw-editor run`                                                     | run in the foreground                                                                                                |
| `hsw-editor start` / `stop` / `restart`                              | background daemon (pidfile)                                                                                          |
| `hsw-editor status`                                                  | running state, pid, url (exit 3 if stopped)                                                                          |
| `hsw-editor enable` / `disable`                                      | systemd user autostart (and start/stop)                                                                              |
| `hsw-editor open`                                                    | open the editor in the browser                                                                                       |
| `hsw-editor doctor`                                                  | check agent-tools lib, bun, build, offline assets, port, data dir, uv, omp, GPU, vision, draw (fix hint per failure) |
| `hsw-editor wall list\|new\|show\|apply\|undo\|redo\|export\|delete` | edit walls through the daemon API (`--json`), see [docs/cli.md](docs/cli.md)                                         |

`--port N` overrides the default 8794 (recorded in `~/.config/hsw-editor/config.json`). Exit codes, doctor checks, install and
release: [docs/cli.md](docs/cli.md). HTTP API: [docs/api.md](docs/api.md). Release: `bun run release`.

## Roadmap

- [#1](https://github.com/alex-mextner/hsw-editor/issues/1) (a) Wall store, ops and history
- [#2](https://github.com/alex-mextner/hsw-editor/issues/2) (b) REST + SSE API
- [#3](https://github.com/alex-mextner/hsw-editor/issues/3) (c) CLI verbs and doctor
- [#4](https://github.com/alex-mextner/hsw-editor/issues/4) (d) 3D editor canvas: select, move, rotate, snap to honeycomb grid
- [#5](https://github.com/alex-mextner/hsw-editor/issues/5) (e) Wall-from-scratch flow
- [#6](https://github.com/alex-mextner/hsw-editor/issues/6) (f) Dimension, variant and compare widgets
- [#7](https://github.com/alex-mextner/hsw-editor/issues/7) (g) Bank browser (search, filter, hundreds of HSW elements)
- [#8](https://github.com/alex-mextner/hsw-editor/issues/8) (h) Bank ingestion pipeline from HSW sources
- [#9](https://github.com/alex-mextner/hsw-editor/issues/9) (i) Photo upload and camera calibration
- [#10](https://github.com/alex-mextner/hsw-editor/issues/10) (j) Segmentation of tools and junk
- [#11](https://github.com/alex-mextner/hsw-editor/issues/11) (k) Recognition and retrieval over the bank
- [#12](https://github.com/alex-mextner/hsw-editor/issues/12) (l) Fast no-AI silhouette fitter
- [#13](https://github.com/alex-mextner/hsw-editor/issues/13) (m) Multi-view consistency check
- [#14](https://github.com/alex-mextner/hsw-editor/issues/14) (n) Draw backend interface + omp generate_image backend
- [#15](https://github.com/alex-mextner/hsw-editor/issues/15) (o) Draw backend: ChatGPT in the browser (CDP)
- [#16](https://github.com/alex-mextner/hsw-editor/issues/16) (p) omp RPC bridge and UI panel
- [#17](https://github.com/alex-mextner/hsw-editor/issues/17) (q) omp tool bridge to edit the wall
- [#18](https://github.com/alex-mextner/hsw-editor/issues/18) (r) PWA app shell, service worker and offline op queue
- [#19](https://github.com/alex-mextner/hsw-editor/issues/19) (s) Model library caching and offline use
- [#20](https://github.com/alex-mextner/hsw-editor/issues/20) (t) 3d-cli tooling gaps for tool modelling
- [#21](https://github.com/alex-mextner/hsw-editor/issues/21) (u) End-to-end smoke tests (Playwright)
- [#22](https://github.com/alex-mextner/hsw-editor/issues/22) (v) Release, packaging and systemd autostart
- [#23](https://github.com/alex-mextner/hsw-editor/issues/23) (w) Domain hsw-editor.rs and landing page
- [#24](https://github.com/alex-mextner/hsw-editor/issues/24) (x) i18n ru/en
- [#30](https://github.com/alex-mextner/hsw-editor/issues/30) (y) WYSIWYG photo overlay: calibrate a photo of the real wall, drag and size holders on it, snapped to what is buildable
- [#56](https://github.com/alex-mextner/hsw-editor/issues/56) compat: tool-to-mount compatibility, auto-attach and re-hang
- [#57](https://github.com/alex-mextner/hsw-editor/issues/57) web: bank filter by selected tools (override with reset), fit-score ranking
- [#58](https://github.com/alex-mextner/hsw-editor/issues/58) bank: custom user elements (import, API, CLI, mine badge)
- [#59](https://github.com/alex-mextner/hsw-editor/issues/59) web: drag and drop tools onto mounts, Tools panel with thumbnails
- [#50](https://github.com/alex-mextner/hsw-editor/issues/50) (aa) Action registry and configurable hotkey engine ([docs/hotkeys.md](docs/hotkeys.md))
- [#52](https://github.com/alex-mextner/hsw-editor/issues/52) (ab) Per-user settings API with offline localStorage mirror
- [#53](https://github.com/alex-mextner/hsw-editor/issues/53) (ac) Cmd+Shift+P command palette: search everything, inline settings, ask the AI
- [#54](https://github.com/alex-mextner/hsw-editor/issues/54) (ad) Keybinding editor, shortcut cheat-sheet, migration of ad-hoc shortcuts

## Bank

The bank (`packages/bank`, [docs/bank.md](docs/bank.md)) indexes **428 elements**: 144 curated from the HSW sources and 284 generated parametric family rungs (19 families). **301** are redistributable (MIT / CC-BY) and **127** are not (CC-BY-NC, CC-BY-NC-SA, Standard Digital File, unknown). Licence policy: only redistributable elements may be committed; **103** of them (4 MB) are the seed in `packages/bank/seed`. Non-redistributable elements are indexed with `license.redistributable = false`, are never committed, and are ingested locally from the sources. Run `bun run bank:ingest` and `bun run bank:verify`.
- [#44](https://github.com/alex-mextner/hsw-editor/issues/44) (y) Realistic parametric tool library (`packages/tools`, [docs/tools.md](docs/tools.md))
- [#45](https://github.com/alex-mextner/hsw-editor/issues/45) (z) Custom tools from photos (single and multi-object import) and the user library
- [#46](https://github.com/alex-mextner/hsw-editor/issues/46) (aa) Tool Library panel and Add-from-photo wizard
- [#47](https://github.com/alex-mextner/hsw-editor/issues/47) (ab) Recognition with generator-rendered class prototypes

Full design: [docs/specs/2026-10-22-hsw-editor-design.md](docs/specs/2026-10-22-hsw-editor-design.md). Agent rules: [AGENTS.md](AGENTS.md).

## License

MIT
