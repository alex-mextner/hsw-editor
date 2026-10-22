# hsw-editor — design spec (v0, 2026-10-22)

## Goal (user's words, normative)
A cool, convenient local service with 3D in the browser where the user quickly assembles, with AI help,
a wall for all their tools from a photo. When needed, widgets appear to enter dimensions, pick variants,
and compare found reference models. The user can pick from a bank of hundreds of ready-made HSW elements.
Walls are saved on disk. Works fully offline: service worker, caches, app shell.

Also required by the user:
- Local web service + daemon, commands `run/start/status/...` through the user's `agent-tools` library.
- Drop a photo with junk and separate tools -> get a wall. Create a wall from scratch by hand. Edit by agents
  AND by hand.
- omp (oh-my-pi) is started under the service and fully proxied into a UI panel on the page; use an existing plugin.
- Stack: TypeScript, React 19, Vite (oxc/rolldown), Bun, our state-lib (`@ultrabricks/state-lib`), shadcn on base-ui,
  Tailwind v4, three.js/R3F, oxlint+oxfmt.
- Find objects, recognise them, create 3D models for them ON THIS MACHINE (RTX 4060 8 GB).
  If 3d-cli lacks something, add the tooling to 3d-cli.
- Fitting a model to a photo/render must be FAST and WITHOUT AI. AI is optional, only for hard cases.
- Check several views. Missing views are drawn through draw-cli; if draw-cli only works via codex, add a browser
  ChatGPT backend (reuse agent-tools chatgpt-guardian CDP profile) so ChatGPT in the browser can draw.
- Public GitHub repo `alex-mextner/hsw-editor` with issues. Domain hsw-editor.rs at the registrar of bulka.rs
  (unlimited.rs, evidence: NS dns1-4.unlimited.rs). Use keychain-cli. If something cannot be done, prepare all so the
  user finishes with minimal steps.

## Facts found (recon 2026-10-22)
- agent-tools is a Python/markdown catalog, not an npm lib. Daemon verbs come from `lib/agenttools_service`
  (run|start|stop|status|enable|disable; pidfile, log, systemd user unit; `Service(name, argv, port, host, tool, description)`).
  Reference web-UI daemon: `~/dev/rig-cli/riglib/config_web_service.py` (hidden `_serve` verb). TS precedent: `~/dev/tg-cli/tg-ctl`.
  -> CLI `hsw-editor` is a thin Python entry using agenttools_service whose argv launches the Bun server.
- state-lib = `@ultrabricks/state-lib` 0.1.0-pilot.1, private, not on npm, source
  `~/work/state-site-release-20261013/packages/state-lib/runtime` (Runtime, toExternalStore, selectExternalStore),
  consumer pattern `~/work/tasks-state-resume-20261014/src/shared/lib/state/{scope.ts,react.ts}`.
- Stack template: `~/dev/tasks-app` (package.json, vite.config.ts, .oxlintrc.json, .oxfmtrc.json, bunfig.toml, tsconfig).
- omp: `omp --mode rpc|rpc-ui` JSONL (omp://rpc.md); SDK `createAgentSession`. Candidate web UIs:
  `theturtlecsz/omp-webui`, `klffjbkmhjkndml-arch/omp-web` (Bun daemon + Vite/React, one rpc child per session).
- ChatGPT browser: `agent-tools/lib/agenttools_chatgpt` (CDP attach, composer selectors, logged-in profile
  `~/.local/share/agent-tools/chatgpt-guardian/profiles/home`). Text only today; no image path. omp has `generate_image`
  (off by default, codex transport).
- 3d-cli: has fit-camera/silhouette/score/overlay/match/proxy-align, preprocess (rembg/SAM2/grabCut, Depth-Anything), CPU
  numpy/scipy, no differentiable renderer, no object detector (only printer failure YOLO), cached CLIP/DINOv2 ONNX.
  draw-cli is NOT installed on this PC.
- HSW: photo calibration from the honeycomb grid (IMG_4937, focal_px 720.8, reproj 0.44 px); tool models were hand-written
  Blender code (36 placements, physical_fit_verified=false). Bank sources: `projects/HSW/sources/downloaded-library` (70 MB),
  `catalog/`, `refit/DELIVERY.json` (16 holder variants).
- Safety: U1 printer is printing; nothing in this project may touch printers.

## Architecture
```
apps/web      Vite + React 19 + R3F + shadcn/base-ui + state-lib; PWA (app shell, SW, offline cache)
apps/server   Bun daemon: REST + SSE/WS, wall store on disk, job runner, omp RPC bridge, asset serving
packages/core wall schema (versioned JSON), ops (patch commands), geometry units, validation
packages/bank HSW element bank: index + GLB/parametric defs + thumbnails + search
services/vision  Python sidecar (uv): detect, segment, calibrate, fit, retrieve, image->3D (optional)
cli/hsw_editor.py  agenttools_service wrapper: run/start/stop/restart/status/enable/disable/open/doctor/wall ...
```
Storage: `~/.local/share/hsw-editor/walls/<id>/{wall.json,photos/,models/,history/}`; server is the single writer,
every mutation is an op appended to history (undo/redo, agent and human edits are the same op stream).
Editing by agents: same ops via CLI (`hsw-editor wall apply`), HTTP, and omp tool bridge; UI subscribes via SSE.

### Vision pipeline (fast, no AI by default)
1. Calibrate camera: honeycomb/known-grid detector (existing HSW method) or manual 2-point scale widget.
2. Segment: classical first (rembg/u2net ONNX, grabCut); SAM2/MobileSAM optional upgrade.
3. Detect/recognise: CLIP/DINOv2 retrieval over the bank + category templates (cached ONNX); optional open-vocab
   detector (OWLv2/GroundingDINO) on GPU for cluttered photos.
4. Build: parametric template (box/cylinder/loft/lathe/profile from bank) fitted by silhouette optimisation using a
   soft rasteriser on GPU/CPU (target < 2 s per object); dims shown in widgets, user overrides win.
5. Multi-view check: render fitted model from N views, compare edges/silhouettes with available photos; low confidence
   -> request extra views (draw-cli/ChatGPT backend, or ask the user for another photo).
6. Optional AI: VLM via omp for ambiguous objects; image->3D (TripoSR/TRELLIS GLB) + `3d proxy-align` as last resort.
Anything new and reusable goes into `~/dev/3d-cli` (+ issue in alex-mextner/3d-cli).

### Draw backends (missing views)
`DrawBackend` interface: `draw(prompt, refs[]) -> image`. Backends: `omp-generate-image` (codex transport),
`chatgpt-browser` (CDP, dedicated profile, one owner lock, human-pace, no stealth), `manual-upload`. Selected in settings.

### omp integration
Server spawns/supervises `omp --mode rpc-ui` per session; UI panel from an existing plugin (spike decides between
omp-webui / omp-web / own thin client on rpc.md). Panel shows streaming messages, tool calls, approvals, model switch,
sessions; plus a tool bridge so omp can edit the open wall.

### Offline / PWA
vite-plugin-pwa (Workbox): precache app shell, runtime-cache bank GLBs/thumbnails/models, IndexedDB mirror of the open
wall with op queue replayed when the daemon is back; no network calls at runtime except optional draw backends.

## Constraints
Heavy jobs: `flock /tmp/3d-cli-heavy.lock systemd-run --user --scope -p MemoryMax=6G -p CPUQuota=600% nice -n 10`; scratch under
`~/.cache/hsw-editor/`, never /tmp. No printer interaction. No secrets in repo. Russian UI strings (i18n-ready), English code.

## Decisions pending the user (non-blocking defaults)
1. state-lib is private: default = consume via local `file:` link generated by `bun run setup:state-lib`; NOT committed to the public repo.
2. Domain purchase: default = attempt via logged-in registrar session; stop before entering new card data.
3. Bank content licensing: only redistribute HSW elements whose licence allows it; otherwise fetch at setup.

## Learned while bootstrapping the skeleton (2026-10-22)
- state-lib: the pilot's `tools/export-pilot.mjs` hard-codes `../site/node_modules/.bin/tsc` and `git rev-parse HEAD` of the
  runtime dir. `bun run setup:state-lib` therefore copies the runtime into `~/.cache/hsw-editor/state-lib-build/`, links our `tsc`
  where the exporter expects it, makes a throw-away git commit, runs the real exporter, and writes `vendor/state-lib/` (gitignored).
  Override the source with `STATE_LIB_RUNTIME=<dir>`.
- Because the lib is private, the web app has two interchangeable store backends behind the `#state-backend` alias
  (`apps/web/src/state/{baseline,statelib}.ts`). Vite picks `statelib` only if `vendor/state-lib/dist/index.js` exists and
  `VITE_STATE_BACKEND` is not `baseline`. CI (no private lib) builds and tests the baseline backend.
- `agenttools_service` is imported from an installed package or, failing that, from `$AGENT_TOOLS_LIB` / `~/dev/agent-tools/lib`
  (stdlib-only, no network). The service argv is `[python, cli/hsw_editor.py, _serve, --port N]`; `_serve` execs Bun, so the
  tracked pid is the server itself. Service name `hsw-editor`, no `tool` namespace, so hints read `hsw-editor enable`.
- Default port 8794 (recorded in `~/.config/hsw-editor/config.json`); vite dev server 5194 proxies `/api` to it.
- The workstation `runpod-offload-gate` hook blocks whole-suite runs (`bun run test`, directory-wide `bun test`, `pytest dir`);
  single test files run locally, whole suites run in CI.
