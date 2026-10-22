"""photo -> wall PROPOSAL orchestrator.

calibrate (grid, else two-point, else reference, else needs_calibration) -> segment -> recognise (+ bank re-rank)
-> per-object `fit_auto` -> multi-view check (held-out IoU as confidence; low => `request_view`) -> holder suggestions
-> proposal (a batch of core ops, never applied here).

The object analysis itself is `hsw_vision.analysis` (shared with `objects.photo_to_objects`). Progress is reported
through `emit(event)` (NDJSON over HTTP, printed by the CLI). A cancelled run stops at the next checkpoint (inside
the segmentation's progress callback, between objects, between registrations). AI assist is consulted only through
`ai_assist.should_assist` (off by default).
"""

from __future__ import annotations

import threading
from typing import Any

from hsw_vision.analysis import StageClock, fit_objects, load_extra_photos, safe_status, select_instances
from hsw_vision.geometry import Board
from hsw_vision.proposal import build_proposal
from hsw_vision.schemas import PhotoToWallRequest
from hsw_vision.service import Emit, Image, VisionService, _noop, segmentation_digest
from hsw_vision.stages import multiview as stage_multiview


def run(
    service: VisionService,
    req: PhotoToWallRequest,
    emit: Emit = _noop,
    cancel: threading.Event | None = None,
    img: Image | None = None,
) -> dict[str, Any]:
    config = service.config
    clock = StageClock(emit, cancel)
    extras = load_extra_photos(service, req)  # cheap validation before any heavy stage
    img = img or service.open(req)
    emit({"event": "stage", "stage": "open", "state": "done", "image": {"w": img.size[0], "h": img.size[1]}})

    # 1. calibrate (reference scale needs the segmentation first, so it is resolved inside `calibrate`)
    clock.start("calibrate")
    calibration = service.calibrate(img, req.calibrate, req.segment, emit, cancel)
    clock.done("calibrate", ok=bool(calibration.get("ok")), method=calibration.get("method"))
    base: dict[str, Any] = {
        "image": {"path": str(img.path), "sha256": img.sha256, "w": img.size[0], "h": img.size[1]},
        "calibration": calibration,
        "work": {"imageDir": str(img.dir)},
    }
    if not calibration.get("ok"):
        event = {"event": "needs_calibration", "mode": "two-point", "message": calibration.get("message")}
        emit(event)
        return {**base, "status": "needs_calibration", "needs": "scale", "message": calibration.get("message"),
                "proposal": None, "events": [event], "diagnostics": {"timing_s": clock.total()}}  # fmt: skip
    clock.check_cancel("photo-to-wall")

    # 2. segment
    clock.start("segment")
    segmentation = service.segment(img, req.segment, emit, cancel)
    objects_in, skipped = select_instances(segmentation, req)
    clock.done("segment", instances=len(segmentation["instances"]), selected=len(objects_in))
    clock.check_cancel("photo-to-wall")

    # 3. recognise
    clock.start("recognise")
    recognition = service.recognise(img, segmentation, [i["id"] for i in objects_in], req.bank_index, categories=req.categories)
    clock.done("recognise")
    clock.check_cancel("photo-to-wall")

    # 4-5. fit + multi-view check per object
    fitted = fit_objects(service, req, img, calibration, segmentation, objects_in, recognition, extras, clock)

    # 6. proposal (+ request_view)
    min_conf = req.min_confidence if req.min_confidence is not None else config.min_confidence
    auto_conf = req.auto_apply_confidence if req.auto_apply_confidence is not None else config.auto_apply_confidence
    view_threshold = req.view_flag_iou if req.view_flag_iou is not None else config.view_flag_iou
    clock.start("proposal")
    proposal = build_proposal(
        photo_id=req.photo_id,
        image_sha256=img.sha256,
        segmentation_digest=segmentation_digest(segmentation),
        calibration=calibration,
        objects=fitted.items,
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
    clock.done("proposal", items=len(proposal["items"]))
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
            "timing_s": clock.total(),
            "skipped": skipped,
            "failures": fitted.failures,
            "extraPhotos": [{k: v for k, v in r.items() if k != "views"} for r in fitted.registrations],
            "cache": {"segment": segmentation.get("cached"), "calibrate": calibration.get("cached")},
            "device": service.config.device,
            "models": safe_status(service),
        },
    }
