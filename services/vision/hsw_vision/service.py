"""VisionService: the cached, individually callable stages. HTTP, the CLI and the orchestrator all go through it.

Stages are injected (`Stages`) so tests drive the whole service with fakes; the defaults are the real modules,
which only call `threed_vision`. Every result is cached by image sha256 + parameters under the work directory.
"""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

import numpy as np

from hsw_vision.ai_assist import AiAssist, build_assist
from hsw_vision.cache import ResultCache, file_sha256, params_hash
from hsw_vision.config import VisionConfig
from hsw_vision.engines import build_manager
from hsw_vision.errors import BadRequest, CalibrationNeeded
from hsw_vision.geometry import Camera, camera_from_calibration
from hsw_vision.manager import ModelManager
from hsw_vision.schemas import CalibrateParams, ImageRef, SegmentParams
from hsw_vision.stages import calibrate as stage_calibrate
from hsw_vision.stages import fit as stage_fit
from hsw_vision.stages import multiview as stage_multiview
from hsw_vision.stages import recognise as stage_recognise
from hsw_vision.stages import segment as stage_segment

Emit = Callable[[dict[str, Any]], None]


def _noop(_: dict[str, Any]) -> None:
    return None


@dataclass(frozen=True)
class Stages:
    calibrate: Callable[..., dict[str, Any]] = stage_calibrate.calibrate
    segment: Callable[..., dict[str, Any]] = stage_segment.segment
    load_masks: Callable[..., dict[int, np.ndarray]] = stage_segment.load_masks
    recognise: Callable[..., dict[str, Any]] = stage_recognise.recognise
    fit_mask: Callable[..., dict[str, Any]] = stage_fit.fit_mask
    write_glb: Callable[[dict[str, Any], Path], dict[str, float]] = stage_fit.write_glb
    check_fit: Callable[..., dict[str, Any]] = stage_multiview.check_fit
    register_views: Callable[..., dict[str, Any]] = stage_multiview.register_views


def _load_rgb(path: Path) -> np.ndarray:
    from threed_vision import io as tv_io

    return tv_io.load_rgb(path)


def segmentation_digest(segmentation: dict[str, Any]) -> str:
    """Identity of a segmentation's CONTENT: a refresh into the same seg-<params> dir can renumber instances, so the
    dir name alone must not key recognise/fit results or proposal ids."""
    return params_hash([(i["id"], i["bbox_xywh"], i["area_px"]) for i in segmentation["instances"]])[:12]


def library_version() -> str:
    try:
        return metadata.version("threed-vision")
    except metadata.PackageNotFoundError:
        return "unknown"


@dataclass
class Image:
    """A photo opened for processing: pixels are decoded once, results cached next to the wall."""

    path: Path
    sha256: str
    rgb: np.ndarray
    cache: ResultCache
    refresh: bool = False

    @property
    def size(self) -> tuple[int, int]:
        return int(self.rgb.shape[1]), int(self.rgb.shape[0])

    @property
    def dir(self) -> Path:
        return self.cache.image_dir(self.sha256)


@dataclass
class VisionService:
    config: VisionConfig
    manager: ModelManager
    stages: Stages = field(default_factory=Stages)
    assist: AiAssist | None = None
    loader: Callable[[Path], np.ndarray] = _load_rgb
    #: Serialises heavy stage work: one GPU, and the models are not re-entrant.
    run_lock: threading.Lock = field(default_factory=threading.Lock)

    @classmethod
    def create(cls, config: VisionConfig, **overrides: Any) -> VisionService:
        config.apply_to_environment()
        manager = overrides.pop("manager", None) or build_manager(config)
        assist = overrides.pop("assist", None) or build_assist(config)
        return cls(config=config, manager=manager, assist=assist, **overrides)

    # ---- images ----------------------------------------------------------------------------------------

    def open(self, ref: ImageRef) -> Image:
        path = Path(ref.image_path).expanduser()
        if not path.is_file():
            raise BadRequest(f"image not found: {path}")
        cache = ResultCache(ref.work_dir or self.config.cache_dir, version=library_version())
        return Image(path=path, sha256=file_sha256(path), rgb=self.loader(path), cache=cache, refresh=ref.refresh)

    # ---- stages (cached) -------------------------------------------------------------------------------

    def segment(self, img: Image, params: SegmentParams, emit: Emit = _noop) -> dict[str, Any]:
        key = params.model_dump(mode="json")
        digest = params_hash(key, version=library_version())[:12]
        prefix = f"seg-{digest}/"

        def compute() -> dict[str, Any]:
            def progress(stage: str, fraction: float) -> None:
                emit({"event": "progress", "stage": "segment", "message": stage, "fraction": fraction})

            with self.run_lock:
                result = self.stages.segment(
                    img.rgb, img.dir / prefix, manager=self.manager, progress=progress, files_prefix=prefix, **key
                )
            result["dir"] = prefix.rstrip("/")
            return result

        result, cached = img.cache.get_or_compute(img.sha256, "segment", key, compute, refresh=img.refresh)
        return {**result, "cached": cached}

    def masks(self, img: Image, segmentation: dict[str, Any], only: Iterable[int] | None = None) -> dict[int, np.ndarray]:
        """Decoded masks of a segmentation (only the ids in `only`; decoding all of them per object is O(n^2))."""
        return self.stages.load_masks(segmentation, img.dir / segmentation["dir"], only=only)

    def calibrate(
        self, img: Image, params: CalibrateParams, segment: SegmentParams | None = None, emit: Emit = _noop
    ) -> dict[str, Any]:
        """Scale/camera of the photo. `ok: false` + `needs: "scale"` when nothing established one."""
        seg_key = segment.model_dump(mode="json") if (params.reference_instance is not None and segment) else None
        key = {"calibrate": params.model_dump(mode="json"), "segment": seg_key}

        def compute() -> dict[str, Any]:
            reference_mask = None
            if params.reference_instance is not None:
                if segment is None:
                    raise BadRequest("reference calibration needs segment parameters")
                seg = self.segment(img, segment, emit)
                masks = self.masks(img, seg, only=[params.reference_instance])
                if params.reference_instance not in masks:
                    raise BadRequest(f"reference instance {params.reference_instance} not found in the segmentation")
                reference_mask = masks[params.reference_instance]
            with self.run_lock:
                return self.stages.calibrate(
                    img.rgb,
                    mode=params.mode,
                    grid_pitch_mm=params.grid_pitch_mm,
                    f_px=params.f_px,
                    f_ratio=params.f_ratio,
                    points_px=[list(p) for p in params.points_px] if params.points_px else None,
                    distance_mm=params.distance_mm,
                    reference_mask=reference_mask,
                    reference_length_mm=params.reference_length_mm,
                    mm_per_px=params.mm_per_px,
                )

        result, cached = img.cache.get_or_compute(img.sha256, "calibrate", key, compute, refresh=img.refresh)
        return {**result, "cached": cached}

    def camera(self, calibration: dict[str, Any]) -> Camera:
        if not calibration.get("ok"):
            raise CalibrationNeeded(
                calibration.get("message") or "no scale: pick two points and enter their real distance",
                fix="send calibrate.points_px + calibrate.distance_mm (two-point) or calibrate.mm_per_px",
            )
        return camera_from_calibration(calibration)

    def recognise(
        self,
        img: Image,
        segmentation: dict[str, Any],
        instance_ids: list[int],
        bank_index: dict[str, Any] | None,
        topk: int = 5,
    ) -> dict[str, Any]:
        classes = stage_recognise.classes_from_bank(bank_index)
        key = {
            "seg": segmentation_digest(segmentation),
            "instances": sorted(instance_ids),
            "classes": classes,
            "bank": (bank_index or {}).get("contentHash"),
            "topk": topk,
        }

        def compute() -> dict[str, Any]:
            masks = self.masks(img, segmentation, only=instance_ids)
            wanted = [i for i in segmentation["instances"] if i["id"] in set(instance_ids)]
            with self.run_lock:
                return self.stages.recognise(
                    img.rgb, wanted, masks, manager=self.manager, bank_index=bank_index, topk=topk
                )

        result, cached = img.cache.get_or_compute(img.sha256, "recognise", key, compute, refresh=img.refresh)
        return {**result, "cached": cached}

    def fit(
        self,
        img: Image,
        segmentation: dict[str, Any],
        instance_id: int,
        calibration: dict[str, Any],
        *,
        fixed_dims: dict[str, float] | None = None,
        template: str | None = None,
        planar: bool = True,
        max_tries: int = 3,
        device: str | None = None,
        seed: int = 0,
    ) -> dict[str, Any]:
        """Fit one instance; the result includes `glb` (relative to the image dir) and `glb_pose`."""
        camera = self.camera(calibration)
        resolved_device = device or self.config.device
        key = {
            "seg": segmentation_digest(segmentation),
            "instance": instance_id,
            "cal": params_hash(calibration.get("core") or calibration.get("camera"))[:16],
            "fixed": fixed_dims,
            "template": template,
            "planar": planar,
            "tries": max_tries,
            "device": resolved_device,
            "seed": seed,
        }

        def compute() -> dict[str, Any]:
            masks = self.masks(img, segmentation, only=[instance_id])
            if instance_id not in masks:
                raise BadRequest(f"instance {instance_id} not found in the segmentation")
            with self.run_lock:
                result = self.stages.fit_mask(
                    masks[instance_id],
                    camera,
                    fixed_dims=fixed_dims,
                    template=template,
                    planar=planar,
                    device=resolved_device,
                    max_tries=max_tries,
                    seed=seed,
                )
                rel = f"models/fit-{instance_id:03d}-{params_hash(key)[:10]}.glb"
                result["glb_pose"] = self.stages.write_glb(result, img.dir / rel)
            result["glb"] = rel
            result["_files"] = [rel]
            return result

        result, cached = img.cache.get_or_compute(img.sha256, f"fit-{instance_id}", key, compute, refresh=img.refresh)
        return {**result, "cached": cached}

    def check(self, fit: dict[str, Any], views: list[dict[str, Any]], flag_below: float) -> dict[str, Any]:
        with self.run_lock:
            return self.stages.check_fit(fit, views, flag_below=flag_below)

    def status(self) -> dict[str, Any]:
        return {"manager": self.manager.status(), "libraryVersion": library_version()}
