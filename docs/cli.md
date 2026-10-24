# hsw-editor CLI

`hsw-editor` (`cli/hsw_editor.py`, symlinked to `~/.local/bin/hsw-editor` by `scripts/install.sh`) manages the daemon and edits
walls through its HTTP API ([api.md](api.md)). `--port N` selects another daemon (default from
`~/.config/hsw-editor/config.json`, 8794). Everything below is also in `hsw-editor --help`.

## Lifecycle (agent-tools service manager)

| Command | Effect |
| --- | --- |
| `run` | foreground |
| `start` / `stop` / `restart` | background daemon (pidfile `~/.local/state/hsw-editor/`, log `~/.cache/hsw-editor/hsw-editor.log`); `start` returns only once the API answers, otherwise exit 4 with the log path. While autostart is enabled for the port (the unit's own `--port`; another `--port` keeps the pidfile path) the verbs go through `systemctl --user start\|stop\|restart agenttools-hsw-editor-hsw-editor.service` (a leftover pidfile daemon is stopped first), so exactly one daemon runs; `systemctl` failing or unreachable is exit 4, `stop` of an inactive unit exit 3 |
| `status` | `running (pid, url) [autostart on]`, exit 3 when stopped; with autostart on, the pid is the unit's `MainPID` and an inactive unit reads `stopped` |
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
| `wall physics <id> [--item ID]` | how the tools hang on their holders (stability score, swing / tip / levitating / overload problems, removal ergonomics) as a table plus one sentence per problem; `--item` judges one tool. See [physics.md](physics.md) |
| `wall seat <id> [--item ID] [--apply] [--actor ..]` | where the hung tools rest in their holders (the daemon's seat proposal, [api.md](api.md#seating)): table of tools that move, tools without a seat and why. Nothing is written without `--apply`, which applies the poses as one undoable `seat all` step (`--item` seats one tool in its own slot) |
| `wall delete <id>` | move to `walls/.trash/` (recoverable) |

All wall verbs accept `--json` and then print the daemon's JSON response unchanged. `--actor` is `human`, `agent` or `cli`
(default), optionally `kind:name` (for example `agent:omp`); it is recorded with every history entry.

```sh
hsw-editor wall new "Garage" --id garage
echo '{"type":"addItem","item":{"kind":"holder","bankId":"hsw-hook","cell":{"col":4,"row":3}}}' | hsw-editor wall apply garage - --actor agent:omp
hsw-editor wall show garage
hsw-editor wall undo garage
```

## Tools

`hsw-editor tools ...` (needs the daemon; `import` needs the vision sidecar). See [tools.md](tools.md).

| Command | Effect |
| --- | --- |
| `tools classes [ID]` | built-in tool classes; with an id: every parameter with its default and range, and the presets |
| `tools list` | the user's tools: id, class, size, fit confidence, created, tags, name |
| `tools import <photo...> [--single] [--mm-per-px X \| --two-point X1,Y1,X2,Y2 --distance-mm D] [--class ID\|generic] [--name N] [--length-mm L] [--tag T]... [--add]` | upload the photos as an import draft, run the analysis job, print the objects found with their top-3 classes, size and fit; `--add` adds every object to the library, without it the draft is left for the editor wizard. `--single`: all photos show ONE tool; `--tag` (repeatable) labels every found object, tags are normalised (lower-case, 1-40 characters, at most 20) |
| `tools show ID` | class, tags, fit quality, dimensions and where they came from, colours, files |
| `tools rm ID` | move the tool to `tools/.trash/` (recoverable) |

All accept `--json`. Objects without a scale are listed with `needs scale` and are not added until the photo is calibrated.

## Bank verbs

Your own bank elements (#58): a mesh is uploaded, converted by the daemon into a normalised GLB in the wall frame and merged into
the bank (`my-*` ids, `source: user`; see [bank.md](bank.md) and [api.md](api.md)). Need the running daemon; the converter needs
`uv` (`hsw-editor doctor`).

| Command | Effect |
| --- | --- |
| `bank add FILE --name TEXT --category ID [flags]` | upload `.stl`/`.glb`/`.3mf` (up to 100 MB), run the `bank.user.import` job, poll it (progress on stderr) and print `<id>  <name>  <category>  <dims>` |
| `bank add --replace ID [FILE] [flags]` | replace a user element keeping its id; without FILE the stored original is re-converted (name and category default to the stored ones) |
| `bank list [--all]` | id, name, category, tags, size, footprint of your elements; `--all` lists the whole bank with a `source` column (`user`\|`bank`) |
| `bank show ID` | tags, tool classes, fitsTool, footprint and mounting, size, watertight/repaired, original file, dates |
| `bank rm ID [--force]` | delete; exit 9 and the walls using it unless `--force` |
| `bank edit ID [--name T] [--name-ru T] [--name-en T] [--category ID] [--tag T ...] [--add-tag T ...]` | change metadata only (at least one flag, else exit 2); `--tag` replaces all tags, `--add-tag` extends them |

`add` flags: `--name` (both languages) or `--name-ru` / `--name-en` (a single language is mirrored), `--tag TEXT` (both
languages) and `--tag-ru TEXT`, `--tool-class ID[:DIM=MIN-MAX,...][:capacity=N]` (repeatable; the class is also added to the
element's tool classes), `--part ID`, `--out AXIS --up AXIS` (source axes, e.g. `+z`/`+y`; together or not at all),
`--anchor back-bbox|origin|panel`, `--unit auto|mm|cm|m|in`, `--no-repair`, `--mounting hex-plug|m3-screw|clip|none` (cells are
the ones detected for these settings), `--id my-x`. A missing file, a missing `--name`/`--category`, a half orientation or a
malformed `--tool-class` exit 2 before any request. All bank verbs accept `--json` (`add` then prints the new element).

Bank errors use the same exit codes: 2 for an unsupported format (415, fix: `.stl .glb .3mf`), a file over 100 MB (413) or an
unreadable mesh (422 `mesh_unreadable`), 3 daemon down, 5 `element_not_found`, 9 `element_in_use`; a missing converter (503
`converter_unavailable`) and a failed import job exit 1 with a `fix:` line.

```sh
hsw-editor bank add ~/models/driver-holder.stl --name "Driver holder" --category accessories \
  --tag screwdriver --tool-class screwdriver:shaftDiameter=3-8:capacity=4 --out +z --up +y --mounting hex-plug
hsw-editor bank list
hsw-editor bank edit my-driver-holder --add-tag organizer
hsw-editor bank rm my-driver-holder --force
```

## vision

`hsw-editor vision VERB ...` (`cli/vision_verb.py`, details in [vision.md](vision.md)); the heavy verbs run under the repo's flock + systemd-run wrapper.

| Command | Effect |
| --- | --- |
| `vision setup [--cpu] [--force] [--dry-run]` | create/refresh the vision venv (`~/.cache/hsw-editor/vision-venv`): light locked deps + the heavy torch/ORT stack; idempotent |
| `vision status [--json]` | installed? running? endpoint, resident engines, models on disk; exit 3 when not installed / not running |
| `vision fetch-models [NAME...]` | the only command that downloads model weights |
| `vision doctor` | models, free VRAM, onnxruntime CUDA state, heavy imports |
| `vision photo-to-wall IMAGE --out DIR` | photo of a REAL wall -> wall proposal without the daemon (`proposal.json`, `result.json`, `timings.json`, `overlay.jpg`); never for photos of tools lying around (use `photo-to-objects`) |
| `vision photo-to-objects IMAGE --out DIR` | photo -> per-object masks, crops, classes, fitted models, colours, embeddings (`objects.json`) |
| `vision embed IMAGE... --out DIR [--object]` | CLIP embeddings (`embeddings.npy`, `embeddings.json`) |

Exit codes of the photo verbs: 0 ok, 2 bad input or no scale (`--two-point X1,Y1,X2,Y2 --distance MM` or `--mm-per-px`), 127 missing model or dependency (names the fix).

## draw

`hsw-editor draw VERB ...` (`cli/draw_verb.py` execs `apps/server/src/draw/cli.ts`; details in [draw.md](draw.md)): `status [--probe] [--json]` (exit 1 when no automatic
backend is ready), `doctor`, `login chatgpt`, `stop`, `settings [auto|draw-cli|omp|chatgpt-browser|manual]`, `run [--backend id] < request.json`.

## doctor

`hsw-editor doctor [--json]` prints `ok`, `warn` or `FAIL` per check, with a `fix:` line for everything that is not ok. Only
`FAIL` (exit 1) is fatal; `warn` marks an optional capability that is missing.

| Check | Level when missing | Notes |
| --- | --- | --- |
| agent-tools lib | FAIL | `AGENT_TOOLS_LIB` or `~/dev/agent-tools/lib` |
| bun | FAIL (warn on a version other than `.bun-version`) | |
| web build | FAIL | `apps/web/dist/index.html` plus the `.build-ok` stamp that `bun run build` writes only after a successful build (`HSW_EDITOR_WEB_DIST` overrides the directory); a build without the stamp is a failed or interrupted one, fix: `bun run build` |
| offline assets | warn | `sw.js` + `manifest.webmanifest` in the build: without them the app does not work offline |
| bank integrity | FAIL if the built bank is inconsistent, warn if absent (seed served) or the tooling is missing | runs `bun run bank:verify`: exit `0` consistent, `1` problems, `3` nothing built |
| bank seed | FAIL if the committed seed is corrupt | `bank:verify --seed`; fix `git checkout packages/bank/seed` |
| bank (served) | FAIL if the daemon rejected a generation or serves nothing | only when the port answers as hsw-editor (`/api/bank/health`); no row otherwise |
| port | FAIL if another process holds it | an hsw-editor already serving is ok |
| data dir | FAIL if not writable, warn if world-writable | `HSW_EDITOR_HOME` |
| state-lib, uv, omp, GPU, vision sidecar, draw backends, systemd --user | warn | vision: `HSW_VISION_URL`, else the sidecar's state file, else `http://127.0.0.1:8795`; "installed, not running" is the normal idle state (the daemon starts the sidecar on the first vision job; fix for "not installed": `hsw-editor vision setup`); draw: `omp`, ChatGPT browser profile, manual upload |

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
  changed, so a pulled lockfile is picked up), builds the web app when `apps/web/dist` lacks `index.html` or the `.build-ok` success stamp, so a failed or partial build is redone (`--rebuild` forces it), links
  `~/.local/bin/hsw-editor`. Needs no network when the bun cache is warm and the agent-tools lib is checked out.
- `bun run release [patch|minor|major|x.y.z] [--dry-run] [--skip-checks]`: validates the `[Unreleased]` changelog section first,
  then lint, typecheck, tests, web build and a server bundle check, bumps every `package.json`, refreshes `bun.lock`, moves
  `CHANGELOG.md`'s `[Unreleased]` section under the new version, commits `chore: release vX.Y.Z` and creates the annotated tag.
  It never pushes (`git push origin main --follow-tags`). To resume an interrupted run, pass the already-bumped version: only the
  release files may be pending, and a release commit that already exists is not repeated.
  On this workstation two global git hooks sit around the script (rehearsed end to end in a throwaway clone, hsw-editor #22):
  the `review-before-commit` gate refuses the `chore: release` commit until the staged diff was reviewed, so the first run stops
  there with the version files staged; run `review diff --staged --task '#N'` (or `review-remote diff --staged ...`), then resume with
  `bun run release X.Y.Z`. The publish step `git push origin main --follow-tags` is refused by the `protect-main` pre-push hook;
  it is the release-script exception, so push with `PUSH_MAIN_OK=1 PUSH_MAIN_REASON="release vX.Y.Z" git push origin main --follow-tags`
  (the override is logged). The test gate is the full suite (159 s on the build box): on the workstation wrap the run in the heavy-run wrapper of AGENTS.md.
