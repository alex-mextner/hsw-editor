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

### Changed

- `HSW_EDITOR_DATA_DIR` is now `HSW_EDITOR_HOME`.
- The built bank (`bank:ingest`) lives in `<data home>/bank`, the directory the daemon serves: `HSW_EDITOR_HOME`, else
  `$XDG_DATA_HOME/hsw-editor`. `bankPaths` no longer reads `HSW_EDITOR_DATA_DIR`; move a bank built under another directory
  or re-run `bun run bank:ingest`.

## [0.1.0] - 2026-10-22

### Added

- Monorepo skeleton: Bun daemon, Vite/React web app shell, `packages/core`, `packages/bank`, vision sidecar, lifecycle CLI on
  the agent-tools service manager.
