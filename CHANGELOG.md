# Changelog

All notable changes to hsw-editor. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). `bun run release` moves the `[Unreleased]` section under the new version, so every release
needs an entry here first.

## [Unreleased]

### Added

- Tools let go with nothing holding them fall to the floor (#257): a tool released free (a drag onto bare board, Alt = free move, a drop from the Tools panel) is judged by the same hang analysis as the physics badge (`levitating`, `falls`, `tips` mean it cannot stay); when it cannot it drops under gravity to a floor plane 150 mm under the board, tumbles into the lying pose with the lowest centre of gravity, slides off whatever it lands on that cannot carry it, and stays on the floor. The release and the fall are ONE undo step (undo puts the tool back where it came from); a fallen tool is picked up like any other and can be hung again. The floor is drawn lit and pulsing, with a label, while a tool is dragged or falling, and as a quiet plane while a tool lies on it; a hint next to the pointer says what a release over bare board does. `planFall` / `releaseFalls` in `@hsw-editor/physics`, the worker's `fall` job, `floor.ts` constants in `@hsw-editor/core`, [docs/physics.md](docs/physics.md#let-go-with-nothing-holding-it-the-floor).
- Every icon button explains itself (#256): the photo overlay button is a camera (it was a crossed-out eye that read as "something is hidden") and, with no photo yet, says it asks for a file; photo calibration is a crosshair, no longer a second ruler next to Measure; the first press of any icon on a device holds its tooltip open once, which is the only explanation on a phone; static and DOM audit tests keep every icon button named, in English and Russian ([docs/ui-icons.md](docs/ui-icons.md)).
- Seats are clean (#258): tools enter holes and slots cleanly and sit stably. The hang analysis flags `wedged` (the end of a tool jammed in an opening too small for it, so the handle floats above the rim while the contacts look fine) and `protrudes` (a pliers or wrench rack too shallow for the tool); the seat search charges both and prefers the shaft through the hole with the handle on the rim; a tool that would tip or has nothing against a pull leans back against the wall (the cordless drill on its battery, the open-end wrench); the showcase and demo seeds pair holder and tool (the 5 mm screwdriver rail with 4 mm shafts, long-nose pliers sized to the 66 mm rack); named regression tests for every circled case, close-up script `apps/web/scripts/showcase-closeups.ts` ([docs/physics.md](docs/physics.md#the-hang-report-analysehangpose)).
- The Pages demo serves the Tool Library statically (#254): every built-in class with thumbnail and model, per-parameter models and holding generated in the browser, an empty user library, and a localized "needs the full app" message instead of `HTTP 404` for anything that needs a daemon (`apps/web/src/demo/staticApi.ts`, [docs/offline.md](docs/offline.md#github-pages-demo-hswmextnercom)).
- Editing the demo (or any template wall) silently clones it (#255): the first edit of a template wall makes an independent copy, opens it and applies the edit there, with no read-only banner and no refusal. The Pages demo is now a full local editor (own walls, undo and redo, kept across reloads); the daemon gets `POST /api/walls/:id/clone` and `PUT /api/walls/:id/template` (`showcase-wall.ts --template`), see [docs/api.md](docs/api.md#walls).
- Draw backend `draw-cli` (#36, #191): the editor's draw and the `photo.clean` AI step use the user's [draw-cli](https://github.com/alex-mextner/draw-cli) whenever it is installed and its Codex is signed in with ChatGPT, so there is no separate login: `auto` now tries `draw-cli` first, then `omp`, `chatgpt-browser`, `manual`. It shells out to `draw --backend chatgpt -i <refs> -o <out>` (the photo.clean mask is the second `-i`), asks `draw --backend chatgpt --check` for its state on every status call (`hsw-editor draw status` / `GET /api/draw/backends` show `draw-cli: ready`), copies no credential and prints none. Run for real: a generated image through `hsw-editor draw run`, and `photo.clean` on IMG_4937 answered by `backend: draw-cli` ([docs/draw.md](docs/draw.md#backends)). Pin it with `hsw-editor draw settings draw-cli`.
- CLI lifecycle is the agent-tools `agenttools_service` library, nothing of it is hand-rolled any more (#247): the systemctl wrapper (`hswlib/unit_lifecycle.py`), the unit-port parser, the readiness wait and the systemd doctor check are deleted, `restart`, `logs`, the readiness wait (`/api/health` must answer as hsw-editor, else exit 4 with the log path), the linger check at `enable` and the doctor rows (unit verify, unit state, linger) come from library 0.3. `--port N` is its own service (`hsw-editor-N`: unit, pidfile, log), so a throwaway daemon cannot touch the real one, and the service argv carries `--home` so a unit keeps the data directory it was enabled with. Needs `~/dev/agent-tools` at 0.3 or newer (`git pull`); the CLI says so when the library is older. Docs: [docs/cli.md](docs/cli.md#lifecycle-agent-tools-service-manager).
- Tools added by the agent, the API or the CLI are seated by the daemon, so an AI-built wall has no "levitating" flags (#223): `GET /api/walls/:id/items/:itemId/seat` and `GET /api/walls/:id/seat` propose the poses the editor's Seat tools would move the tools to (the editor's own `seatTool` search on the real holder mesh, read-only; [docs/api.md](docs/api.md#seating)); `wall_add_tool` applies the seat as a second undo step and reports it; the new agent tool `wall_seat_tools` and `hsw-editor wall seat <id> [--apply]` seat a whole wall as one undoable `seat all` step. `isUpright`, `slotHalfWidthMm` and `wallSlot` moved to `@hsw-editor/compat` and `seatSlotInput` / `planSeatAll` to `@hsw-editor/physics`, shared by the editor and the daemon. `wall_add_tool` refusals now list a holder whose bank element could not be fetched (`bank element unavailable`) and say a slot is taken with the free slots.
- The embedded agent can build a wall for the user's tools (#217): host tools `wall_tools_search` (the tool library by tag, class and text, with suggested holders and the library's tags) and `wall_add_tool` (a library tool added as its real model and hung on a compatible holder with the editor's own `@hsw-editor/compat` placement, one undo step), and a "building a wall for the user's tools" recipe in the system prompt that proceeds with defaults instead of asking. `wall_analyse_hang` is now auto-approved like the other host tools; `toolDraftOps` (the model ref + tool item of an added tool), `toolInterfaceFromHolding` and `measuredDimensions` moved to `@hsw-editor/compat` so the editor and the daemon share them. See [docs/omp.md](docs/omp.md#host-tools).
- Photo segmentation is 3.4x faster by default (hsw-editor #10): `segment.quality` `fast` (sidecar default; `POST /segment` 8.3 s -> 2.4 s warm on the GPU) or `accurate` (the former default), per request and as the `vision.segmentQuality` setting (palette, ru/en;
  the daemon adds it to every stage request). `threed-vision` bumped for it (3d-cli #543); measurements and a real-photo timing test in [docs/vision.md](docs/vision.md#segmentation-speed-quality-fast--accurate).
- Physics on the generated tool models (#167 follow-up): the physics judges the model the scene draws (`resolveToolModel`, also a size rebuilt
  for the item), the amber marks follow that model, a dimension edit re-seats the tool (`rehang`), and "Seat tools" (Physics section, palette
  `physics.seat`) puts every hung tool inside its holder as one undo step (`seatAllTools`). Seating starts from the holder's own rim, so something
  hanging above the slot is no floor; removal tries lifts the rasters call blocked and the tool's own axis for a tool resting tilted.
- Tools on the wall are drawn as their generated realistic models ([docs/tools.md](docs/tools.md#tool-models-on-the-wall), #162): an immutable content-hashed tool model store
  (`/tools/assets/glb/*`, `/api/tools/assets/index|health`) with the bank's verify/repair/error-boundary guarantees, instanced PBR rendering with LOD, models rebuilt
  in a worker for typed sizes and class parameters (proportions and sizes held to real tools, `realism.ts`), hung tools seated with the model's own holding
  interface and re-hung after a resize, invalid-zone checks on the tool mesh, offline caching and pinning, the inspector's model card, a camera that frames tools
  overhanging the board, and a Pages demo wall of generated tools.
- Multi-view consistency check (#13, [docs/vision.md](docs/vision.md#multi-view-check-ticket-13)): `objects.json` records carry `multiView` (mode, status, worst
  held-out IoU, per-photo views, failed sanity checks) next to `confidence`, `needsView` and the suggested `needsViews` (azimuth/elevation); `/multiview` takes views
  as mask files (`mask_path`) and scores DRAWN views (`generated_views`) as flagged `source: "generated"` hints that never touch the confidence. A recorded real-fit
  regression test (`services/vision/tests/data/carpet-fit`, 18 KB, no GPU) pins a good fit at 0.91-0.97 held-out IoU and wrong ones at 0.26-0.65.
- Draw a missing view of a draft object (3d-cli #468, [docs/draw.md](docs/draw.md#drawing-a-missing-view-of-a-draft-object-toolsdraw_view)):
  `POST /api/tools/drafts/:id/objects/:key/draw-view` queues the `tools.draw_view` job (cut-out on white as the subject, `packages/draw` prompt and quality gate,
  `DrawBackend`); drawings are kept as `source: 'generated'` candidates (`GET .../drawn`), a pinned backend without login/quota is refused with the literal steps
  (`409 login_required` ...), `auto` ends in `manual_pending` with the prompt and what would automate it. The daemon now mounts `/api/draw/*`.
- Recognition with DINOv2 retrieval (#11, #60): the sidecar writes `embeddings-dino.npy`, `embed.py protos` builds `dino-prototypes.f32` at ingestion, and the class suggestion fuses text + CLIP prototypes + DINOv2 prototypes:
  top-1 / top-3 on the 33 labelled carpet crops 0.52 / 0.79 -> 0.70 / 0.79 (0.82 / 0.93 on the 28 crops the library can name; leave-one-out 0.64 / 0.79 and 0.75 / 0.93); target 0.75 on 33 not reached (ceiling 0.85), see docs/tools.md.
- Invalid-zone stripes turn white where the invalid part itself is red (red screwdriver handles etc., #166): the colour is chosen per region from
  the GLB material colours (`stripeColour.ts`), the legend shows both swatches; photo overlay and PNG export inherit it. See
  [docs/invalid-zones.md](docs/invalid-zones.md#rendering).
- Tool physics (`packages/physics`, `massProperties` in `packages/tools`, [docs/physics.md](docs/physics.md), #167): tools have mass, centre of gravity
  and inertia from their generated geometry and material; `seatTool` lowers a tool into the real holder mesh so a shaft sits in
  its hole, a hammer head on the fork prongs and a ring on its peg (never on top of the holder); `analyseHangPose` judges a hang
  with Coulomb contacts and a bump/pull margin (levitating, penetrates, falls, tips, slides off, swings, needs retention,
  overloaded); `RemovalProbe` sweeps the extraction path with manifold-3d (free, needs tilt, needs two hands, blocked, clearance);
  `rankHolders` orders holder suggestions by fit, stability and removal convenience. Tools may overhang the board edge.
- Photo mode (#160): the white web gets a hairline outline and a shaded plate on bright walls (auto from the photo, or forced on/off); typed sizes on
  holders that come in fixed sizes snap to the nearest bank variant, say what was asked and what it became, and offer the neighbouring sizes as chips;
  "Find tools" draws the recognised tools as ghosts (outline, class, confidence) to accept - hung on a suggested holder - or discard; a grid-calibrated
  board moves in whole cells; the grid detector runs as `vision.calibrate`. `vision.photo_to_objects` accepts the sidecar's `needsViews` shape.
- Automatic background clean (#168): `photo.clean` job, cleaned photo variants (`Photo.cleanOf`), `fillWall` in `@hsw-editor/overlay`, the
  `wall_clean_background` omp tool, the "auto-clean background" setting, a before/after toggle and the `/api/draw/*` routes ([docs/api.md](docs/api.md)).
- Vision edit ops (#69): `POST /objects/merge|split|reprofile|add` on the sidecar and `hsw-editor vision objects ...` correct a finished `photo_to_objects` result without re-segmenting the
  photo; the tool import now starts the daemon's managed sidecar on demand (`GET /api/tools/vision` is available when it can be started) and `POST /api/tools/drafts/:id/add` adds an object the segmentation
  missed from a click or a box.
- Tools photos only add tools to the collection (#165): the Add-from-photo wizard says "add to collection", a scale reference is optional, and without one the sizes are the
  class-typical ones flagged `estimated` (one typed real length corrects a tool); `photo_to_objects` returns `profilePx` for unscaled photos; `vision.photo_to_wall` is documented as
  real-wall-only.
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
- Vision (`services/vision`, `apps/server/src/vision`, `hsw-editor vision ...`): photo -> wall proposal (`vision.photo_to_wall`) and photo -> per-object
  results (`vision.photo_to_objects`, `hsw_vision.objects.photo_to_objects`: masks, crops, upright crops, class top-k, fitted models in mm,
  per-part colours, CLIP embeddings); the heavy runtime is installed by `hsw-editor vision setup`. See `docs/vision.md`.
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
- Photo mode, backdrop (#30): after calibration the photo is the viewport backdrop and the HSW board (white web with the cells open to the wall), items and invalid-zone stripes are drawn over it by a camera recovered from the calibration (`photoCamera`); photo opacity, hide-photo, before/after divider, and move/turn the board over the photo (one undoable `setCalibration` per drag).

- Photo mode, editing on the photo (#30): the photo camera now projects the wall plane exactly through the calibration homography (no grid offset at the photo edges) and picks items correctly; dragging an item shows the snapped footprint (green fits, red does not) and ruler lines in mm to the board edges and nearest neighbours; typed dimensions are snapped to the parameter step, range and printer bed and the widget says what you asked for, what it became and why (`snapSize`); the agent `calibration` request accepts the `corners` mode; one calibration wizard per photo; `WallSync.resync` drops reads older than the session's wall.
- Finer bank tool classes `chisel`, `punch`, `hacksaw`, `level`, `square`, `long-nose-pliers`, `locking-pliers`,
  `water-pump-pliers`, `crimper`, `hex-key-set` with an optional `ToolClass.broader` (the coarser class). Holders of
  the coarse class still fit, suggest and filter for them (`compatibility`, bank tool filter, holder suggestion,
  `listElements({ fits })`, search, palette); an exact class match ranks above an equally fitting broader one.

- Photo mode, export and tools (#30): PNG export of the photo with the HSW overlay at the chosen opacity and a banner (like the reference picture, ru/en); a 'find tools' button that runs the vision job `vision.photo_to_objects` and says plainly when the vision service is not available; photo commands in the command palette (export PNG, find tools, calibrate, hide/show photo, before/after divider).

### Changed

- The UI state layer is a normal dependency now (#252): `@ultrabricks/state-lib` 0.1.0-pilot.1 is public (MIT) on the Forgejo npm registry and `bun install` fetches it (scope mapped in `bunfig.toml`, no credentials). `bun run setup:state-lib`, `vendor/state-lib`, the baseline store backend and `VITE_STATE_BACKEND` are gone, so CI, the Pages demo and the tests run the same backend as the app. Store subscribers are notified in a microtask (state-lib's delivery rule), and the settings link no longer writes back a remote value the store normalized.
- Removal analysis is 20-100x faster on dense racks (#196): boxes decide before the exact `minGap`/boolean, a gap is asked in growing steps (8 -> 60 mm), a tool cramped
  at rest is not measured along its way (it needs two hands anyway). The showcase wall: 54 s -> 3 s, a rack of three screwdrivers 26 s -> 0.3-0.6 s per tool, same verdicts. The rest gap and the clearance now look at everything within the 60 mm search distance (they only saw
  what lay in the sweep box before), so a tool with another one 25 mm below it has a clearance of 25 mm, not 60: its convenience (and so a holder's rating) can be a little lower.
- A tool hung on a holder may overhang the board edge without an `out_of_board` layout warning (its origin lies outside when a long tool or a can sits low).
- The showcase wall is laid out as the physics says it works (#196): the side-cutters (82 mm of open handles) have their own rack, the three screwdrivers are slim
  enough to leave room for fingers on the rail: 3 of 17 tools flagged after "Seat tools" (was 9).
- "Seat tools" says so when physics was switched off meanwhile and counts tools without a slot number apart; a tool resized a moment ago is seated after its model
  is rebuilt when it is dropped or hung (they wait for it, like the re-hang; "Seat tools" reports such a tool as not seated); the holder ratings are stored only for the model they were made for.
- Web: a tool dragged on the wall hangs on a suitable mount or, dropped elsewhere, snaps to a lattice cell as before (Alt = exact). Its box is
  drawn from the butt (origin) towards the tip, the frame the mounts use, so tools saved earlier appear shifted by half their length.
- `HSW_EDITOR_DATA_DIR` is now `HSW_EDITOR_HOME`.
- The built bank (`bank:ingest`) lives in `<data home>/bank`, the directory the daemon serves: `HSW_EDITOR_HOME`, else
  `$XDG_DATA_HOME/hsw-editor`. `bankPaths` no longer reads `HSW_EDITOR_DATA_DIR`; move a bank built under another directory
  or re-run `bun run bank:ingest`.

### Fixed

- Photo mode (#30): the two-point calibration readout also states the scale error of a 3 px click error in mm per metre (it showed only a percentage), and the before/after divider follows a dragging mouse instead of jumping between 0 and 1. An e2e test covers the wall-from-scratch flow across a daemon restart (#5).
- Adding tools from the command palette or the empty-wall menu no longer piles them at one point (#235): a preset hangs on the nearest free compatible holder, else lies on a clear spot of the board, exactly like a click on the Tools panel (`planToolAdd`), and a refusal is a toast.
- The Tools panel and photo mode work with the daemon stopped after one online visit (#219, [docs/offline.md](docs/offline.md)): the tool library reads (list, classes, per-tool JSON and
  holding) answered `Cache-Control: no-store`, which the service worker refuses to store, so the panel said "the tool library is unavailable" offline; they answer `no-cache` now and the worker keeps them
  network-first (the daemon's answer online, the kept copy only when it is unreachable, so the edit form never shows or saves a stale tool), with class and tool thumbnails and versioned library tool models. A page-side warmup stores the tool library and every file of the open wall
  (including the cleaned photo variants that only photo mode loads) on the first visit, which the worker cannot see because it does not control that visit yet.
- "Calibrate the photo" (palette) did nothing with the photo hidden (eye off in the Photos list). It now opens the calibrate view on the shown photo, or on the wall's first photo when none is shown, and so does the pencil of a photo row (photo mode is entered the usual way, clearing a stale "photo hidden"); Cancel on an already calibrated photo leaves it shown. The command is disabled (`hasPhoto`) when the wall has no photo (#215).
- `hsw-editor start|stop|restart|status` go through the systemd user unit while autostart is enabled for that port (#216), so no second pidfile daemon fights the unit for the port and `status` shows the unit's real state.
- The web build writes `apps/web/dist/.build-ok` only after a successful build; `scripts/install.sh` and `hsw-editor doctor` require it, so a failed or partial build is rebuilt or reported (#216; rebuild once after updating: `bun run build`).
- Add-from-photo wizard keeps typed sizes (#214): a width of 80 mm no longer comes back as 73, 100 mm length as 99.8; typed length and width are held exactly by a
  post-fit refinement of the class parameters, the wizard shows what you asked for, what the model has and why when a class cannot reach it, and sizes outside
  1-3000 mm (thickness 0.1-3000; 12086 mm for 120) in the wizard and the tool page are refused inline (ru/en) and by the API instead of being fitted.
- Click-to-add on a library tool (Tools panel +, detail page, `tools.add`) hangs the tool on the nearest free compatible holder, else puts it on a distinct clear spot inside the board; before, every tool landed on the viewport-centre ray's point (the same pose each time, the first one off the board) and none hung (#218). `tools.add` now reports why it added nothing (`noRoom`, `bankNotReady`, `libraryNotReady`, `unknownTool`, ...).
- The committed bank seed declares the current `TOOL_CLASSES` (it kept the 27 classes that predate the finer ones), so the
  palette, tool picker and bank filter on a seed-served bank offer chisel, punch, hacksaw, long-nose/locking/water-pump
  pliers, crimper and hex-key-set; `exportSeed` writes the vocabulary from `TOOL_CLASSES` instead of the built root (#156).
- `hsw-editor draw status|doctor|login|stop|settings|run` answered `invalid choice: 'draw'`: the verb was never registered in `cli/hsw_editor.py` (`cli/tests/test_draw_verb.py`).
- Commands engine edge cases (#79): empty-query recents are filtered by availability before the cut, so stale ids no longer crowd real ones out;
  a `repeat` command bound to a chord repeats while its last key is held, and holding a chord's first key past the timeout no longer restarts
  it; a later chord stroke bound to Escape completes the chord; a bad palette-usage entry no longer wipes the whole record; hidden commands are
  no longer AI-callable unless they set `aiHidden: false` (the per-setting commands do); `app_command` search queries are capped at 200
  characters; command arguments are parsed once per AI run; `SettingsStore` throws on an unknown id from every accessor, not just `get`.

## [0.1.0] - 2026-10-22

### Added

- Monorepo skeleton: Bun daemon, Vite/React web app shell, `packages/core`, `packages/bank`, vision sidecar, lifecycle CLI on
  the agent-tools service manager.
