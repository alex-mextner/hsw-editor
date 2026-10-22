"""The object analysis both pipelines share: pick the plausible objects, register extra photos, fit each object and
score it (one confidence policy, `hsw_vision.confidence`). `photo_to_wall` turns the result into a wall proposal,
`objects.photo_to_objects` into per-object library records; neither re-implements a step.

Progress goes through `emit(event)`; a run stops at the next checkpoint once `cancel` is set (`Cancelled`).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from hsw_vision.ai_assist import AiAssistRequest, should_assist
from hsw_vision.confidence import assess
from hsw_vision.config import SETUP_HINT
from hsw_vision.errors import Cancelled, MissingDependency, VisionServiceError
from hsw_vision.schemas import PhotoRequest
from hsw_vision.service import Emit, Image, VisionService, _noop
from hsw_vision.stages import fit as stage_fit

MAX_AREA_FRACTION = 0.25  # a "tool" covering a quarter of the photo is the background
MAX_BG_PROB = 0.5


class StageClock:
    """Per-stage wall-clock seconds, reported as `stage` events and in `diagnostics.timing_s`."""

    def __init__(self, emit: Emit = _noop, cancel: threading.Event | None = None) -> None:
        self.emit = emit
        self.cancel = cancel
        self.timing: dict[str, float] = {}
        self._started = time.monotonic()
        self._stage_started = self._started

    def check_cancel(self, what: str = "run") -> None:
        if self.cancel is not None and self.cancel.is_set():
            raise Cancelled(f"{what} cancelled")

    def start(self, stage: str, **extra: Any) -> None:
        self._stage_started = time.monotonic()
        self.emit({"event": "stage", "stage": stage, "state": "start", **extra})

    def done(self, stage: str, **extra: Any) -> float:
        seconds = round(time.monotonic() - self._stage_started, 3)
        self.timing[stage] = seconds
        self.emit({"event": "stage", "stage": stage, "state": "done", "seconds": seconds, **extra})
        return seconds

    def total(self) -> dict[str, float]:
        return {**self.timing, "total": round(time.monotonic() - self._started, 3)}


def select_instances(segmentation: dict[str, Any], req: PhotoRequest) -> tuple[list[dict[str, Any]], dict[str, int]]:
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


def load_extra_photos(service: VisionService, req: PhotoRequest) -> list[tuple[Path, np.ndarray]]:
    """Decode every extra photo BEFORE any heavy stage: a missing/corrupt file is a cheap `bad_request`, not a failure
    after the segmentation has run. Duplicates are dropped (the same file twice adds no viewpoint)."""
    seen: set[Path] = set()
    photos: list[tuple[Path, np.ndarray]] = []
    for raw in req.extra_photos:
        path, rgb = service.read_photo(raw)
        resolved = path.resolve()
        if resolved in seen or resolved == Path(req.image_path).expanduser().resolve():
            continue
        seen.add(resolved)
        photos.append((path, rgb))
    return photos


def register_extra(
    service: VisionService,
    img: Image,
    extras: list[tuple[Path, np.ndarray]],
    objects_in: list[dict[str, Any]],
    segmentation: dict[str, Any],
    camera: Any,
    clock: StageClock,
) -> list[dict[str, Any]]:
    """Register every extra photo against the main one; per object, `views[i]` is its mask seen from there (or None)."""
    if not extras or not objects_in:
        return []
    masks = service.masks(img, segmentation, only=[inst["id"] for inst in objects_in])
    ordered = [masks[inst["id"]] for inst in objects_in]
    registrations: list[dict[str, Any]] = []
    for path, other in extras:
        clock.check_cancel("registration")
        clock.emit({"event": "stage", "stage": "register", "state": "start", "image": str(path)})
        with service.run_lock:
            registrations.append({"image": str(path), **service.stages.register_views(img.rgb, other, ordered, camera)})
    return registrations


@dataclass
class Fitted:
    items: list[dict[str, Any]] = field(default_factory=list)
    failures: list[dict[str, Any]] = field(default_factory=list)
    registrations: list[dict[str, Any]] = field(default_factory=list)


def fit_objects(
    service: VisionService,
    req: PhotoRequest,
    img: Image,
    calibration: dict[str, Any],
    segmentation: dict[str, Any],
    objects_in: list[dict[str, Any]],
    recognition: dict[str, Any],
    extras: list[tuple[Path, np.ndarray]],
    clock: StageClock,
    *,
    raise_when_all_fail: bool = True,
) -> Fitted:
    """Fit + multi-view check + confidence for each object. A single bad mask is a recorded failure; when every fit
    fails the wall pipeline fails (an empty proposal must not look like "found nothing"), while `photo_to_objects`
    (`raise_when_all_fail=False`) keeps the masks, crops and classes and marks each record `fit_failed`."""
    config = service.config
    camera = service.camera(calibration)
    view_threshold = req.view_flag_iou if req.view_flag_iou is not None else config.view_flag_iou
    out = Fitted()
    t_register = time.monotonic()
    out.registrations = register_extra(service, img, extras, objects_in, segmentation, camera, clock)
    if out.registrations:
        clock.timing["register"] = round(time.monotonic() - t_register, 3)
        clock.emit({"event": "stage", "stage": "register", "state": "done", "seconds": clock.timing["register"],
                    "photos": len(out.registrations)})  # fmt: skip
    clock.start("fit", total=len(objects_in))
    for n, inst in enumerate(objects_in, 1):
        clock.check_cancel("fit")
        fixed = req.fixed_dims.get(str(inst["id"]))
        try:
            fit = service.fit(
                img, segmentation, inst["id"], calibration,
                fixed_dims=fixed, max_tries=req.max_tries, device=req.device, seed=req.seed,
            )  # fmt: skip
        except VisionServiceError:
            raise
        except ImportError as exc:  # a missing extra must be the structured error, not an invisible per-object failure
            raise MissingDependency(f"missing python dependency: {exc}", fix=SETUP_HINT) from exc
        except Exception as exc:  # noqa: BLE001 - one bad mask must not sink the other objects
            out.failures.append({"instanceId": inst["id"], "error": f"{type(exc).__name__}: {exc}"})
            clock.emit({"event": "object", "instanceId": inst["id"], "state": "failed", "done": n, "total": len(objects_in)})
            continue
        clock.check_cancel("fit")
        views = [r["views"][n - 1] for r in out.registrations if r["views"][n - 1] is not None]
        check = service.check(fit, views, view_threshold)
        assessment = assess(fit, check, single_view_cap=config.single_view_confidence_cap, view_flag_iou=view_threshold)
        rec = (recognition.get("objects") or {}).get(str(inst["id"]))
        centre_mm = camera.px_to_plane_mm(np.array(fit["centre_px"]))[0].tolist()
        obj: dict[str, Any] = {
            "instance_id": inst["id"],
            "centre_mm": centre_mm,
            "fit": fit,
            "check": check,
            "confidence": assessment.confidence,
            "needs_view": assessment.needs_view,
            "recognition": dict(rec) if rec else None,
            "glb": fit.get("glb"),
            "glb_pose": fit.get("glb_pose"),
            "fixed_dims": fixed,
        }
        _maybe_assist(service, req, img, inst, obj, set(recognition.get("classes") or []))
        out.items.append(obj)
        clock.emit({"event": "object", "instanceId": inst["id"], "state": "fitted", "confidence": round(assessment.confidence, 3),
                    "done": n, "total": len(objects_in), "fraction": n / max(len(objects_in), 1)})  # fmt: skip
    clock.done("fit", fitted=len(out.items), failed=len(out.failures))
    if raise_when_all_fail and out.failures and not out.items:
        raise VisionServiceError(
            f"every fit failed ({len(out.failures)} object(s)); first: {out.failures[0]['error']}",
            details={"failures": out.failures[:10]},
        )
    return out


def _maybe_assist(
    service: VisionService,
    req: PhotoRequest,
    img: Image,
    inst: dict[str, Any],
    obj: dict[str, Any],
    known_classes: set[str],
) -> None:
    """Optional AI refinement. The gate is `should_assist`: off unless the config enables it."""
    if service.assist is None or not should_assist(service.config, requested=req.ai_assist, confidence=obj["confidence"]):
        return
    crop = write_crop(img, inst)
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


def crop_box(inst: dict[str, Any], image_wh: tuple[int, int], pad_frac: float = 0.1) -> tuple[int, int, int, int]:
    """`(x0, y0, x1, y1)` of the object's bbox grown by `pad_frac` of its larger side, clipped to the photo."""
    x, y, w, h = inst["bbox_xywh"]
    pad = int(pad_frac * max(w, h))
    return max(x - pad, 0), max(y - pad, 0), min(x + w + pad, image_wh[0]), min(y + h + pad, image_wh[1])


def write_crop(img: Image, inst: dict[str, Any], pad_frac: float = 0.1, path: Path | None = None) -> Path:
    """RGB crop of the object (background kept) as a PNG; default `<image dir>/crops/<id>.png`."""
    import cv2

    x0, y0, x1, y1 = crop_box(inst, img.size, pad_frac)
    crop = img.rgb[y0:y1, x0:x1]
    target = path or img.dir / "crops" / f"{inst['id']:03d}.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(target), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
    return target


def safe_status(service: VisionService) -> dict[str, Any]:
    """Diagnostics must never fail a finished run (a GPU probe can raise)."""
    try:
        return service.manager.status()
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}
