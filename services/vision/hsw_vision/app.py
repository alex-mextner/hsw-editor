"""hsw-vision HTTP API (FastAPI). Loopback only: every request's Host header must be loopback.

`GET /health`, `GET /models/status`, `POST /calibrate|/segment|/recognise|/fit|/multiview` and `POST /objects/merge|split|reprofile|add` (JSON), and
`POST /photo-to-wall` and `POST /photo-to-objects` which stream NDJSON events (`stage`, `progress`, `object`, `request_view`, then one final
`result` or `error` line). Stage errors are `{"error": {code, message, fix?, details?}}` with the HTTP status of the
error class (`models_missing` = 424 naming `hsw-editor vision fetch-models`).
"""

from __future__ import annotations

import base64
import json
import queue
import threading
from collections.abc import Callable, Iterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from hsw_vision import __version__
from hsw_vision import objects as objects_pipeline
from hsw_vision import objects_edit
from hsw_vision import photo_to_wall as wall_pipeline
from hsw_vision.config import VisionConfig
from hsw_vision.confidence import assess, fit_confidence
from hsw_vision.errors import VisionServiceError, error_json_for
from hsw_vision.schemas import (
    AddObjectRequest,
    CalibrateRequest,
    FitRequest,
    MergeObjectsRequest,
    MultiviewRequest,
    PhotoRequest,
    PhotoToObjectsRequest,
    PhotoToWallRequest,
    RecogniseRequest,
    ReprofileObjectsRequest,
    SegmentRequest,
    SplitObjectRequest,
)
from hsw_vision.service import VisionService
from hsw_vision.stages import fit as stage_fit

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]", "::1"}


def _host_allowed(header: str | None) -> bool:
    if not header:
        return False
    header = header.lower()  # Host is case-insensitive
    host = header[: header.index("]") + 1] if header.startswith("[") and "]" in header else header.split(":")[0]
    return host in LOOPBACK_HOSTS


def create_app(
    service: VisionService | None = None,
    config: VisionConfig | None = None,
    on_shutdown: Callable[[], None] | None = None,
) -> FastAPI:
    """`service=None` builds the real service lazily on first use (so `/health` never imports the heavy stack).

    `on_shutdown` runs when the server stops (uvicorn re-raises SIGTERM after a graceful shutdown, so code after
    `uvicorn.run` never executes; the state file is removed here)."""
    state: dict[str, VisionService] = {}
    if service is not None:
        state["service"] = service
    lock = threading.Lock()

    def get_service() -> VisionService:
        with lock:
            if "service" not in state:
                state["service"] = VisionService.create(config or VisionConfig.from_env())
            return state["service"]

    @asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        stop = threading.Event()

        def reap() -> None:
            while not stop.wait(15.0):
                svc = state.get("service")
                if svc is None:
                    continue
                try:
                    svc.manager.unload_idle()
                except Exception:  # noqa: BLE001 - the reaper must outlive any single bad tick
                    continue

        thread = threading.Thread(target=reap, name="idle-reaper", daemon=True)
        thread.start()
        try:
            yield
        finally:
            stop.set()
            svc = state.get("service")
            if svc is not None:
                svc.manager.unload_all()
            if on_shutdown is not None:
                on_shutdown()

    app = FastAPI(title="hsw-vision", version=__version__, lifespan=lifespan)

    @app.middleware("http")
    async def loopback_guard(request: Request, call_next: Callable[[Request], Any]) -> Any:
        if not _host_allowed(request.headers.get("host")):
            return JSONResponse(
                {"error": {"code": "forbidden_host", "message": "only loopback Host headers are accepted"}}, 403
            )
        return await call_next(request)

    @app.exception_handler(VisionServiceError)
    async def service_error(_: Request, exc: VisionServiceError) -> JSONResponse:
        return JSONResponse(exc.to_json(), status_code=exc.http_status)

    @app.exception_handler(Exception)
    async def unexpected(_: Request, exc: Exception) -> JSONResponse:
        body, status = error_json_for(exc)
        return JSONResponse(body, status_code=status)

    @app.get("/health")
    def health() -> dict[str, object]:
        return {"ok": True, "name": "hsw-vision", "version": __version__}

    @app.get("/models/status")
    def models_status() -> dict[str, Any]:
        return get_service().status() | model_files()

    @app.post("/calibrate")
    def calibrate(req: CalibrateRequest) -> dict[str, Any]:
        svc = get_service()
        img = svc.open(req)
        return svc.calibrate(img, req.calibrate, req.segment) | {"image": _image_info(img)}

    @app.post("/segment")
    def segment(req: SegmentRequest) -> dict[str, Any]:
        svc = get_service()
        img = svc.open(req)
        result = svc.segment(img, req.segment)
        out: dict[str, Any] = {**result, "image": _image_info(img), "imageDir": str(img.dir)}
        if req.include_masks:
            masks = svc.masks(img, result)
            out["masks_png_base64"] = {str(i): _png_b64(m) for i, m in masks.items()}
        return out

    @app.post("/recognise")
    def recognise(req: RecogniseRequest) -> dict[str, Any]:
        svc = get_service()
        img = svc.open(req)
        seg = svc.segment(img, req.segment)
        ids = req.instances if req.instances is not None else [i["id"] for i in seg["instances"]]
        return svc.recognise(img, seg, ids, req.bank_index, req.topk, req.categories)

    @app.post("/fit")
    def fit(req: FitRequest) -> dict[str, Any]:
        svc = get_service()
        img = svc.open(req)
        calibration = svc.calibrate(img, req.calibrate, req.segment)
        svc.camera(calibration)  # no scale: the cheap 422 comes before a SAM2 run
        seg = svc.segment(img, req.segment)
        result = svc.fit(
            img, seg, req.instance, calibration,
            fixed_dims=req.fixed_dims, template=req.template, planar=req.planar,
            max_tries=req.max_tries, device=req.device, seed=req.seed,
        )  # fmt: skip
        confidence = fit_confidence(result, svc.config.single_view_confidence_cap)
        train = (result.get("confidence") or {}).get("train_min_iou")
        return {
            "instance": req.instance,
            "fit": result,
            "dimensionsMm": stage_fit.dimensions(result),
            "confidence": confidence,
            "residual": None if train is None else round(1.0 - float(train), 4),
            "dimsFixed": req.fixed_dims or None,
            "calibration": {k: calibration.get(k) for k in ("ok", "method", "mm_per_px", "plane_depth_mm")},
            "imageDir": str(img.dir),
        }

    @app.post("/multiview")
    def multiview(req: MultiviewRequest) -> dict[str, Any]:
        svc = get_service()
        check = svc.check(req.fit, req.views, req.flag_below)
        verdict = assess(
            req.fit, check, single_view_cap=svc.config.single_view_confidence_cap, view_flag_iou=req.flag_below
        )
        return {
            **check,
            "confidence": verdict.confidence,
            "threshold": req.flag_below,
            "request_view": verdict.needs_view,
        }

    @app.post("/photo-to-wall")
    def photo_to_wall(req: PhotoToWallRequest) -> StreamingResponse:
        svc = get_service()
        return StreamingResponse(_ndjson(svc, req, wall_pipeline.run, "photo-to-wall"), media_type="application/x-ndjson")

    @app.post("/photo-to-objects")
    def photo_to_objects(req: PhotoToObjectsRequest) -> StreamingResponse:
        svc = get_service()
        return StreamingResponse(_ndjson(svc, req, objects_pipeline.run, "photo-to-objects"), media_type="application/x-ndjson")

    @app.post("/objects/merge")
    def objects_merge(req: MergeObjectsRequest) -> dict[str, Any]:
        return objects_edit.merge_objects(get_service(), req.out_dir, req.ids)

    @app.post("/objects/split")
    def objects_split(req: SplitObjectRequest) -> dict[str, Any]:
        return objects_edit.split_object(get_service(), req.out_dir, req.id, line_px=req.line_px, n=req.n)

    @app.post("/objects/reprofile")
    def objects_reprofile(req: ReprofileObjectsRequest) -> dict[str, Any]:
        return objects_edit.reprofile_objects(
            get_service(), req.out_dir, ids=req.ids, fixed_dims=req.fixed_dims, calibrate=req.calibrate
        )

    @app.post("/objects/add")
    def objects_add(req: AddObjectRequest) -> dict[str, Any]:
        return objects_edit.add_object(get_service(), req.out_dir, point_px=req.point_px, box_xywh=req.box_xywh)

    return app


def model_files() -> dict[str, Any]:
    """On-disk model status from the library; degrades to an error note when the library lacks the heavy extras."""
    try:
        from threed_vision import device as tv_device
        from threed_vision import models as tv_models

        return {
            "models": tv_models.status(),
            "gpu": {"free_vram_mb": tv_device.free_vram_mb(), "ort": tv_device.ort_diagnose()},
        }
    except Exception as exc:  # noqa: BLE001 - a status probe must not fail the endpoint
        return {"models": {"error": f"{type(exc).__name__}: {exc}"}}


def _image_info(img: Any) -> dict[str, Any]:
    return {"path": str(img.path), "sha256": img.sha256, "w": img.size[0], "h": img.size[1]}


def _png_b64(mask: Any) -> str:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.fromarray((mask.astype("uint8")) * 255).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _ndjson(
    service: VisionService,
    req: PhotoRequest,
    pipeline: Callable[[VisionService, Any, Callable[[dict[str, Any]], None], threading.Event], dict[str, Any]],
    name: str,
) -> Iterator[bytes]:
    """Run a pipeline in a worker thread; yield its events as they happen. Closing the stream cancels the run."""
    events: queue.Queue[dict[str, Any] | None] = queue.Queue()
    cancel = threading.Event()

    def work() -> None:
        try:
            result = pipeline(service, req, events.put, cancel)
            events.put({"event": "result", "result": result})
        except Exception as exc:  # noqa: BLE001 - every failure becomes one structured `error` line
            events.put({"event": "error", **error_json_for(exc)[0]})
        finally:
            events.put(None)

    thread = threading.Thread(target=work, name=name, daemon=True)
    thread.start()
    try:
        while True:
            item = events.get()
            if item is None:
                return
            yield (json.dumps(item, separators=(",", ":"), default=str) + "\n").encode("utf-8")
    finally:
        cancel.set()


app = create_app()
