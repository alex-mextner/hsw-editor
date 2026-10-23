# Changelog

All notable changes to hsw-editor. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). `bun run release` moves the `[Unreleased]` section under the new version, so every release
needs an entry here first.

## [Unreleased]

### Added

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

### Changed

- `HSW_EDITOR_DATA_DIR` is now `HSW_EDITOR_HOME`.
- The built bank (`bank:ingest`) lives in `<data home>/bank`, the directory the daemon serves: `HSW_EDITOR_HOME`, else
  `$XDG_DATA_HOME/hsw-editor`. `bankPaths` no longer reads `HSW_EDITOR_DATA_DIR`; move a bank built under another directory
  or re-run `bun run bank:ingest`.

## [0.1.0] - 2026-10-22

### Added

- Monorepo skeleton: Bun daemon, Vite/React web app shell, `packages/core`, `packages/bank`, vision sidecar, lifecycle CLI on
  the agent-tools service manager.
