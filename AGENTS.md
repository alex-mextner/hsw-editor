# hsw-editor agent rules

Local 3D wall editor for HSW honeycomb tool walls. Spec: `docs/specs/2026-10-22-hsw-editor-design.md` (authoritative).

## Layout

`apps/web` (Vite+React 19+R3F+shadcn/base-ui+Tailwind v4, PWA) | `apps/server` (Bun) | `packages/core` (wall schema, ops) | `packages/overlay` (photo calibration + snapping, pure) |
`packages/bank` | `services/vision` (uv, FastAPI) | `cli/hsw_editor.py` (agenttools_service wrapper, symlinked to `~/.local/bin/hsw-editor`).

## Commands

`bun install`, `bun run dev|build|lint|typecheck|test|check`, `bun run setup:state-lib` (private lib, optional), `hsw-editor doctor|start|status|stop`.
Vision: `cd services/vision && uv sync && uv run pytest`.

## Hard rules

- NEVER touch 3D printers (no `3d printer start/pause/cancel/upload`, no G-code). Read-only `3d printer status` only if truly needed.
- No secrets in the repo or output; reference keychain entries by name/path only. No `git stash`. Atomic commits: `<area>: <what changed>`.
- TypeScript strict; no `any`, no `@ts-ignore`/`@ts-expect-error`. Code and identifiers in English; UI strings i18n-ready (ru/en).
- Heavy runs (builds of big deps, model downloads, torch): `flock /tmp/3d-cli-heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 -p CPUQuota=600% nice -n 10 <cmd>`;
  scratch, venvs and models live under `~/.cache/hsw-editor/`, never `/tmp`. Check `uptime` first.
- Do not disturb other services (`chatgpt-guardian-*`, `pm-chatgpt-*`, `omp-auth-broker`, 3d-printer-*, hsw-review :8767). Pick free ports with `ss -ltn`.
- The wall store on disk (`~/.local/share/hsw-editor/walls/`) has the server as its single writer; every mutation is an op in the history.
- `vendor/` is gitignored (private state-lib build). CI runs without it (baseline store backend).
- Reusable vision/3D tooling belongs in `~/dev/3d-cli` (with an issue in alex-mextner/3d-cli).
