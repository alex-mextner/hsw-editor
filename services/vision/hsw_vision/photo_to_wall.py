"""photo -> wall PROPOSAL orchestrator.

calibrate (grid, else two-point, else reference, else needs_calibration) -> segment -> recognise (+ bank re-rank)
-> per-object `fit_auto` -> multi-view check (held-out IoU as confidence; low => `request_view`) -> holder suggestions
-> proposal (a batch of core ops, never applied here).

Progress is reported through `emit(event)` (NDJSON over HTTP, printed by the CLI). A cancelled run stops between
objects. AI assist is consulted only through `ai_assist.should_assist` (off by default).
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from hsw_vision.ai_assist import AiAssistRequest, should_assist
from hsw_vision.errors import MissingDependency, VisionServiceError
from hsw_vision.geometry import Board
from hsw_vision.proposal import build_proposal
from hsw_vision.schemas import PhotoToWallRequest
from hsw_vision.service import Emit, Image, VisionService, _noop, segmentation_digest
from hsw_vision.stages import fit as stage_fit
from hsw_vision.stages import multiview as stage_multiview

MAX_AREA_FRACTION = 0.25  # a "tool" covering a quarter of the photo is the background
MAX_BG_PROB = 0.5


class Cancelled(VisionServiceError):
    code = "cancelled"
    http_status = 499


def select_instances(segmentation: dict[str, Any], req: PhotoToWallRequest) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Plausible objects: big enough, not background, not the whole photo; largest first, capped."""
    w, h = segmentation["image"]["w"], segmentation["image"]["h"]
    skipped = {"too_small": 0, "background": 0, "too_large": 0, "not_selected": 0, "over_cap": 0}
    keep: list[dict[str, Any]] = []
    wanted = set(req.instances) if req.instances is not None else None
    for inst in segmentation["instances"]:
        if wanted is not None and inst["id"] not in wanted:
            skipped["not_selected"] += 1
        elif inst["area_px"] < req.min_area_px:
            skipped["too_small"] += 1
        elif inst["area_px"] > MAX_AREA_FRACTION * w * h:
            skipped["too_large"] += 1
        elif (inst.get("bg_prob") or 0.0) > MAX_BG_PROB:
            skipped["background"] += 1
        else:
            keep.append(inst)
    keep.sort(key=lambda i: -i["area_px"])
    skipped["over_cap"] = max(0, len(keep) - req.max_objects)
    return keep[: req.max_objects], skipped


def run(
    service: VisionService,
    req: PhotoToWallRequest,
    emit: Emit = _noop,
    cancel: threading.Event | None = None,
    img: Image | None = None,
) -> dict[str, Any]:
    config = service.config
    t_start = time.monotonic()
    timing: dict[str, float] = {}

    def stage_done(name: str, since: float, **extra: Any) -> None:
        timing[name] = round(time.monotonic() - since, 3)
        emit({"event": "stage", "stage": name, "state": "done", "seconds": timing[name], **extra})

    def check_cancel() -> None:
        if cancel is not None and cancel.is_set():
            raise Cancelled("photo-to-wall cancelled")

    img = img or service.open(req)
    emit({"event": "stage", "stage": "open", "state": "done", "image": {"w": img.size[0], "h": img.size[1]}})

    # 1. calibrate (reference scale needs the segmentation first, so it is resolved inside `calibrate`)
    t0 = time.monotonic()
    emit({"event": "stage", "stage": "calibrate", "state": "start"})
    calibration = service.calibrate(img, req.calibrate, req.segment, emit)
    stage_done("calibrate", t0, ok=bool(calibration.get("ok")), method=calibration.get("method"))
    base: dict[str, Any] = {
        "image": {"path": str(img.path), "sha256": img.sha256, "w": img.size[0], "h": img.size[1]},
        "calibration": calibration,
        "work": {"imageDir": str(img.dir)},
    }
    if not calibration.get("ok"):
        result = {**base, "status": "needs_calibration", "needs": "scale", "message": calibration.get("message"),
                  "proposal": None, "events": [{"event": "needs_calibration", "mode": "two-point",
                                                  "message": calibration.get("message")}],
                  "diagnostics": {"timing_s": {**timing, "total": round(time.monotonic() - t_start, 3)}}}  # fmt: skip
        emit({"event": "needs_calibration", "mode": "two-point", "message": calibration.get("message")})
        return result
    check_cancel()

    # 2. segment
    t0 = time.monotonic()
    emit({"event": "stage", "stage": "segment", "state": "start"})
    segmentation = service.segment(img, req.segment, emit)
    objects_in, skipped = select_instances(segmentation, req)
    stage_done("segment", t0, instances=len(segmentation["instances"]), selected=len(objects_in))
    check_cancel()

    # 3. recognise
    t0 = time.monotonic()
    emit({"event": "stage", "stage": "recognise", "state": "start"})
    recognition = service.recognise(img, segmentation, [i["id"] for i in objects_in], req.bank_index)
    stage_done("recognise", t0)

    # 4-5. fit + multi-view check per object
    camera = service.camera(calibration)
    view_threshold = req.view_flag_iou if req.view_flag_iou is not None else config.view_flag_iou
    min_conf = req.min_confidence if req.min_confidence is not None else config.min_confidence
    auto_conf = req.auto_apply_confidence if req.auto_apply_confidence is not None else config.auto_apply_confidence
    fitted: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    t_register = time.monotonic()
    registrations = _register_extra(service, req, img, objects_in, segmentation, camera, emit)
    if registrations:
        stage_done("register", t_register, photos=len(registrations))
    t0 = time.monotonic()
    emit({"event": "stage", "stage": "fit", "state": "start", "total": len(objects_in)})
    for n, inst in enumerate(objects_in, 1):
        check_cancel()
        fixed = req.fixed_dims.get(str(inst["id"]))
        try:
            fit = service.fit(
                img, segmentation, inst["id"], calibration,
                fixed_dims=fixed, max_tries=req.max_tries, device=req.device, seed=req.seed,
            )  # fmt: skip
        except VisionServiceError:
            raise
        except ImportError as exc:  # a missing extra must be the structured error, not an invisible per-object failure
            raise MissingDependency(
                f"missing python dependency: {exc}", fix="uv sync --project services/vision --extra ml"
            ) from exc
        except Exception as exc:  # noqa: BLE001 - one bad mask must not sink the other objects
            failures.append({"instanceId": inst["id"], "error": f"{type(exc).__name__}: {exc}"})
            emit({"event": "object", "instanceId": inst["id"], "state": "failed", "done": n, "total": len(objects_in)})
            continue
        views = [r["views"][n - 1] for r in registrations if r["views"][n - 1] is not None]
        check = service.check(fit, views, view_threshold)
        confidence = stage_fit.fit_confidence(fit, config.single_view_confidence_cap)
        view_conf = stage_multiview.view_confidence(check)
        if view_conf is not None:
            confidence = view_conf
        rec = (recognition.get("objects") or {}).get(str(inst["id"]))
        centre_mm = camera.px_to_plane_mm(np.array(fit["centre_px"]))[0].tolist()
        obj: dict[str, Any] = {
            "instance_id": inst["id"],
            "centre_mm": centre_mm,
            "fit": fit,
            "check": check,
            "confidence": confidence,
            "needs_view": stage_multiview.needs_view(check, confidence, view_threshold),
            "recognition": dict(rec) if rec else None,
            "glb": fit.get("glb"),
            "glb_pose": fit.get("glb_pose"),
            "fixed_dims": fixed,
        }
        _maybe_assist(service, req, img, inst, obj, set(recognition.get("classes") or []))
        fitted.append(obj)
        emit({"event": "object", "instanceId": inst["id"], "state": "fitted", "confidence": round(confidence, 3),
              "done": n, "total": len(objects_in), "fraction": n / max(len(objects_in), 1)})  # fmt: skip
    stage_done("fit", t0, fitted=len(fitted), failed=len(failures))
    if failures and not fitted:
        raise VisionServiceError(
            f"every fit failed ({len(failures)} object(s)); first: {failures[0]['error']}",
            details={"failures": failures[:10]},
        )

    # 6. proposal (+ request_view)
    t0 = time.monotonic()
    proposal = build_proposal(
        photo_id=req.photo_id,
        image_sha256=img.sha256,
        segmentation_digest=segmentation_digest(segmentation),
        calibration=calibration,
        objects=fitted,
        board=Board.from_json(req.board),
        bank_index=req.bank_index,
        auto_apply_confidence=auto_conf,
        min_confidence=min_conf,
        anchor_mm=req.anchor_mm,
    )
    events: list[dict[str, Any]] = []
    request_view = stage_multiview.request_view_event(
        [{"id": item["id"], "confidence": item["confidence"], "needs_view": item["needsView"], "check": item["check"]}
         for item in proposal["items"]],
        photo_id=req.photo_id, threshold=view_threshold,
    )  # fmt: skip
    if request_view is not None:
        events.append(request_view)
        emit(request_view)
    stage_done("proposal", t0, items=len(proposal["items"]))
    return {
        **base,
        "status": "ok",
        "segmentation": {
            "dir": segmentation["dir"],
            "method": segmentation.get("method"),
            "device": segmentation.get("device"),
            "instances": len(segmentation["instances"]),
            "overlay": f"{segmentation['dir']}/{segmentation['overlay']}" if segmentation.get("overlay") else None,
        },
        "proposal": proposal,
        "events": events,
        "diagnostics": {
            "timing_s": {**timing, "total": round(time.monotonic() - t_start, 3)},
            "skipped": skipped,
            "failures": failures,
            "extraPhotos": [{k: v for k, v in r.items() if k != "views"} for r in registrations],
            "cache": {"segment": segmentation.get("cached"), "calibrate": calibration.get("cached")},
            "device": service.config.device,
            "models": _safe_status(service),
        },
    }


def _register_extra(
    service: VisionService,
    req: PhotoToWallRequest,
    img: Image,
    objects_in: list[dict[str, Any]],
    segmentation: dict[str, Any],
    camera: Any,
    emit: Emit,
) -> list[dict[str, Any]]:
    """Register every extra photo against the main one; per object, `views[i]` is its mask seen from there (or None)."""
    if not req.extra_photos or not objects_in:
        return []
    masks = service.masks(img, segmentation)
    ordered = [masks[inst["id"]] for inst in objects_in]
    registrations: list[dict[str, Any]] = []
    for path in req.extra_photos:
        emit({"event": "stage", "stage": "register", "state": "start", "image": str(path)})
        other = service.loader(Path(path))
        with service.run_lock:
            registrations.append({"image": str(path), **service.stages.register_views(img.rgb, other, ordered, camera)})
    return registrations


def _maybe_assist(
    service: VisionService,
    req: PhotoToWallRequest,
    img: Image,
    inst: dict[str, Any],
    obj: dict[str, Any],
    known_classes: set[str],
) -> None:
    """Optional AI refinement. The gate is `should_assist`: off unless the config enables it."""
    if service.assist is None or not should_assist(service.config, requested=req.ai_assist, confidence=obj["confidence"]):
        return
    crop = _write_crop(img, inst)
    rec = obj["recognition"] or {}
    result = service.assist.refine(
        AiAssistRequest(
            item_id=str(inst["id"]),
            crop_path=crop,
            tool_class=rec.get("tool_class"),
            confidence=obj["confidence"],
            candidates=[c["tool_class"] for c in rec.get("topk", []) if c.get("tool_class")],
            dims_mm=stage_fit.dimensions(obj["fit"]),
        )
    )
    if result is None:
        return
    updated = dict(rec)
    known = known_classes or {c["tool_class"] for c in rec.get("topk", []) if c.get("tool_class")}
    accepted = result.tool_class if result.tool_class in known else None  # an invented class id is ignored
    updated["ai"] = {
        "toolClass": accepted,
        "label": result.label,
        "dimsMm": result.dims_mm,
        "notes": result.notes,
        **({"rejectedToolClass": result.tool_class} if result.tool_class and accepted is None else {}),
    }
    if accepted:
        updated["tool_class"] = accepted
        updated["prob"] = max(float(updated.get("prob") or 0.0), 0.5)
        updated["source"] = "ai"
    obj["recognition"] = updated


def _write_crop(img: Image, inst: dict[str, Any]) -> Path:
    import cv2

    x, y, w, h = inst["bbox_xywh"]
    pad = int(0.1 * max(w, h))
    h_img, w_img = img.rgb.shape[:2]
    crop = img.rgb[max(y - pad, 0) : min(y + h + pad, h_img), max(x - pad, 0) : min(x + w + pad, w_img)]
    path = img.dir / "crops" / f"{inst['id']:03d}.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
    return path


def _safe_status(service: VisionService) -> dict[str, Any]:
    """Diagnostics must never fail a finished run (a GPU probe can raise)."""
    try:
        return service.manager.status()
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}
