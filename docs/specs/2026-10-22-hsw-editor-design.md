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
packages/overlay pure photo-overlay geometry: calibration, rectification, wall<->photo mapping, snapping
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

## WYSIWYG photo overlay (ticket #30)

User requirement (normative): wall creation is WYSIWYG. The user drops a photo of the REAL wall with a dimensional
reference in the frame (e.g. a 100 cm tape measure) and the HSW is overlaid directly on the photo. Elements are dragged on
the photo or sized by typing dimensions; sizes are always snapped to what is actually possible (valid HSW grid cells,
bank variant ladders, printable limits) and the UI shows what changed and why.

The geometry is pure TypeScript in `packages/overlay` (no web/DOM dependency, invariant-tested); the UI is a 'Photo' mode
of the editor shell and only calls it.

**Status.** Implemented: `packages/overlay` (calibration, rectification, camera recovery, mapping, snapping, wizard state
machine, EXIF helpers), `cellAtOffset`/`rotateCellOffset` in `packages/core`, the server photo normaliser (HEIC/AVIF/EXIF), and
in `apps/web` the 'Photo' mode: intake (drop / paste / choose, progress), the calibration wizard (two points, four corners,
detected grid), the photo as the viewport backdrop through a camera whose projection is the calibration homography itself
(exact on the wall plane), opacity / hide / before-after divider, moving and turning the board over the photo, dragging with
the snapped footprint and mm ruler guides, typed sizes snapped with `{requested, snapped, reason}`, PNG export with a banner,
and the 'find tools' button (job `vision.photo_to_objects`, graceful when the vision service is absent). The look of the
finished overlay is `docs/references/user-reference-wall-overlay-2026-10-22.jpg`. Sections "Math", "Snapping rules" and
"Edge cases" describe the package.

### Flow
1. **Add the photo**: drop, paste or choose a file. HEIC/HEIF is converted to JPEG by the server (`POST /api/walls/:id/photos`),
   EXIF orientation is applied once at ingest, so every pixel coordinate below is in the *oriented* image
   (x right, y down, origin top-left). The photo is stored with the wall (`photos/<id>.jpg`) and added by an `addPhoto` op.
2. **Calibrate** (wizard, one `setCalibration` op at the end, so undo/redo is one step):
   - *Two-point* (default): click the two ends of the reference and type its real length (default 1000 mm). Optional
     axis hint (horizontal / vertical) also fixes the camera roll. Exact for a fronto-parallel photo; for a tilted one it is
     the scale *along the reference at that place* (see edge cases).
   - *Four corners*: click the lower-left, lower-right, upper-right, upper-left corners of a rectangle of known size (the
     board, the wall) and type width x height. Gives the full homography, so camera tilt is rectified.
   - *Grid cells*: no manual wizard; the vision service's detected honeycomb cell centres (`calibrateFromCorrespondences`,
     method `grid`) give a least-squares homography with a reprojection report. This is what a board that already hangs
     gives for free.
3. **Overlay**: the photo is the backdrop of the wall view; the HSW grid and the items are drawn through the calibration.
   Opacity slider, before/after slider, PNG export of the composite.
4. **Edit on the photo**: drag items (live snap ghost, mm ruler guides, collision/bounds warnings), type dimensions in the
   inspector (requested -> snapped + reason). Each commit is the existing `moveItem`/`setParam` op.
5. **Find tools** (optional): when the vision service is up, a button proposes ghost holders for detected tools; absent
   service = button disabled, nothing else changes.

### Math
Wall plane: x right, y up, origin at the board's lower-left corner, mm. Photo: px, y down.

- A calibration is a homography `H` (3x3, row-major, photo px -> wall mm), stored in `Calibration.homography` together with
  `mmPerPx`, `reprojErrorPx` and the correspondences that produced it (`points`).
- *Two-point*: `s = L_real / |b - a|` (mm per px), `H = T(board centre) * R(roll) * diag(s, -s) * T(-photo centre)`; the board
  starts centred under the photo and can be shifted/rolled (`transformWallFrame`) by dragging, which only edits `H`.
- *Corners / cells*: normalised DLT. Both point sets are translated to the centroid and scaled to mean distance sqrt(2)
  (Hartley), the 8 unknowns of `H` (`h33 = 1`) solve the least-squares normal equations, `H` is denormalised. 4 points
  are exact; more points average out click noise. Reported: per-point residual in px (in the photo) and mm (on the wall),
  rms and max. The corners must be clicked starting at the lower-left, clockwise on screen; any other start or a
  mirrored order is rejected (`CornerOrderError`) instead of fitting a wall turned by 90 degrees.
- *Local scale* at a photo point is `sqrt|det J|` of `H` there (mm/px); along a direction it is `|J d|`. `scaleSpread`
  samples a 5x5 grid and reports `max/min - 1`.
- *Click error*: with clicks `e` px off at both ends of a reference of `L` px, the scale is off by at most
  `L / (L - 2e) - 1` (typical `sqrt(2) e / L`); the wizard shows this and mm per metre for 1 px and 3 px.
- *Camera* (for the camera-matched 3D view): for `H_wall->px = K [r1 r2 t]` with square pixels and the principal point at
  the image centre, `1/f^2` is the least-squares solution of `g1.g2 = 0` and `|g1| = |g2|`, `g_i = K^-1 h_i`; `R`
  is Gram-Schmidt orthonormalised, `r3 = r1 x r2`. A tilt-free wall leaves `f` undetermined: the estimate is only used when
  its conditioning is >= 0.02 (median focal error 2-3% on 0.7 px noise), otherwise the EXIF/26 mm-equivalent focal length is
  assumed. The plane mapping never depends on `f`, so dragging stays exact either way.

Dragging is done in photo space and mapped with `H^-1`/`H` only (the wall plane is the one surface the photo measures),
which keeps it precise; the camera-matched 3D canvas is used for display of depth (items standing off the wall).

### Snapping rules (everything is pure and idempotent)
- **Placement**: the pointer's wall position (minus the grab offset) goes to the nearest honeycomb cell centre (pitch
  20.4382 x 23.6 mm, `packages/core/src/grid.ts`) such that the item's whole footprint (bank `footprint.cells`,
  `{dCol, dRow2}` offsets) lies on the board. Reasons: `exact`, `nearest-cell`, `kept-in-board`, `free-cell`. Collisions
  with other footprints are warnings (`collision` + ids); `avoidCollisions` moves to the nearest free anchor instead.
  The footprint and extent turn with the item's `rotZ` (`rotateCellOffset`). Rotation snaps to multiples of 60 degrees. Ruler guides: distances (mm) to the 4 board edges and to the nearest neighbour
  in each direction.
- **Sizes** (`snapSize` -> `{requested, snapped, changed, feasible, reason}`), per dimension, from one of:
  `grid-span` (whole cells), `ladder` (bank family rungs; ties go to the larger rung), `range` (generator `ParamDef`
  min/max/step); optional `printMaxMm` (A1 bed 256 mm) lowers the result to the largest feasible value. Reasons:
  `exact`, `rounded-to-step`, `nearest-rung`, `whole-cells`, `min-limit`, `max-limit`, `printable-limit`, `unbuildable`.
  `nearestVariant` picks the nearest bank variant for several dimensions at once (distance normalised per dimension by its
  spread over the candidates; `prefer: 'fit'` = smallest variant that is large enough).
- The UI localises from the reason codes; it always shows requested, snapped and the reason next to the field.

### Edge cases
- **Tilted photo + two-point**: one scale cannot describe a perspective photo. The IMG_4937 test photo (taken from ~1.2 m,
  tilted 7/13 degrees) changes scale by >30% between its bottom and top. Two-point is accurate at the reference (tested:
  within 1% of the known scale at the reference) and degrades away from it. Two clicks cannot reveal the tilt, so the
  wizard always warns (`single-scale-only-at-reference`) and offers four corners; `scaleSpread` is reported for
  corner/grid calibrations, where it is measurable.
- **Short reference / big click error**: the click bound grows as the reference shrinks; below ~10% of the photo width the
  wizard warns instead of silently accepting.
- **Bad corner order / mirrored plane / convex check**: `CornerOrderError` instead of a mirrored fit (this includes
  starting at the wrong corner; the photo must be upright within 45 degrees of roll); collinear or coincident points:
  `DegenerateError`.
- **Horizon in the photo**: a homography whose plane horizon crosses the image is rejected (`createPhotoMap`).
- **Lens distortion** is not modelled; the reprojection report (px) shows when a wide-angle photo needs more points.
- **Items off the wall plane**: depth is shown only in the camera-matched 3D view; the overlay is exact for the mounting face.
- **No vision service / offline**: calibration, snapping and export are pure client code; auto-detection is optional.
- **Large photos**: the browser downsamples to <= 2048 px on the long side for display; clicks are kept in original-image
  coordinates, so calibration precision does not depend on the display size.

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

## Clarifications log
- 2026-10-23 (user, tg#24294, #166): where the invalid part's own background is red (red-handled tools, `docs/references/user-levitating-tools-2026-10-22.jpg`),
  the diagonal invalid-zone stripes are WHITE instead of red, everywhere stripes are drawn (viewport, legend swatches, photo-mode overlay, PNG export).
  Rule implemented in `apps/web/src/scene/invalid-zones/stripeColour.ts`: red-ish base colour -> white, anything else (and unknown colour) -> red.
