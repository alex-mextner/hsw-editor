# Vision: photo of tools -> tool collection (and, separately, photo of a wall -> wall)

Two products share one pipeline, and they must not be mixed up:

- **A photo of tools** (on a carpet, floor or table, from any angle, any layout, a mixed or overlapping pile) only **recognises tools and adds them to
  the tool collection** (`packages/tools`, the Add-from-photo wizard). It never builds, fits or places a wall. `photo_to_objects` returns one record
  per object (mask, crops, class top-k, closed-form profile, fitted model when a scale is known, colours, embedding). A scale reference is optional:
  without one the sizes are class-typical and flagged as **estimated** (see "No scale"), and the user can type one real size per tool.
- **A photo of a real HSW wall** (the honeycomb board with tools hanging on it) becomes a **proposal**: tool items with fitted 3D models, dimensions
  and holder suggestions as a batch of `packages/core` ops that the UI or an agent confirms (`photo_to_wall`, job `vision.photo_to_wall`,
  `hsw-editor vision photo-to-wall`). It is only for photos of an existing wall; nothing on the tools-photo path calls it.

Fast, no AI by default.

```
wall photo ──► vision.photo_to_wall job (apps/server/src/vision)
                 │  Bun VisionClient ── loopback HTTP (127.0.0.1:8795) ──► services/vision  (FastAPI, uv, Python)
                 │                                                           │ ModelManager · cache · orchestrator
                 │                                                           ▼
                 │                                                  threed_vision  (3d-cli: packages/threed-vision)
                 ▼                                                  ALL algorithms live here
        proposal ops, model .glb in walls/<id>/models/, calibration op
```

## Single source of truth

- **Every algorithm lives in `alex-mextner/3d-cli`, package `packages/threed-vision` (`threed_vision`)**: grid calibration, SAM2/OWLv2
  segmentation, CLIP recognition, closed-form + soft-silhouette fitting, multi-view check, registration. The `3d <stage>` CLI commands
  and this service are two thin front ends over the same functions (tracked in 3d-cli #464-#467, hsw-editor #20).
- `services/vision` only **orchestrates**: HTTP, model residency (`ModelManager`), result cache, the photo -> proposal pipeline, ops.
  It never re-implements a stage. `pyproject.toml` pins the library:
  `threed-vision = { git = "https://github.com/alex-mextner/3d-cli", subdirectory = "packages/threed-vision", rev = "<commit>" }`.
  A library fix is a 3d-cli PR, then a `rev` bump here.
- Stages are independent pure modules (`hsw_vision/stages/{calibrate,segment,recognise,fit,multiview}.py`), JSON in / JSON out, each
  callable alone over HTTP or from the CLI.

## Install and run

```sh
hsw-editor vision setup             # venv + light locked deps + the heavy stack; idempotent, heavy parts run under flock + systemd-run
hsw-editor vision setup --cpu       # CPU torch + onnxruntime (~1 GB instead of ~8 GB of CUDA wheels)
hsw-editor vision fetch-models      # the only command that downloads weights (heavy wrapper built in)
hsw-editor vision doctor            # models present/missing, free VRAM, ORT CUDA state, heavy imports
hsw-editor vision status            # running? endpoint, resident engines, models on disk
hsw-editor vision photo-to-wall IMAGE --out DIR      # the whole wall pipeline WITHOUT the daemon (evidence runs)
hsw-editor vision photo-to-objects IMAGE --out DIR   # the objects pipeline WITHOUT the daemon
```

**Why `setup` and not a locked extra.** `services/vision/uv.lock` only locks the light dependencies (fastapi, uvicorn, numpy and the
`threed-vision` core deps: opencv, pillow, scipy), so CI (`uv sync --frozen`) stays fast and the review gate can stamp the lockfile
diff (a locked torch + CUDA extra was a 461 KB diff; the gate stops at 300 KB). The heavy runtime - `torch==2.11.0` and
`torchvision==0.26.0` from the **cu128** wheel index, `onnxruntime-gpu==1.23.2`, `sam2`, `transformers`, `tokenizers`, `cma`, `trimesh` -
is pinned in `cli/vision_verb.py` (`HEAVY_COMMON`, `HEAVY_ORT`, mirroring the `gpu`/`seg`/`fit` extras of `packages/threed-vision`) and
installed by `vision setup` with `uv pip install --index-url <torch index> --extra-index-url pypi --index-strategy unsafe-best-match`.
`setup` runs `uv sync --frozen --inexact --no-dev` first (`--inexact`: a re-sync never removes the heavy stack), asks the venv which pins
are already satisfied and skips the install when all are (`--force` reinstalls, `--dry-run` prints the commands). Never run a bare
`uv sync` in this venv expecting to keep torch: use `hsw-editor vision setup`.

The venv lives outside the repo (`UV_PROJECT_ENVIRONMENT`, default `~/.cache/hsw-editor/vision-venv`). The daemon spawns the sidecar
**lazily on the first `vision.*` job** with `uv run --no-sync --project services/vision python -m hsw_vision serve` (never an implicit
install: a missing venv is the structured error `vision_not_installed` naming `hsw-editor vision setup`) and **stops it after 10 idle
minutes** (`HttpVisionClient.idleStopMs`) so the GPU is free; the sidecar itself unloads idle models after 5 minutes.

### Where it listens

Default transport is **loopback TCP `127.0.0.1:8795`** (`HSW_VISION_PORT`; what `hsw-editor doctor` probes via `HSW_VISION_URL`). If the port is
taken the sidecar takes a free one and records it, with its pid, in the **state file** `~/.cache/hsw-editor/vision/state.json`
(`HSW_VISION_STATE`) - the Bun client and the CLI read it. `HSW_VISION_SOCKET=/path/vision.sock` serves a unix socket instead. Every request's
`Host` header must be loopback (`403 forbidden_host` otherwise: a loopback server is reachable from any local web page, the guard is the same
as the daemon's). `HSW_VISION_URL` points the client at an externally managed sidecar (it is then never spawned or stopped by us).

## Stage API (JSON)

All bodies are `application/json`; `image_path` is an absolute path on this machine, `work_dir` the result cache root (the daemon passes
`walls/<id>/vision/`, so a deleted wall deletes its cache; default `~/.cache/hsw-editor/vision`). Errors:
`{"error": {"code", "message", "fix?", "details?"}}` with the status below.

| Endpoint | In | Out |
| --- | --- | --- |
| `GET /health` | | `{ok, name, version}` (never loads models) |
| `GET /models/status` | | `{manager: {device, free_vram_mb, vram_budget_mb, resident_gpu_mb, engines{loaded, device, idle_s, ...}}, models: {models_dir, models{name: {installed, verified, files...}}}, gpu: {free_vram_mb, ort}}` |
| `POST /calibrate` | `{image_path, calibrate: {mode?, points_px?, distance_mm?, reference_instance?, reference_length_mm?, mm_per_px?, f_px?, f_ratio?}}` | calibration (below); `ok: false, needs: "scale"` when there is nothing to go on |
| `POST /segment` | `{image_path, segment: {method: sam2\|sam2-dense\|u2net, quality: fast\|accurate, fill: owlv2\|none, reject_bg, points_per_side}, include_masks?}` | `{instances: [{id, source, bbox_xywh, area_px, bg_prob, stability, polygon, mask}], method, device, timing_s, overlay, dir, imageDir, masks_png_base64?}` |
| `POST /recognise` | `{image_path, segment, instances?, bank_index?, categories?, topk?}` | `{classes, objects: {"<id>": {tool_class, label, score, prob, topk[], bank_topk[]}}}` |
| `POST /fit` | `{image_path, calibrate, segment, instance, fixed_dims?, template?, planar?, max_tries?, device?}` | `{instance, fit: {kind, params, dims_mm, pose, confidence, views, glb, ...}, dimensionsMm, confidence, residual, dimsFixed}` |
| `POST /multiview` | `{fit, views: [{mask \| mask_path, K, R, t, name?}], generated_views?: [{image_path, view \| azimuth_deg + elevation_deg, name?}], flag_below, generated_flag_below}` | `{mode, views: [{iou, flag, azimuth_deg, elevation_deg}], min_iou, status, needs_views[], sanity, confidence, threshold, request_view, generatedViews[], multiView}`; see "Multi-view check" |
| `POST /photo-to-wall` | see "Proposal request" | **NDJSON**: `stage`/`progress`/`object`/`request_view`/`needs_calibration` events, then one `result` (or `error`) line |
| `POST /photo-to-objects` | see "photo_to_objects" | the same NDJSON protocol; the final `result` is the `objects.json` content |

Status codes: `422 bad_request` / `calibration_needed`, `424 models_missing` (fix `hsw-editor vision fetch-models`, `details.missing`) /
`missing_dependency`, `503 insufficient_vram`, `403 forbidden_host`, `500 internal`.

### Calibration result

```json
{"ok": true, "method": "grid|two-point|reference|manual", "mm_per_px": 1.26, "plane_depth_mm": 1184, "f_px": 938, "f_source": "...",
 "camera": {"K": [[...]], "R": [[...]], "t_mm": [...]},       // world -> camera, OpenCV axes, mm; world = wall frame (x right, y up, z out)
 "homography_px_to_plane_mm": [9 numbers] | null,              // grid calibrations only
 "reproj_median_px": 0.44, "n_inliers": 283, "grid_origin": "min-inlier-cell",
 "core": {"method": "grid", "mmPerPx": 0.5, "homography": [...], "focalPx": 720.8, "reprojErrorPx": 0.44}}   // = packages/core Calibration
```

Order in `auto` mode: **honeycomb grid detector** -> the user's **two-point** scale (two photo pixels + their real distance) -> a **reference
object** of known length (a segmented instance; e.g. a recognised bank tool) -> plain `mm_per_px`. Without a grid there is no pose: the camera is
assumed to look straight down on the plane (carpet/desk photo), `f = 0.375 * diagonal` (the measured phone ratio) unless `f_px` is given.
The manual scale applies to **every** fit of the photo (one camera for all objects). No grid + no scale = `needs_calibration` (the job opens a
`calibration` input request; see Jobs).
A grid photo cannot tell where the board corner is: cell (0, 0) is the minimum inlier cell, so proposed poses are in that lattice frame;
`anchorMm` shifts them onto the board (gap: no UI yet to anchor).

### Fit result and confidence

`fit_auto` (library): closed-form profile first (ms), the soft-silhouette optimiser only when the reconstruction IoU is below `iou_accept`, CMA-ES
only when the held-out confidence is low. `fixed_dims` (`length`, `width`, `thickness`, mm) are **hard constraints**: the user's overrides win.

Confidence in [0, 1] has ONE implementation, `hsw_vision/confidence.py` (`fit_confidence`, `view_confidence`, `assess`), used by `/fit`,
`/multiview`, the wall proposal and `photo_to_objects`, so the same fit has the same number everywhere:

- a **held-out view** exists (another photo from a different viewpoint, `extraPhotoIds`): the **worst held-out silhouette IoU** is the confidence;
- several views, none held out: the worst training IoU;
- **one view**: the training IoU **capped at 0.6** (`single_view_confidence_cap`): the silhouette is reproduced but the unseen 3D shape is not
  verified (spike: single-view fits predict an unseen view with IoU 0.03-0.5; flat plates and boxes are ambiguous even with 3 views);
- NaN is 0, never 1;
- below `view_flag_iou` (default 0.75), or when the library flagged a checked view, the item is `needsView` and a **single `request_view`
  event per photo** lists the least confident items and the suggested azimuth/elevation of the missing views;
- an item below `min_confidence` (default 0.5) has status `needs_confirmation`.

### Multi-view check (ticket #13)

A fit is checked by rendering it into every OTHER available view and comparing silhouettes (`threed_vision.view_check`, the hard cv2 rasteriser, independent of the
soft one the fitter optimised). Three ways to get another view, one confidence rule:

- **A second photo** (`extra_photos` of `/photo-to-objects` and `/photo-to-wall`, `--extra-photo IMG` of the CLI, `extraPhotoIds` of the job): the library's
  register stage (SIFT + RANSAC, `threed_vision.register`) finds the camera move between the photos, each object's mask is warped into the other photo (the floor
  is the plane) and becomes a held-out `{mask, K, R, t}` view of that object. Photos from the SAME viewpoint (`baseline_ok: false`) repeat the silhouette and hold
  nothing out: they are reported in `diagnostics.extraPhotos` and the fit stays single-view. `/multiview` takes views directly (`mask` pixels or `mask_path`, an
  image whose alpha channel or grey > 127 is the mask).
- **No second photo**: the single-photo sanity mode renders the fit from canonical synthetic cameras (top, side, end, three-quarter) and tests for a degenerate
  silhouette, an implausible thickness for the template and an impossible top-view fill. Status `unverified`, never `ok`; the confidence stays capped at 0.6.
- **A drawn view** (`generated_views`, see [draw.md](draw.md)): an image on a white background with no camera. The fit is rendered from the named canonical direction
  (the convention of the draw prompt, where the photo's cut-out is the FRONT view: `front` = down the thickness axis, `back` = its mirror, `side` = the end along
  the length, `top` = the profile along the width; or an explicit azimuth/elevation in the object frame) and compared after normalising scale, position and
  in-plane rotation on a 640 x 160 canvas (so a part up to about 20:1 keeps its tips; best of the principal-axis flips; a round silhouette sweeps the angle). Every row is
  `source: "generated"`, flagged below `generated_flag_below` (0.7). **Drawn views never enter `min_iou`, the confidence or `needsView`**: they are hints for a human,
  because a generator keeps the shape only approximately (and cannot be told what the unseen side really looks like).

Result per object (`objects.json` `multiView`, also `/multiview`): `{mode: heldout|single_photo, status: ok|flagged|unverified, minIou, flagBelow,
views: [{source: "photo", name, iou, flag, azimuthDeg, elevationDeg}], generatedViews: [...], sanityOk, sanityFailed[]}` next to `confidence`, `needsView` and
`needsViews: [{azimuth_deg, elevation_deg, reason, priority, direction_object}]` (at most 3, in the object frame: azimuth in the length-width plane from +X toward
+Y, elevation toward +Z = the thickness axis, 90 = straight down; flat and boxy shapes never seen from above get a top-down suggestion first). The threshold is
`view_flag_iou` of the request / `HSW_VISION_VIEW_FLAG_IOU` (default 0.75); below it ONE `request_view` event per photo lists the least confident items and the union
of the suggested views (draw it, or ask for another photo).

**Measured on the carpet photo** (`tools-on-carpet-2026-10-21.heic`, 98 segments, 97 fitted, `mm_per_px` 1.263; the second photo is the same scene seen by a camera
moved 25 degrees about the world X axis, produced by the exact plane homography and registered back with 1970 matches / 1951 inliers, 0.13 px reprojection,
24.999 degrees recovered): with the second photo, **held-out IoU median 0.862** (min 0.335, max 0.970; lathe 52 objects median 0.850, flat 22: 0.878, box 23: 0.872),
15 of 97 objects ask for a view; without it all 97 are capped at 0.6 and ask. Registration took 2.4 s and the fit stage with the 97 held-out checks 1.0 s (the fits themselves came from the stage cache; CPU). The three objects below are recorded in `services/vision/tests/data/carpet-fit/` (18 KB, recorded by `tests/data/record_carpet_fit.py`) and
`tests/test_multiview_recorded_fit.py` asserts these numbers without a GPU:

| object | training IoU (1 photo) | held-out IoU, the fit | rotated 35 deg | 1.6x too big | half size | thickness x4 |
| --- | --- | --- | --- | --- | --- | --- |
| multimeter (lathe) | 0.936 | **0.912** | 0.571 | 0.372 | 0.289 | 0.449 |
| box | 0.953 | **0.921** | 0.556 | 0.377 | 0.260 | 0.647 |
| flat part | 0.971 | **0.970** | 0.482 | 0.389 | 0.264 | 0.908 (thin: a bad thickness hides) |

A good fit holds out at 0.91-0.97 and needs no view; every wrong one drops to 0.26-0.65, is flagged and gets `needsViews`. Drawn views, same three fits, ideal drawings
of the fit's own silhouette (turned 17 degrees, 0.8x, shifted): 0.99 in front, side and top view; the drawing of ANOTHER object: side 0.32-0.59, top 0.35-0.62,
but **front 0.88-0.89** - the outlines of two elongated tools seen face-on are alike, so a front drawing says little; the end and the profile discriminate (they
carry the thickness), which are the two views the draw request asks for by default. A drawing missing the last quarter of a 211 x 18 mm part scores < 0.9 against 0.99
for the whole one. Real generated drawings were not run (they need the user's ChatGPT/omp login); their scores are unmeasured (tracked in #185).

## Model cache, offline policy, VRAM

- Models are never downloaded at request time. Cache: `~/.cache/hsw-editor/models` (`THREED_VISION_MODELS_DIR`); files are sha256-verified by the library.
  A missing model is the structured error `models_missing` naming `hsw-editor vision fetch-models` (= `threed_vision.models.fetch`). Names:
  `sam2-tiny`, `owlv2-base`, `clip-b32`, `dinov2-s`, `u2net`.
- The fit optimiser is the manager's `fit` engine (~350 MB: its CUDA context), so it is budgeted like the models: LRU eviction, CPU when the card
  is full, `device=cuda` strict. An out-of-memory error moves the failing engine AND the shared CLIP/OWLv2 it requires to the CPU (nothing stays on
  the card that just ran out) and retries once; the retry's library errors are translated like the first attempt's.
- `ModelManager` (`hsw_vision/manager.py`): engines (the library's `load()/unload()` classes) are created and loaded **on first use**. A GPU load first
  makes room: while the service's resident GPU estimate + the new engine exceeds `HSW_VISION_VRAM_BUDGET_MB` (default 3000) or the card would be left
  with less than `HSW_VISION_VRAM_HEADROOM_MB` (400) free (other processes hold ~3 GB of the 8 GB), the **least recently used** unpinned engine is
  unloaded. If that is not enough the engine runs on the **CPU** (`HSW_VISION_DEVICE=auto`), or fails with `insufficient_vram` (`cuda`). An OOM
  while loading or running falls back to the CPU for that engine. CLIP and OWLv2 are shared residents between the segmenter and the recogniser
  (unloaded together with their dependents). Idle engines unload after `HSW_VISION_IDLE_UNLOAD_S` (300).
  The DINOv2 encoder (`dinov2-s`, extra recognition evidence) is a `cpu_only` engine with a zero VRAM estimate: it is placed on the CPU before any VRAM bookkeeping and never asks the GPU budget for room
  (a photo already uses 2950 of the 3000 MB). Missing weights or an old library are reported once as a `warning` event; the analysis goes on without `embedding.dino`.
- Results are cached by **image sha256 + stage + parameter hash (+ library version)** under `<work_dir>/<sha16>/`: re-running a stage with the same
  photo and parameters returns the stored result without a model. A cached result whose files vanished is recomputed. Two concurrent requests for
  one key compute once. Every segmentation run writes its masks into a NEW directory (`seg-<params>-<run id>`; the newest two are kept), so a
  refresh never rewrites masks another request is decoding; a refresh recomputes each stage once however many later stages need it. Recognise and
  fit results are keyed by the segmentation's directory AND content (ids, boxes, areas). The `vision.*` jobs add a
  job-level cache (`vision/jobs/`): the same photo + parameters return the stored proposal and do not store the model files twice.
- **CPU-only mode** (`HSW_VISION_DEVICE=cpu`): the same pipeline, slower (measured: segmentation 41 s warm with the default `fast` quality, soft fit ~5 s/object,
  3-view fit 13-17 s; the stock SAM2 generator needs 85-92 s there and is not used). `u2net` (`segment.method`) is the single-object fast path (0.4 s CPU) and is
  useless for multi-object photos. See [Segmentation speed](#segmentation-speed-quality-fast--accurate).

### onnxruntime-gpu pin

`onnxruntime-gpu==1.23.2` (the CUDA-12 build) is pinned: >= 1.24 is a **CUDA-13** build and silently runs on the CPU with this driver stack
(`libcublasLt.so.13` missing). torch/torchvision must come from the **cu128** index (`hsw-editor vision setup` installs them from it): their
`nvidia-*-cu12` wheels are what ORT loads (`threed_vision.device.setup_ort_cuda()`). `hsw-editor vision doctor` reports the ORT CUDA state and names
the missing `.so`.

## Proposal

`POST /photo-to-wall` request: `{image_path, work_dir, photo_id?, calibrate, segment, fixed_dims: {"<instance>": {length?, width?, thickness?}},
instances?, bank_index?, board?, anchor_mm?, auto_apply_confidence?, min_confidence?, view_flag_iou?, max_objects?, extra_photos?, device?, ai_assist?}`.

Result `proposal` (`hsw_vision/proposal.py`, plain JSON):

```json
{"version": 1, "photoId": "p-1", "autoApplyConfidence": null, "calibration": {<core Calibration>},
 "items": [{"id": "va1b2c3d-00", "modelId": "ma1b2c3d-00", "instanceId": 7, "label": "Screwdriver", "toolClass": "screwdriver",
            "confidence": 0.84, "status": "ok|needs_confirmation", "autoApply": false, "needsView": false,
            "dimensionsMm": {"length": 187.2, "width": 8.1, "thickness": 8.0}, "fit": {kind, method, device, timingS, confidence},
            "recognition": {toolClass, prob, topk, bankTopk}, "holders": [<suggestions>], "glb": "models/fit-007-<hash>.glb",
            "ops": [{"type": "addModelRef", "model": {...}}, {"type": "addItem", "item": {"kind": "tool", "modelRefId": ..., "toolClass": ...,
                     "pose": {x, y, z, rotZ}, "params": {length, width, thickness}, "source": {"type": "vision", "confidence": 0.84, "photoId": "p-1", "by": "hsw-vision"}}}]}],
 "holders": [{"id": "va1b2c3d-h00", "bankId": "...", "forItems": [...], "confidence": 0.7, "ops": [{"type": "addItem", "item": {"kind": "holder", "bankId": "...", "cell": {col, row}}}]}],
 "ops": [<all item ops in order>], "summary": {objects, recognised, needsConfirmation, needsViews, autoApply, holders}}
```

- **Nothing is applied by the pipeline.** `autoApplyConfidence` (default `null` = never) flags the items with `confidence >= it`, recognised, status `ok`, and not
  asking for a view as `autoApply`; the `vision.photo_to_wall` job then applies exactly those as one undoable batch (actor `{kind:"agent", name:"vision"}`).
  The rest stay proposals for the UI/agent to confirm (`wall apply`).
- Tool items carry the model ref (`addModelRef`, status `candidate`, `file` filled by the job after `addAsset` into `models/`) and the tool class (a bank tool-class id). The
  GLB is in the wall frame (mm, y up, z out), centred on the object, heading removed (`pose.rotZ` restores it).
- **Holder suggestions** use the bank's `fitsTool` hints (`/api/bank/index`): holders whose `fitsTool[toolClass].dims` ranges contain the measured
  `length/width/thickness` (`diameter`/`shaftDiameter` alias `width` for round tools), ranked by tightness then capacity; out-of-range holders of the right
  class are kept last (`inRange: false`). Tools sharing a best holder are grouped by its capacity into optional holder proposals (a grid cell when the photo
  is grid-calibrated). Holders are **never** parents of the tool items in the ops (no op sets `parentId` after creation).
- Recognition = CLIP text prompts over the bank's tool classes (calibrated: top-1 0.61 / top-3 0.79 on 33 hand-labelled crops, spike). `prob` is a softmax
  margin share, not a calibrated probability; below 0.3 the item gets no tool class and a generic label. Image -> bank-object retrieval only runs when a bank
  of tool thumbnails exists (the bank holds holders, not tool models; gap).

### Optional AI assist (off)

`config.ai_assist` (`HSW_VISION_AI_ASSIST=1`, default **off**) lets `AiAssist.refine` (adapter `OmpCliAssist`: `omp -p --no-tools --no-session`, crop attached)
look at an item **only if** the request asks (`ai_assist: true`) **or** its confidence is below `HSW_VISION_AI_ASSIST_CONFIDENCE` (0.5). Advisory: it may reclassify
or suggest dimensions (`recognition.ai`); it never changes the fitted geometry. With the default config nothing calls it (test: `tests/test_ai_assist.py`).

## photo_to_objects (library, no wall)

```python
from hsw_vision.objects import photo_to_objects

result = photo_to_objects(
    "tools.heic", "out/",                 # the result directory is the caller's: objects.json + files (paths in the JSON are relative to it)
    calibrate={"mm_per_px": 1.26},        # or {"points_px": [[x, y], [x, y]], "distance_mm": 240}, or {} (a honeycomb grid in the photo is found)
    categories="classes.json",            # optional: anything threed_vision.recognise.load_categories reads (JSON list of ToolClass objects, ...)
    extra_photos=["other-angle.jpg"],     # optional: other viewpoints = held-out views of every fit
    fixed_dims={"7": {"length": 160}},    # optional: user dimensions (hard constraints), per instance id
    colours=True, inline_embeddings=False, topk=5, max_objects=60, min_area_px=600, device=None, seed=0,
    work_dir=None,                        # stage-result cache root; default HSW_VISION_CACHE (~/.cache/hsw-editor/vision)
    service=None,                         # pass a long-lived VisionService to keep models resident between photos
)
```

`photo_to_objects(image_path, out_dir=None, *, service=None, emit=..., cancel=..., **PhotoToObjectsRequest fields)` (`hsw_vision/objects.py`)
raises `VisionServiceError` subclasses (`bad_request`, `models_missing`, `missing_dependency`, ...). Server job `vision.photo_to_objects`,
`POST /photo-to-objects` (NDJSON, same events as `photo-to-wall`) and `hsw-editor vision photo-to-objects IMAGE --out DIR` are the same function.

Pipeline: calibrate -> segment (SAM2 + OWLv2 fill) -> select plausible objects -> recognise (CLIP text, calibrated) -> fit (`fit_auto`) +
multi-view check -> per object: closed-form axis/profile, crops, upright crops, per-part colours, CLIP embedding. **No scale is not an
error**: without a grid, two-point, reference or `mm_per_px` the result has `status: "no_scale"`, every `fit`/`profile`/`dimensionsMm` is `null`, and
masks, crops, axis, class, colours and embeddings are still produced; run again with `calibrate` (segmentation and recognition come from the cache).

### No scale: estimated sizes (tools photos from any angle)

A tools photo needs no scale reference, and it needs no top-down view: the silhouette profile of each object is measured in the photo plane and does not
depend on a camera model. Without a scale, each record carries `profilePx` (the same closed-form profile, its `*_mm` fields hold **pixels**; `profile`
stays `null`). The collection import (`packages/tools`, `typicalLengthMm`) turns it into millimetres in one of two ways, and says which:

- the user typed one real length for that tool (a ruler, the manufacturer's size): the profile is scaled to it (`dimensions.source: "user"`);
- otherwise the **class-typical length** (the class built with its default parameters) of the chosen, or best suggested, class scales it, and the object is
  flagged `dimensionsEstimated: true` (`dimensions.source: "estimated"` on the saved tool; the wizard shows "estimated size"). Changing the class
  re-estimates; typing a length replaces the estimate.

An object with no class and no typed length has no honest size: it stays `needsScale` and is not fitted. Perspective is the limit of the **scaled**
path: with a `mm_per_px` or two points the fit assumes a camera looking straight down on the plane (`f = 0.375 * diagonal`), so an oblique photo with a
single scale number is only as good as that assumption; the estimated path does not rely on it, and typing one real size per tool corrects either.

Result (`<out>/objects.json`, also the return value):

```json
{"version": 1, "status": "ok|no_scale", "needs": "scale (only without a scale)",
 "image": {"path": "...", "sha256": "...", "w": 4032, "h": 3024},
 "outDir": "/abs/out",
 "calibration": {<calibrate-stage result: ok, method, mm_per_px, plane_depth_mm, camera{K,R,t_mm}, core{...}>},
 "summary": {"found": 91, "analysed": 60, "recognised": 41, "fitted": 60, "failed": 0, "needsViews": 55, "needsConfirmation": 3},
 "segmentation": {"method": "sam2", "device": "cuda", "digest": "ab12cd34ef56", "instances": 91},
 "overlay": {"segmentation": "overlay.jpg", "fit": "fit-overlay.jpg|null"},
 "objects": [{
   "id": 7,                                       // segmentation instance id (stable for a given segmentation)
   "bboxXywh": [x, y, w, h], "areaPx": 5231, "polygon": [[x, y], ...], "bgProb": 0.02,
   "mask": "masks/007.png",                       // full-photo size, 0/255 PNG
   "crop": {"path": "crops/007.png", "boxXywh": [x, y, w, h]},   // RGB, bbox + crop_pad, photo background kept
   "cutout": "cutouts/007.png",                   // RGBA of the same window, alpha = mask
   "cropOriented": "crops_oriented/007.png",      // RGB rotated so the principal axis is horizontal, wide end on the LEFT
   "cutoutOriented": "cutouts_oriented/007.png",  // RGBA of the same
   "axis": {"deg": 12.4, "unit": [x, y], "centerPx": [x, y]},    // principal axis in photo pixels (y down), wide end first
   "profile": {"kind": "lathe_profile", "length_mm": 187.0, "max_width_mm": 21.0, "rect_mm": [..], "elongation": 8.9, "solidity": .., "rect_fill": ..,
               "lateral_offset_mm": 0.1, "stations": [{"t": 0.0, "lo_mm": -9.8, "hi_mm": 10.2}, ... 12 of them], "iou_recon": 0.93} | null,
   "mmPerPx": 1.263,                              // null without a scale
   "class": {"toolClass": "screwdriver" | null,   // null when prob < 0.3 (same rule as the wall proposal)
             "label": "screwdriver", "score": 27.9, "prob": 0.81, "calibrated": true,
             "topk": [{"toolClass": "screwdriver", "label": "screwdriver", "score": 27.9}, ...], "bankTopk": []},
   "fit": {<library fit.json: kind, template, params{L_mm, c_mm[], w_mm[], aspect}, dims_mm, pose{R0, t_mm, axis}, views, confidence, method, device, timing_s, ...>,
           "glb": "models/007.glb", "glbPose": {heading_deg, x, y, z}, "centreMm": [x, y], "dimsFixed": null} | null,
   "dimensionsMm": {"length": 187.2, "width": 21.0, "thickness": 21.0} | null,
   "colours": {"parts": [{"t0": 0.0, "t1": 0.5, "colour_srgb": [r, g, b], "hex": "#c83c3c", "lab": [..], "area_frac": .., "n_pixels": .., "role_guess": ".."}, ...],
               "palette": [{"colour_srgb": .., "hex": .., "lab": .., "area_frac": ..}], "axis_deg": 12.4} | null,
   "embedding": {"file": "embeddings.npy", "row": 0, "dim": 512, "model": "clip-b32", "vector": [512 floats, only with inline_embeddings],
                  "dino": {"file": "embeddings-dino.npy", "row": 0, "dim": 768, "model": "dinov2-s"}},   // dino: only when the dinov2-s model is installed
   "confidence": 0.6, "needsView": true, "needsViews": [{"azimuth_deg": 60, "elevation_deg": 30}],
   "multiView": {"mode": "single_photo|heldout", "status": "unverified|ok|flagged", "minIou": null, "flagBelow": 0.75, "views": [], "generatedViews": [], "sanityOk": true, "sanityFailed": []} | null,
   "status": "ok|needs_confirmation|no_scale|fit_failed", "error": null,
   "needs": "scale (only without a scale)"}],
 "events": [], "diagnostics": {"timing_s": {open, calibrate, segment, recognise, fit, export, total}, "skipped": {...}, "failures": [...], "colours": {...}, "cache": {...}, "models": {...}}}
```

- Files under `outDir`: `objects.json`, `masks/NNN.png`, `crops/NNN.png`, `cutouts/NNN.png`, `crops_oriented/NNN.png`, `cutouts_oriented/NNN.png`,
  `models/NNN.glb` (fit mesh, object frame: X along the length), `embeddings.npy` (N x 512 float32, L2-normalised, rows in `objects` order), `overlay.jpg`,
  `fit-overlay.jpg` (every fitted model drawn on the photo through the photo's camera: green = mask, red = model). Existing files are overwritten, others
  are left alone: use a dedicated directory.
- `colours` comes from `threed_vision.appearance.sample_part_colours` (3d-cli PR #493). While the pinned library lacks it the field is `null` and
  `diagnostics.colours.available` is `false` with the reason: nothing is substituted. `t` runs 0..1 along the length from the wider end (the `axis` convention).
- `embedding` is the recogniser's own crop (`threed_vision.clip.crop_masked`) through the resident CLIP-B/32 image encoder, so it lives in the same space as the
  text scores in `class.topk` and the bank retrieval. `python -m hsw_vision embed IMAGE... --out DIR [--object]` writes the same kind of rows for whole images (or
  their single u2net object) into `embeddings.npy` + `embeddings.json` (`items[{image, sha256, row, object, size}]`).
- `categories` replaces the bank-index classes: the text scores are over exactly those classes (a caller fusing them with its own class prototypes passes its own list).
- `confidence`/`needsView(s)`: the single policy above. `status`: `ok` (confidence >= `min_confidence`), `needs_confirmation`, `no_scale`, `fit_failed` (recorded in
  `diagnostics.failures`; when every fit fails the call raises instead of returning an empty list).

## Segmentation speed (quality fast / accurate)

`segment.quality` (`fast` default, `accurate`) picks the SAM2 pipeline of `threed_vision.segment.Segmenter` (3d-cli `docs/commands/segment.md` has the full measurements and the
variants that did not help). `fast` filters the SAM2 grid masks on the decoder's 256x256 logits with a resident fp16 decoder and only prompts grid points near an object (OWLv2
objectness), `accurate` is the stock automatic mask generator. `method: u2net` stays the single-object path (0.05 s GPU / 0.5 s CPU) and ignores `quality`.

Measured on the 2000x1500 carpet photo (RTX 4060 8 GB shared with other processes, load average 4-7, models resident; `threed-vision` e672ca7, 3d-cli #543). "library" is `Segmenter.run`,
"`/segment` stage" the whole `stages.segment.segment` call the service makes (library run + mask PNGs + polygons + overlay):

| path | cold (library, models built in the call) | warm, library | warm, `/segment` stage | instances | 33 labelled crops found (bbox IoU 0.5) | masks of `accurate` GPU reproduced (IoU 0.7) |
|---|---|---|---|---|---|---|
| GPU `accurate` (the former default) | 11.5 s | 5.7 s | 7.0-7.2 s (8.3 s before the faster PNG writing) | 98 | 33/33 (the labels come from this run) | 100 % |
| **GPU `fast` (default)** | 2.2-7.6 s | **1.6-1.9 s** | **2.4 s** | 91 | 30/33 | 89 % |
| CPU, former default (boxes only on a 1024 px copy) | 11.5 s | 9.0 s | - | 65 | 13/33 | 41 % |
| **CPU `fast` (default), full resolution** | 50 s | **38.7 s** | - | 93 | 30/33 | 89 % |

The ticket's budget (< 3 s per photo) holds on the GPU only: the CPU default takes 39 s (3d-cli #545 tracks the decoder-bound part), and the cold first request pays 3-9 s more for building the models.

The three crops `fast` does not match (two pliers, one tape roll) are objects it returns whole where the label marks a part. `fast` drops the carpet patches the stock generator keeps,
and finds neither the adjustable wrench nor the hammer head (3d-cli #479). The sidecar's cached results are keyed by the parameters, so `fast` and `accurate` results of one photo coexist.

**Switch.** The user's choice is the `vision.segmentQuality` setting (`fast` | `accurate`, group "Advanced" of the settings palette, ru/en). The daemon reads it from the `settings` namespace of
`<home>/settings.json` and adds it to the `segment` parameters of every stage request that does not name a `quality` itself (`HttpVisionClient`, `segmentQuality` option; the tool import and the
`vision.*` jobs go through it; the click/box edit routes run no automatic segmentation). An explicit `segment.quality` in a job input or request wins; with no setting the sidecar default (`fast`) applies. CLI:
`python -m hsw_vision photo-to-wall|photo-to-objects ... --quality fast|accurate`.

**Timing regression.** `services/vision/tests/test_segment_real_photo.py` (`real_photo`, opt-in with `HSW_VISION_REAL_TIMING=1`, needs the private photo, the models and a free GPU) fails when the
warm default segmentation stage of the carpet photo takes 3 s or more or finds fewer than 80 instances. Run it under the heavy-run wrapper:

```bash
cd services/vision && HSW_VISION_REAL_TIMING=1 flock /tmp/3d-cli-heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 \
  -p CPUQuota=600% nice -n 10 uv run pytest tests/test_segment_real_photo.py -q
```

## Editing a result: merge, split, reprofile, add

The review grid of the tool import corrects the segmentation without re-running SAM2 on the whole photo (1.7 s GPU with the default `fast` quality, 41 s CPU).
Each op works on a finished `photo_to_objects` directory (`objects.json` + files), analyses only the objects it creates or re-fits
with the functions the run used (recognise, fit, crops, colours, embedding), takes the scale and the class vocabulary the run stored
in `objects.json` (`request`), rewrites `objects.json` atomically and returns the full updated record(s). One op at a time per
directory. A source object is never deleted: it stays with `status: "merged" | "split"` and `mergedInto` / `splitInto`; new ids are
`max(id) + 1`; `summary` counts live objects only; `edits` in `objects.json` logs the ops. A result written before the ops existed
has no `request` and is refused (`bad_request`: run `photo-to-objects` again); so is a result whose photo changed. The CLI and the daemon's sidecar
serialise on `<out>/.edit.lock` (`flock`). The stored request keeps the class vocabulary but not the bank index, so new objects of an edit have no
`bankTopk` (the bank holds holders, not tool thumbnails, so there is nothing to retrieve yet).

| Route | In | Out |
| --- | --- | --- |
| `POST /objects/merge` | `{out_dir, ids: [2..20]}` | `{object, sources[], summary}`: the union of the masks, `source: "merged"` |
| `POST /objects/split` | `{out_dir, id, line_px: [[x,y],[x,y]]}` or `{out_dir, id, n: 2..8}` | `{objects[], source, summary}`: by the two sides of a line, or `n` parts that follow the object's necks (k-means seeds + watershed on the distance transform; the parts tile the mask exactly; each part >= 150 px or `bad_request`) |
| `POST /objects/reprofile` | `{out_dir, ids?, fixed_dims?: {"<id>": {length?, width?, thickness?} \| null}, calibrate?}` | `{objects[], calibration, status, summary}`: re-fit in place; class and embedding are kept. `fixed_dims` accumulate per object (`null` clears). A new `calibrate` (manual: `mm_per_px` or two points) re-fits every live object and turns a `no_scale` result into `ok`; without any scale: `calibration_needed` |
| `POST /objects/add` | `{out_dir, point_px: [x,y]}` or `{out_dir, box_xywh: [x,y,w,h]}` | `{object, summary}`: one SAM2 prompt (no OWLv2 fill, no background rejection), `source: "click"`; a mask under 150 px is `bad_request` |

CLI: `hsw-editor vision objects merge|split|reprofile|add OUT_DIR ...` prints the reply JSON. Server: `POST /api/tools/drafts/:id/merge|split|add`
(docs/api.md) call these through the daemon's managed sidecar client.

Measured on the carpet photo (RTX 4060 shared, warm service): merge 3.6 s, split 5.7 s, add by click 2.9 s, reprofile one object 1.2 s,
against 109 s for the segmentation alone in the same run.

## Jobs (server)

`apps/server/src/vision/jobs.ts` registers, on Core's job runner: `vision.photo_to_wall`, and the stage jobs `vision.calibrate`, `vision.segment`, `vision.fit`.
Inputs are zod-validated (`PhotoToWallInputSchema` ...): `{wallId, photoId, calibrate?, segment?, fixedDims?, instances?, autoApplyConfidence?, minConfidence?,
viewFlagIou?, maxObjects?, extraPhotoIds?, anchorMm?, aiAssist?, applyCalibration, askUser, refresh}`.

- Progress goes through `ctx.progress` (SSE is Core's): stage messages, `object` done/total, a `request_view` as a progress `data` payload
  (`{type: "request_view", reason, items: [{itemId, confidence, suggested}], suggested: [{azimuth_deg, elevation_deg}]}`), also in `result.events`. Core has no
  `request_view` input-request kind, so it is **not** an `askUser`; the UI/agent decides (draw backend or ask for another photo).
- No scale: the job opens a `calibration` input request (`payload {photoId, mode: "two-point"}`) with `ctx.walls.askUser`. The widget answers
  `{pointsPx: [[x,y],[x,y]], distanceMm}` or `{mmPerPx}`; the job re-runs with it. A cancelled request ends as `status: "needs_calibration"` (not a failure).
- The photo calibration is applied (`setCalibration`) when it differs from the photo's current one (`applyCalibration: false` to skip).
  A photo that carries a user scale (`two-point` / `manual`) hands it to its later jobs (`photo_to_wall`, `fit`, `photo_to_objects` on a wall photo) when the request has no `calibrate`, so the scale is applied to all fits without asking again.
- Result: `{status, calibration, calibrationApplied, proposal, applied: {rev, itemIds} | null, events, diagnostics, segmentation}` with per-stage timings,
  skipped counts, cache hits and model residency in `diagnostics`.
- Stored files: the fitted `.glb`s (and the `vision.segment` overlay) are wall assets written before anything is applied, so a proposal is self-contained.
  Content is stored once (`<wall>/vision/assets.json` maps the SHA-256 of the bytes to the stored file): a re-run that produces the same model reuses its file
  instead of adding another. Files a caller was already told about are never deleted by a later run; a failed apply removes only the files that run created.
- No scale after the third attempt ends as `needs_calibration` (the last attempt does not ask a question whose answer would be thrown away).
- Recognition classes and holder hints come from the bank index the daemon serves (`GET /api/bank/index`, user elements included; read in-process from the same bank handler).
- `GET /api/vision/status` (never starts the sidecar) and `POST /api/vision/stop` (module `routes.ts`). A stop while a job runs fails that job with `vision_stopped`
  (re-run it: the next request starts a new sidecar); a stop that arrives while the sidecar is still starting prevents the spawn; a sidecar that no longer answers is killed before a new one is spawned.

## CLI

`hsw-editor vision setup|status|fetch-models [NAME...]|doctor|photo-to-wall IMAGE --out DIR|photo-to-objects IMAGE --out DIR` wrap `python -m hsw_vision` in the vision venv
(`setup` creates it, see Install). `photo-to-wall` runs the pipeline in-process (no daemon) and writes `proposal.json`, `result.json`, `timings.json`, `overlay.jpg` to `--out`;
`photo-to-objects` writes the result directory above (`--out` is also its stage cache: `<out>/cache`; without `--out` the server job writes `<image cache>/objects/<run id>`, one directory per distinct set of parameters, the newest 8 per photo kept). Exit 0 ok, 2 bad input / no scale (`--two-point X1,Y1,X2,Y2 --distance MM`
or `--mm-per-px`), 127 missing model/dependency (names the fix). Options: `--device cpu|cuda|auto`, `--method sam2|sam2-dense|u2net`, `--max-objects`, `--refresh`, `--json`;
`photo-to-objects` also `--categories FILE`, `--topk N`, `--no-colours`, `--extra-photo IMG` (repeatable). `python -m hsw_vision embed IMAGE... --out DIR [--object]` writes CLIP embeddings.

## Remaining gaps

See the per-issue status in the PR description. Known: the default segmentation takes ~39 s on the CPU (3d-cli #545); flat/boxy multi-view fits are ambiguous (the check flags them); no UI for
mask delete, scale widget, anchor, or the request_view flow in the wizard (web app, #9/#10 UI criteria; the draw call path is `POST /api/tools/drafts/:id/objects/:key/draw-view`, docs/draw.md); no tool-model bank for image retrieval; the
embedding index for retrieval is not built at ingestion; OWLv2 as a separate user-facing detector endpoint is not exposed (it runs inside the segmenter fill).
