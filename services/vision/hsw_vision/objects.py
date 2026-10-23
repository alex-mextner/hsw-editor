"""photo -> OBJECTS: the pipeline as a library, with no wall involved.

    from hsw_vision.objects import photo_to_objects
    result = photo_to_objects("tools.heic", "out/", calibrate={"mm_per_px": 1.26})

segment -> per-object crops -> recognise -> fit (mm) -> per-part colours. One record per object (schema: docs/vision.md,
"photo_to_objects result"): `mask`, `crop`, `cutout`, the upright `cropOriented`/`cutoutOriented`, `axis` + closed-form
`profile` (mm), `class` (top-k + confidence), the fitted `fit` (library `fit.json` params + `dimensionsMm` + a GLB),
`colours`, CLIP `embedding`, `confidence`, `needsViews`. Everything is written under `out_dir`
(`objects.json` is the result; paths inside it are relative to `out_dir`), so a caller owns the result directory.

No scale (no grid, no two-point/reference/`mm_per_px`) is not an error here: masks, crops, classes and colours do not need
one. The records then have `fit: null` and the result `status: "no_scale"`; pass `calibrate` and run again (the
segmentation and recognition come from the cache) to get dimensions.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from hsw_vision.analysis import (
    Fitted,
    StageClock,
    crop_box,
    fit_objects,
    load_extra_photos,
    safe_status,
    select_instances,
    write_crop,
)
from hsw_vision.cache import params_hash
from hsw_vision.config import VisionConfig
from hsw_vision.files import copy_file, save_npy, write_json, write_png
from hsw_vision.geometry import camera_from_calibration
from hsw_vision.proposal import MIN_RECOGNITION_PROB, dimensions_mm
from hsw_vision.schemas import PhotoToObjectsRequest
from hsw_vision.service import Emit, Image, VisionService, _noop, library_version, segmentation_digest
from hsw_vision.stages import embed as stage_embed
from hsw_vision.stages import shape as stage_shape

RESULT_VERSION = 1
STATUS_OK = "ok"
STATUS_NEEDS_CONFIRMATION = "needs_confirmation"
STATUS_NO_SCALE = "no_scale"
STATUS_FIT_FAILED = "fit_failed"
EMBEDDINGS_FILE = "embeddings.npy"
RUN_ID = re.compile(r"[0-9a-f]{12}")
#: Run directories (`<image cache>/objects/<run id>`) kept per photo when the caller did not choose an `out_dir`.
DEFAULT_RUNS_KEPT = 8
#: A run directory younger than this is never pruned: its files (masks/, crops/, ...) do not move the directory's mtime.
DEFAULT_RUN_MIN_AGE_S = 3600.0


def photo_to_objects(
    image_path: str | Path,
    out_dir: str | Path | None = None,
    *,
    service: VisionService | None = None,
    emit: Emit = _noop,
    cancel: threading.Event | None = None,
    **options: Any,
) -> dict[str, Any]:
    """Run the pipeline on one photo and return the result (also written to `<out_dir>/objects.json`).

    `options` are the `PhotoToObjectsRequest` fields: `calibrate={...}` (scale: `mm_per_px`, `points_px`+`distance_mm`,
    reference instance; a honeycomb grid in the photo is found automatically), `segment={...}`, `instances=[ids]`,
    `fixed_dims={"<id>": {"length": 160}}`, `bank_index`, `max_objects`, `min_area_px`, `topk`, `crop_pad`, `colours`,
    `extra_photos=[...]` (other viewpoints: held-out views), `device`, `seed`, `work_dir` (stage-result cache root).
    `service` defaults to one built from the environment (`HSW_VISION_*`); long-lived callers pass their own so models
    stay resident between photos. Raises `VisionServiceError` subclasses (`bad_request`, `models_missing`, ...).
    """
    request = PhotoToObjectsRequest(image_path=Path(image_path), out_dir=Path(out_dir) if out_dir else None, **options)
    return run(service or VisionService.create(VisionConfig.from_env()), request, emit, cancel)


def default_out_dir(img: Image, req: PhotoToObjectsRequest) -> Path:
    """`<image cache>/objects/<run id>`: one directory per distinct request on this photo, so two runs with other
    parameters (or at the same time) never overwrite each other's masks, crops and `objects.json`."""
    options = req.model_dump(mode="json", exclude=req.TRANSPORT_FIELDS)
    return img.dir / "objects" / params_hash(options, version=library_version())[:12]


def _modified(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except FileNotFoundError:  # another run pruned it meanwhile
        return 0.0


def _prune_default_runs(current: Path, keep: int) -> None:
    """Keep the `keep` newest run directories next to `current` (which always stays and counts): they hold masks, crops
    and models. Only `<run id>` directories are touched; the run that is starting is marked as the newest first."""
    os.utime(current)
    runs = sorted((p for p in current.parent.iterdir() if RUN_ID.fullmatch(p.name) and p != current), key=_modified, reverse=True)
    now = time.time()
    for stale in runs[max(keep, 1) - 1 :]:
        if now - _modified(stale) >= DEFAULT_RUN_MIN_AGE_S:  # a run still writing its files is not "stale"
            shutil.rmtree(stale, ignore_errors=True)


def run(
    service: VisionService,
    req: PhotoToObjectsRequest,
    emit: Emit = _noop,
    cancel: threading.Event | None = None,
    img: Image | None = None,
) -> dict[str, Any]:
    config = service.config
    clock = StageClock(emit, cancel)
    extras = load_extra_photos(service, req)  # cheap validation before any heavy stage
    img = img or service.open(req)
    out_dir = (req.out_dir or default_out_dir(img, req)).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if req.out_dir is None:
        _prune_default_runs(out_dir, DEFAULT_RUNS_KEPT)
    emit({"event": "stage", "stage": "open", "state": "done", "image": {"w": img.size[0], "h": img.size[1]}})

    clock.start("calibrate")
    calibration = service.calibrate(img, req.calibrate, req.segment, emit, cancel)
    scaled = bool(calibration.get("ok"))
    clock.done("calibrate", ok=scaled, method=calibration.get("method"))
    if not scaled:
        emit({"event": "needs_calibration", "mode": "two-point", "message": calibration.get("message")})
    clock.check_cancel("photo-to-objects")

    clock.start("segment")
    segmentation = service.segment(img, req.segment, emit, cancel)
    objects_in, skipped = select_instances(segmentation, req)
    clock.done("segment", instances=len(segmentation["instances"]), selected=len(objects_in))
    clock.check_cancel("photo-to-objects")

    clock.start("recognise")
    recognition = service.recognise(img, segmentation, [i["id"] for i in objects_in], req.bank_index, req.topk, req.categories)
    clock.done("recognise")
    clock.check_cancel("photo-to-objects")

    fitted = (
        fit_objects(service, req, img, calibration, segmentation, objects_in, recognition, extras, clock, raise_when_all_fail=False)
        if scaled
        else Fitted()
    )
    by_id = {obj["instance_id"]: obj for obj in fitted.items}
    failed = {f["instanceId"]: f["error"] for f in fitted.failures}

    colours_on = req.colours and service.stages.colours_available()
    mm_per_px = float(calibration["mm_per_px"]) if scaled else None
    min_conf = req.min_confidence if req.min_confidence is not None else config.min_confidence
    clock.start("export", total=len(objects_in))
    masks = service.masks(img, segmentation, only=[i["id"] for i in objects_in])
    with service.run_lock:
        embeddings = service.stages.embed_objects(service.manager, img.rgb, [masks[i["id"]] for i in objects_in])
    if len(embeddings):
        save_npy(out_dir / EMBEDDINGS_FILE, embeddings)
    records: list[dict[str, Any]] = []
    for row, inst in enumerate(objects_in):
        clock.check_cancel("export")
        obj = by_id.get(inst["id"])
        records.append(
            _record(
                service, req, img, segmentation, out_dir, inst, masks[inst["id"]], recognition, obj, failed.get(inst["id"]),
                scaled, colours_on, min_conf, mm_per_px, embeddings[row] if len(embeddings) else None, row,
            )
        )
    overlay = _write_overlays(service, img, segmentation, out_dir, objects_in, masks, by_id, calibration if scaled else None)
    clock.done("export", objects=len(records))

    result: dict[str, Any] = {
        "version": RESULT_VERSION,
        "status": STATUS_OK if scaled else STATUS_NO_SCALE,
        "image": {"path": str(img.path), "sha256": img.sha256, "w": img.size[0], "h": img.size[1]},
        "outDir": str(out_dir),
        "calibration": calibration,
        "objects": records,
        "summary": {
            "found": len(segmentation["instances"]),
            "analysed": len(records),
            "recognised": sum(1 for r in records if r["class"]["toolClass"]),
            "fitted": sum(1 for r in records if r["fit"] is not None),
            "failed": sum(1 for r in records if r["status"] == STATUS_FIT_FAILED),
            "needsViews": sum(1 for r in records if r["needsView"]),
            "needsConfirmation": sum(1 for r in records if r["status"] == STATUS_NEEDS_CONFIRMATION),
        },
        "segmentation": {
            "method": segmentation.get("method"),
            "device": segmentation.get("device"),
            "digest": segmentation_digest(segmentation),
            "instances": len(segmentation["instances"]),
        },
        "overlay": overlay,
        "diagnostics": {
            "timing_s": clock.total(),
            "skipped": skipped,
            "failures": fitted.failures,
            "extraPhotos": [{k: v for k, v in r.items() if k != "views"} for r in fitted.registrations],
            "cache": {"segment": segmentation.get("cached"), "calibrate": calibration.get("cached")},
            "colours": _colours_note(req, colours_on),
            "device": config.device,
            "models": safe_status(service),
        },
    }
    if not scaled:
        result["needs"] = "scale"
        result["message"] = calibration.get("message")
    write_json(out_dir / "objects.json", result)
    return result


def _colours_note(req: PhotoToObjectsRequest, on: bool) -> dict[str, Any]:
    if not req.colours:
        return {"enabled": False}
    if on:
        return {"enabled": True, "available": True}
    return {
        "enabled": True,
        "available": False,
        "reason": "the installed threed_vision has no `appearance` module (3d-cli feat/vision-appearance); `colours` is null",
    }


def _record(
    service: VisionService,
    req: PhotoToObjectsRequest,
    img: Image,
    segmentation: dict[str, Any],
    out_dir: Path,
    inst: dict[str, Any],
    mask: np.ndarray,
    recognition: dict[str, Any],
    obj: dict[str, Any] | None,
    error: str | None,
    scaled: bool,
    colours_on: bool,
    min_conf: float,
    mm_per_px: float | None,
    embedding: np.ndarray | None,
    row: int,
) -> dict[str, Any]:
    ident = f"{int(inst['id']):03d}"
    mask_rel = f"masks/{ident}.png"
    copy_file(img.dir / segmentation["dir"] / inst["mask"], out_dir / mask_rel)
    crop_rel = f"crops/{ident}.png"
    write_crop(img, inst, req.crop_pad, out_dir / crop_rel)
    cutout_rel = f"cutouts/{ident}.png"
    box = crop_box(inst, img.size, req.crop_pad)
    _write_cutout(img.rgb, mask, box, out_dir / cutout_rel)

    axis, profile = service.stages.axis_and_profile(mask, mm_per_px)
    upright, upright_cutout, _ = stage_shape.upright_crops(img.rgb, mask, axis["deg"], req.crop_pad)
    write_png(out_dir / f"crops_oriented/{ident}.png", upright)
    write_png(out_dir / f"cutouts_oriented/{ident}.png", upright_cutout)

    rec = (obj or {}).get("recognition") or (recognition.get("objects") or {}).get(str(inst["id"]))
    klass = _class_record(rec)
    fit_record: dict[str, Any] | None = None
    dims: dict[str, float | None] | None = None
    confidence = 0.0
    needs_views: list[Any] = []
    needs_view = False
    status = STATUS_NO_SCALE
    if obj is not None:
        fit = {k: v for k, v in obj["fit"].items() if k not in ("glb", "_files", "cached")}
        glb_rel = f"models/{ident}.glb"
        copy_file(img.dir / obj["fit"]["glb"], out_dir / glb_rel)
        fit_record = {**fit, "glb": glb_rel, "glbPose": obj.get("glb_pose"), "centreMm": obj["centre_mm"],
                      "dimsFixed": obj.get("fixed_dims") or None}  # fmt: skip
        dims = dimensions_mm(obj["fit"])
        confidence = float(obj["confidence"])
        needs_view = bool(obj["needs_view"])
        needs_views = list((obj.get("check") or {}).get("needs_views") or [])
        status = STATUS_OK if confidence >= min_conf else STATUS_NEEDS_CONFIRMATION
    elif error is not None:
        status = STATUS_FIT_FAILED
    colours = None
    if colours_on:
        colours = service.stages.sample_colours(img.rgb, mask, obj["fit"] if obj is not None else None)
    return {
        "id": int(inst["id"]),
        "bboxXywh": inst["bbox_xywh"],
        "areaPx": inst["area_px"],
        "polygon": inst.get("polygon"),
        "bgProb": inst.get("bg_prob"),
        "mask": mask_rel,
        "crop": {"path": crop_rel, "boxXywh": [box[0], box[1], box[2] - box[0], box[3] - box[1]]},
        "cutout": cutout_rel,
        "cropOriented": f"crops_oriented/{ident}.png",
        "cutoutOriented": f"cutouts_oriented/{ident}.png",
        "axis": axis,
        "profile": profile,
        "mmPerPx": mm_per_px,
        "embedding": None
        if embedding is None
        else {"file": EMBEDDINGS_FILE, "row": row, "dim": int(embedding.shape[0]), "model": stage_embed.MODEL,
              **({"vector": [float(v) for v in embedding]} if req.inline_embeddings else {})},  # fmt: skip
        "class": klass,
        "fit": fit_record,
        "dimensionsMm": dims,
        "colours": colours,
        "confidence": round(confidence, 4),
        "needsView": needs_view,
        "needsViews": needs_views,
        "status": status,
        "error": error,
        **({} if scaled else {"needs": "scale"}),
    }


def _class_record(rec: dict[str, Any] | None) -> dict[str, Any]:
    """Recognition -> `class`. `toolClass` is only set when the margin share `prob` reaches `MIN_RECOGNITION_PROB`
    (the wall proposal's rule); `topk` is always the ranked candidates with their calibrated CLIP scores."""
    rec = rec or {}
    prob = rec.get("prob")
    best = rec.get("tool_class") if (prob or 0.0) >= MIN_RECOGNITION_PROB else None
    return {
        "toolClass": best,
        "label": rec.get("label"),
        "score": rec.get("score"),
        "prob": prob,
        "calibrated": rec.get("calibrated"),
        "topk": [
            {"toolClass": c.get("tool_class"), "label": c.get("label"), "score": c.get("score")} for c in rec.get("topk", [])
        ],
        "bankTopk": rec.get("bank_topk", []),
        **({"ai": rec["ai"]} if rec.get("ai") else {}),
    }


def _write_cutout(rgb: np.ndarray, mask: np.ndarray, box: tuple[int, int, int, int], path: Path) -> None:
    """RGBA of the crop window: the photo where the mask is set, transparent elsewhere."""
    import cv2

    x0, y0, x1, y1 = box
    bgra = cv2.cvtColor(np.ascontiguousarray(rgb[y0:y1, x0:x1]), cv2.COLOR_RGB2BGRA)
    bgra[..., 3] = np.where(mask[y0:y1, x0:x1], 255, 0).astype(np.uint8)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), bgra)


def _write_overlays(
    service: VisionService,
    img: Image,
    segmentation: dict[str, Any],
    out_dir: Path,
    objects_in: list[dict[str, Any]],
    masks: dict[int, np.ndarray],
    fitted: dict[int, dict[str, Any]],
    calibration: dict[str, Any] | None,
) -> dict[str, str | None]:
    """`overlay.jpg` (segmentation) and, with a scale, `fit-overlay.jpg` (every fitted model drawn on the photo)."""
    import cv2

    overlays: dict[str, str | None] = {"segmentation": None, "fit": None}
    seg_overlay = segmentation.get("overlay")
    if seg_overlay:
        copy_file(img.dir / segmentation["dir"] / seg_overlay, out_dir / "overlay.jpg")
        overlays["segmentation"] = "overlay.jpg"
    if calibration is not None and fitted:
        camera = camera_from_calibration(calibration)
        items = [(i["id"], masks[i["id"]], fitted[i["id"]]["fit"]) for i in objects_in if i["id"] in fitted]
        image = service.stages.render_overlay(img.rgb, items, camera)
        cv2.imwrite(str(out_dir / "fit-overlay.jpg"), cv2.cvtColor(image, cv2.COLOR_RGB2BGR))
        overlays["fit"] = "fit-overlay.jpg"
    return overlays
