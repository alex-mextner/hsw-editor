# hsw-editor CLI

`hsw-editor` (`cli/hsw_editor.py`, symlinked to `~/.local/bin/hsw-editor` by `scripts/install.sh`) manages the daemon and edits
walls through its HTTP API ([api.md](api.md)). `--port N` selects another daemon (default from
`~/.config/hsw-editor/config.json`, 8794). Everything below is also in `hsw-editor --help`.

## Lifecycle (agent-tools service manager)

| Command | Effect |
| --- | --- |
| `run` | foreground |
| `start` / `stop` / `restart` | background daemon (pidfile `~/.local/state/hsw-editor/`, log `~/.cache/hsw-editor/hsw-editor.log`); `start` returns only once the API answers, otherwise exit 4 with the log path |
| `status` | `running (pid, url) [autostart on]`, exit 3 when stopped |
| `enable` / `disable` | install / remove the systemd user unit `agenttools-hsw-editor-hsw-editor.service` (`Restart=on-failure`, `WantedBy=default.target`) and start / stop the daemon |
| `open` | open the editor in the browser (exit 3 if the daemon is down) |
| `--version` | read from the root `package.json` (`bun run release` is the only writer) |

The unit survives `systemctl --user daemon-reload` and starts at login or boot (the machine has `loginctl` linger).

## Wall verbs

Need the running daemon; if it is down the command exits 3 and prints `hsw-editor start`.

| Command | Effect |
| --- | --- |
| `wall list` | id, rev, counts, last update |
| `wall new <name> [--id ID] [--cols N] [--rows N]` | empty wall (default board 48 x 32 cells, HSW pitch) |
| `wall show <id>` | board, items table, photos, models; geometry warnings on stderr |
| `wall apply <id> <file\|-> [--base-rev N] [--actor KIND[:NAME]] [--label L]` | apply ops from a file or stdin as one atomic, undoable step. The JSON is one op, an array of ops, or `{"ops": [...], "baseRev": N}` |
| `wall undo <id>` / `wall redo <id>` `[--base-rev N] [--actor ..]` | step through the shared history |
| `wall export <id> [-o FILE] [--wall-only]` | wall + full history as JSON |
| `wall delete <id>` | move to `walls/.trash/` (recoverable) |

All wall verbs accept `--json` and then print the daemon's JSON response unchanged. `--actor` is `human`, `agent` or `cli`
(default), optionally `kind:name` (for example `agent:omp`); it is recorded with every history entry.

```sh
hsw-editor wall new "Garage" --id garage
echo '{"type":"addItem","item":{"kind":"holder","bankId":"hsw-hook","cell":{"col":4,"row":3}}}' | hsw-editor wall apply garage - --actor agent:omp
hsw-editor wall show garage
hsw-editor wall undo garage
```

## doctor

`hsw-editor doctor [--json]` prints `ok`, `warn` or `FAIL` per check, with a `fix:` line for everything that is not ok. Only
`FAIL` (exit 1) is fatal; `warn` marks an optional capability that is missing.

| Check | Level when missing | Notes |
| --- | --- | --- |
| agent-tools lib | FAIL | `AGENT_TOOLS_LIB` or `~/dev/agent-tools/lib` |
| bun | FAIL (warn on a version other than `.bun-version`) | |
| web build | FAIL | `apps/web/dist/index.html` (`HSW_EDITOR_WEB_DIST` overrides) |
| offline assets | warn | `sw.js` + `manifest.webmanifest` in the build: without them the app does not work offline |
| port | FAIL if another process holds it | an hsw-editor already serving is ok |
| data dir | FAIL if not writable, warn if world-writable | `HSW_EDITOR_HOME` |
| state-lib, uv, omp, GPU, vision sidecar, draw backends, systemd --user | warn | vision: `HSW_VISION_URL` (default `http://127.0.0.1:8795`); draw: `omp`, ChatGPT browser profile, manual upload |

Other modules add checks by appending to `hswlib.doctor.EXTRA_CHECKS`, and verbs with `register_verb` in `cli/hsw_editor.py`.

## Exit codes (stable)

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | a doctor check failed / unexpected internal error |
| 2 | invalid arguments, ops file or request body (HTTP 400) |
| 3 | the daemon is not running (also `status`, `stop` when nothing runs) |
| 4 | autostart or port failure (`enable`/`disable`, daemon did not come up, port taken) |
| 5 | unknown wall (HTTP 404) |
| 8 | request refused by the loopback guard (HTTP 403) |
| 9 | conflict: stale `--base-rev`, wall exists, nothing to undo/redo (HTTP 409) |
| 10 | an op was refused: locked item, unknown id, ... Nothing was applied (HTTP 422) |
| 127 | a required tool (bun, agent-tools lib) is missing |

Errors print as `error: <what>`, `why:`, `fix:` (agenttools_errors).

## Install and release

- `scripts/install.sh [--rebuild] [--no-build]`: idempotent. Always runs `bun install --frozen-lockfile` (a no-op when nothing
  changed, so a pulled lockfile is picked up), builds the web app when `apps/web/dist` is missing (`--rebuild` forces it), links
  `~/.local/bin/hsw-editor`. Needs no network when the bun cache is warm and the agent-tools lib is checked out.
- `bun run release [patch|minor|major|x.y.z] [--dry-run] [--skip-checks]`: validates the `[Unreleased]` changelog section first,
  then lint, typecheck, tests, web build and a server bundle check, bumps every `package.json`, refreshes `bun.lock`, moves
  `CHANGELOG.md`'s `[Unreleased]` section under the new version, commits `chore: release vX.Y.Z` and creates the annotated tag.
  It never pushes (`git push origin main --follow-tags`). To resume an interrupted run, pass the already-bumped version: only the
  release files may be pending, and a release commit that already exists is not repeated.
