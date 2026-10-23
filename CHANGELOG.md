# Changelog

All notable changes to hsw-editor. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). `bun run release` moves the `[Unreleased]` section under the new version, so every release
needs an entry here first.

## [Unreleased]

### Added

- Tool Library (`apps/web/src/features/tools`, [docs/tools.md](docs/tools.md#ui-tool-library-and-add-from-photo), #46): the Tools tab lists
  built-in classes and the user's tools with generated thumbnails, grouped by type, searchable in ru/en and filterable by tag;
  click or drag a tool onto the wall; detail page with live 3D preview, parameters, materials and the holding interface; the
  inspector's "Suggested holders" now rank with `@hsw-editor/compat`; the "Add from photo" wizard (review grid, class
  override, merge/split, dimensions, 3D preview, comparison with built-in candidates) and four palette commands.
- `@hsw-editor/tools/contract`: browser-safe zod schemas and types of the tool library and import drafts.
- Hanging tools by drag and drop (web): dragging a tool (on the wall or from the Tools panel) glows the mounts that take it
  and shows a ghost at the snapped pose; an unsuitable mount is non-droppable and says why (ru/en tooltip). Release snaps the
  tool onto its slot with a short glide (one undo step), a refused drop returns it. Holders carry their tools when moved,
  rotated or nudged; removing a holder detaches its tools first (toast, Inspector flag); "add holder for tool" hangs the
  tool through `attachItem`. Tools panel cards call `beginToolDrag` / `endToolDrag` (`scene/toolDrop.ts`). `auditHangs` judges
  capacity on tools owning a valid slot first (#84; a slot shared by two tools gets the new `slot_taken` reason), and a test pins the compat bank-seed fixture to the committed seed.
- Tool tags and class thumbnails: user tools carry normalised `tags` (import draft objects, commit body, `POST`/`PATCH /api/tools`, `hsw-editor tools import --tag`);
  `GET /api/tools` summaries add `tags`, `bankClass`, `fit`, `dimsMm`, `holdingDims`, `thumb`; `GET /api/tools/:id/holding`;
  `GET /api/tools/classes/:id/thumb.webp` (on-demand render, memory + disk cache, ETag/304); class entries add `thumb`, `dimsMm`, `holdingDims`.
- Wall document schema, invertible op reducer and history (`packages/core`): `Wall`, `WallItem`, `Photo`, `ModelRef`,
  16 ops with `applyOp(wall, op) -> { wall, inverse }`, collision/bounds warnings, `schemaVersion` migration hook.
- Wall store (`~/.local/share/hsw-editor/walls/<id>`, `HSW_EDITOR_HOME`): atomic `wall.json`, fsynced `history.jsonl`,
  crash recovery by history replay, undo/redo as inverse ops, optimistic concurrency (`baseRev`), per-op actor.
- REST + SSE API (`docs/api.md`): walls, ops, undo/redo, photo/model upload, event stream with `Last-Event-ID` resume,
  input requests (`request_input`), generic job runner with SSE progress (`registerJob`), module extension point.
- Loopback-only guard (Host/Origin), no CORS; static serving with immutable asset caching and ETag revalidation.
- CLI: `hsw-editor wall list|new|show|apply|undo|redo|export|delete`, `--json`, stable exit codes (`docs/cli.md`),
  complete `doctor` (bun, uv, omp, GPU, ports, agent-tools lib, vision sidecar, draw backends, offline assets, data dir),
  `--version` read from `package.json`, `start`/`enable` wait for the daemon to answer.
- `bun run release`, `scripts/install.sh` (idempotent, offline when the agent-tools lib is present).
- HSW element bank (`packages/bank`, `docs/bank.md`): element schema and validator, ru/en search, ingestion pipeline
  (`bun run bank:ingest|bank:verify|bank:build-variant`), 428 elements (144 from sources, 284 generated family rungs),
  a 103-element redistributable seed under `packages/bank/seed`, and `createBankHandler` (`/api/bank/*`, `/bank/assets/*`),
  mounted in the daemon by `apps/server/src/bank-routes.ts`.
- Offline wall editing library (`apps/web/src/offline`, [docs/offline-sync.md](docs/offline-sync.md), #87; the editor session
  is wired to it in a follow-up): IndexedDB wall mirror with a persisted edit queue, replay with `baseRev`, conflict
  reconciliation (rebase / keep mine / keep theirs) on the core reducer, connection monitor with backoff probing, an SSE
  source that resumes with `?since=<rev>`.
- Installable offline app shell ([docs/offline.md](docs/offline.md), #89): custom service worker (injectManifest) precaching the shell, bank models/thumbnails cache-first, bank index stale-while-revalidate (never storing non-200, opaque or HTML answers), byte-budget LRU with pinning, a download-for-offline manager, update flow where the new worker takes over only when the user accepts, install controller, PNG/maskable/apple-touch icons and iPhone startup images.
- omp bridge (`apps/server/src/omp`, `packages/omp-protocol`): one supervised `omp --mode rpc-ui` child per wall behind
  `/api/omp/ws` (loopback-only, crash restart with backoff, child cap, idle stop, resumable per-wall sessions) and the wall
  host tools `wall_get`, `wall_apply`, `wall_undo`, `wall_bank_search`, `wall_select`, `wall_view`, `wall_request_input`
  (agent edits are ordinary `actor: omp` ops, destructive batches need approval). `ServerModule` gained an optional `stop()`.
- Offline wall editing in the editor ([docs/offline-sync.md](docs/offline-sync.md), #87): `WallSync` mirrors the open wall and its queued edits to IndexedDB, reopens it with the daemon down, replays and reconciles on reconnect, with a conflict dialog (rebase / keep mine / keep theirs); the event stream resumes with `?since=<rev>` and feeds one shared connection monitor; the wall list falls back to mirrored walls.
- omp agent panel (`apps/web/src/features/omp`, docked in the editor shell): streaming transcript with tool calls, approvals and
  questions, model/thinking switch, sessions, steer/queue/abort, usage; `wall_view` screenshots and `wall_select` served by the
  3D viewport. Docs in `docs/omp.md`.
- User-made bank elements (#58): import an STL, GLB or 3MF (`hsw-editor bank add|list|show|rm|edit`, the _Add element_ dialog of
  the web bank, `/api/bank/user/*` + job `bank.user.import`). The mesh is normalised to a GLB in the wall frame (mm, Z-up/Y-up
  sources mapped by a chosen orientation), checked for watertightness and repaired when possible, thumbnailed headlessly (software
  fallback without EGL) and stored in `<home>/bank-user`, outside the built bank's generations. The daemon merges it into
  `/api/bank/index` with `source: "user"` (a _mine_ badge and filter in the bank), so search, filters and tool compatibility
  see it. The dialog edits name ru/en, category, tags, footprint cells (hex grid picker), mounting kind and pegs, `fitsTool`
  classes with dimension ranges, with a live 3D preview. See `docs/bank.md` ("User elements").
- GitHub Pages build is a read-only offline demo ([docs/offline.md](docs/offline.md), #88): `VITE_HSW_DEMO=1` serves the committed seed bank as static files, opens one bundled wall on the first visit, refuses edits with a notice and makes no wall, health or event-stream request.
- Photo mode, first slice (`apps/web/src/features/photo`, #30): drop, paste or choose a wall photo (JPEG, PNG, WebP, HEIC,
  AVIF) with upload and server-conversion progress, and a calibration wizard on `packages/overlay`: two clicks on a tape plus
  its typed length (default 1000 mm, mm/cm/in), four wall corners (perspective rectified), or the detected honeycomb grid, with
  a live scale readout, click-error bound, fit error and scale spread. One `setCalibration` op per calibration. Strings in ru/en.
- Offline storage dialog (top bar, [docs/offline.md](docs/offline.md), #89): usage and quota, per-category sizes, make the whole bank or one category available offline (pinned), clear models/thumbnails, keep storage, install the app.
- Ask AI from the command palette is live (Refs #53, `docs/omp.md`): the omp host tool `app_command` lists, searches and runs
  the editor's registered commands on the page (`ViewportCall` method `app_command`, 5 min timeout, `ui_cancel` message on
  abort), and the palette's `PaletteAiBridge` now runs on the agent panel's connection (palette-mode prompt, streamed answer,
  `⌘K ·` marker in the panel transcript). Changing actions still need the palette's approval unless `auto` is on.

### Changed

- Web: a tool dragged on the wall hangs on a suitable mount or, dropped elsewhere, snaps to a lattice cell as before (Alt = exact). Its box is
  drawn from the butt (origin) towards the tip, the frame the mounts use, so tools saved earlier appear shifted by half their length.
- `HSW_EDITOR_DATA_DIR` is now `HSW_EDITOR_HOME`.
- The built bank (`bank:ingest`) lives in `<data home>/bank`, the directory the daemon serves: `HSW_EDITOR_HOME`, else
  `$XDG_DATA_HOME/hsw-editor`. `bankPaths` no longer reads `HSW_EDITOR_DATA_DIR`; move a bank built under another directory
  or re-run `bun run bank:ingest`.

## [0.1.0] - 2026-10-22

### Added

- Monorepo skeleton: Bun daemon, Vite/React web app shell, `packages/core`, `packages/bank`, vision sidecar, lifecycle CLI on
  the agent-tools service manager.
