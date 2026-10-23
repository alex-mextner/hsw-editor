"""VisionService: the cached, individually callable stages. HTTP, the CLI and the orchestrator all go through it.

Stages are injected (`Stages`) so tests drive the whole service with fakes; the defaults are the real modules,
which only call `threed_vision`. Every result is cached by image sha256 + parameters under the work directory.
"""

from __future__ import annotations

import shutil
import threading
import uuid
import weakref
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
from hsw_vision.errors import BadRequest, CalibrationNeeded, Cancelled, VisionServiceError, translate_library_error
from hsw_vision.geometry import Camera, camera_from_calibration
from hsw_vision.manager import ModelManager
from hsw_vision.schemas import CalibrateParams, GeneratedView, ImageRef, SegmentParams
from hsw_vision.stages import appearance as stage_appearance
from hsw_vision.stages import calibrate as stage_calibrate
from hsw_vision.stages import embed as stage_embed
from hsw_vision.stages import fit as stage_fit
from hsw_vision.stages import multiview as stage_multiview
from hsw_vision.stages import prompt as stage_prompt
from hsw_vision.stages import recognise as stage_recognise
from hsw_vision.stages import segment as stage_segment
from hsw_vision.stages import shape as stage_shape

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
    check_generated: Callable[..., list[dict[str, Any]]] = stage_multiview.check_generated
    colours_available: Callable[[], bool] = stage_appearance.available
    sample_colours: Callable[..., dict[str, Any]] = stage_appearance.sample_colours
    render_overlay: Callable[..., np.ndarray] = stage_fit.render_overlay
    axis_and_profile: Callable[..., Any] = stage_shape.axis_and_profile
    embed_objects: Callable[..., np.ndarray] = stage_embed.embed_objects
    embed_images: Callable[..., np.ndarray] = stage_embed.embed_images
    embed_objects_dino: Callable[..., np.ndarray] = stage_embed.embed_objects_dino
    prompt_mask: Callable[..., dict[str, Any]] = stage_prompt.prompt_mask


def _load_rgb(path: Path) -> np.ndarray:
    from threed_vision import io as tv_io

    return tv_io.load_rgb(path)


def segmentation_digest(segmentation: dict[str, Any]) -> str:
    """Identity of a segmentation's CONTENT (instance ids, boxes, areas). The proposal ids use this alone: they must
    stay stable when the same objects are segmented again into another directory."""
    return params_hash([(i["id"], i["bbox_xywh"], i["area_px"]) for i in segmentation["instances"]])[:12]


def segmentation_identity(segmentation: dict[str, Any]) -> list[str]:
    """Cache identity of a segmentation: WHERE its masks live plus WHAT is in them. Two runs can agree on the content
    (same ids/boxes/areas) with different masks (another method), and a refresh can renumber instances into a reused
    directory name, so neither part alone keys a recognise/fit result safely."""
    return [segmentation["dir"], segmentation_digest(segmentation)]


#: Every `Image` that is alive, i.e. every request in flight (the handler drops its `Image` when the response is done).
_LIVE_IMAGES: weakref.WeakSet[Image] = weakref.WeakSet()
#: Requests run on a thread pool: registering an `Image` and walking the set must not interleave.
_LIVE_IMAGES_GUARD = threading.Lock()


def _pinned_segmentations(image_dir: Path) -> set[Path]:
    """Mask directories of `image_dir` that an in-flight request still reads (it obtained the segmentation from
    `VisionService.segment`, which pins the directory on its `Image`)."""
    with _LIVE_IMAGES_GUARD:
        return {image_dir / name for live in _LIVE_IMAGES if live.dir == image_dir for name in tuple(live.pinned)}


def _prune_segmentations(image_dir: Path, prefix: str, keep: int) -> None:
    """Delete all but the `keep` newest `<prefix>*` mask directories (an interrupted run's leftovers age out too).
    A directory an in-flight request holds is never deleted, however many refreshes happened meanwhile."""
    runs = sorted((p for p in image_dir.glob(f"{prefix}*") if p.is_dir()), key=lambda p: p.stat().st_mtime, reverse=True)
    pinned = _pinned_segmentations(image_dir)
    for stale in runs[keep:]:
        if stale not in pinned:
            shutil.rmtree(stale, ignore_errors=True)


def library_version() -> str:
    try:
        return metadata.version("threed-vision")
    except metadata.PackageNotFoundError:
        return "unknown"


@dataclass(eq=False)
class Image:
    """A photo opened for processing: pixels are decoded once, results cached next to the wall."""

    path: Path
    sha256: str
    rgb: np.ndarray
    cache: ResultCache
    refresh: bool = False
    #: Stage results already recomputed for this `refresh` run: a refresh recomputes each stage ONCE, however many
    #: later stages ask for it again (calibrate-by-reference and the pipeline both need the segmentation).
    refreshed: set[str] = field(default_factory=set)
    #: Mask directories (names under `dir`) of the segmentations this request obtained: pruning leaves them alone while
    #: the request (this object) is alive.
    pinned: set[str] = field(default_factory=set)

    def __post_init__(self) -> None:
        with _LIVE_IMAGES_GUARD:
            _LIVE_IMAGES.add(self)

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
    #: Set once the DINOv2 model proved to be absent: later analyses skip it instead of making room for an engine that cannot
    #: load (which would unload SAM2 for nothing). Cleared by restarting the service after `hsw-editor vision fetch-models`.
    dino_missing: bool = False

    @classmethod
    def create(cls, config: VisionConfig, **overrides: Any) -> VisionService:
        config.apply_to_environment()
        manager = overrides.pop("manager", None) or build_manager(config)
        assist = overrides.pop("assist", None) or build_assist(config)
        return cls(config=config, manager=manager, assist=assist, **overrides)

    # ---- images ----------------------------------------------------------------------------------------

    def read_photo(self, path: Path | str) -> tuple[Path, np.ndarray]:
        """A decoded photo, or `bad_request` (422) when it is not a readable image: every photo the service reads,
        the main one and the extra views, goes through here."""
        resolved = Path(path).expanduser()
        if not resolved.is_file():
            raise BadRequest(f"image not found: {resolved}")
        try:
            return resolved, self.loader(resolved)
        except VisionServiceError:
            raise
        except Exception as exc:  # noqa: BLE001 - any decoder failure is the caller's bad input, not a 500
            translated = translate_library_error(exc)
            if translated is not None:
                raise translated from exc
            raise BadRequest(f"cannot read image {resolved}: {type(exc).__name__}: {exc}") from exc

    def open(self, ref: ImageRef) -> Image:
        path, rgb = self.read_photo(ref.image_path)
        cache = ResultCache(ref.work_dir or self.config.cache_dir, version=library_version())
        return Image(path=path, sha256=file_sha256(path), rgb=rgb, cache=cache, refresh=ref.refresh)

    def _cached(
        self, img: Image, stage: str, key: Any, compute: Callable[[], dict[str, Any]]
    ) -> tuple[dict[str, Any], bool]:
        """`ResultCache.get_or_compute` honouring `img.refresh` once per stage result."""
        token = f"{stage}:{params_hash(key)}"
        result, cached = img.cache.get_or_compute(
            img.sha256, stage, key, compute, refresh=img.refresh and token not in img.refreshed
        )
        img.refreshed.add(token)
        return result, cached

    # ---- stages (cached) -------------------------------------------------------------------------------

    def segment(
        self, img: Image, params: SegmentParams, emit: Emit = _noop, cancel: threading.Event | None = None
    ) -> dict[str, Any]:
        """Instances of the photo. Every computation writes its masks into a NEW directory
        (`seg-<params>-<run id>`), never into one a concurrent reader may be decoding: the result JSON points at it
        only once complete, and older runs of the same parameters are pruned (the newest two are kept)."""
        key = params.model_dump(mode="json")
        digest = params_hash(key, version=library_version())[:12]

        def compute() -> dict[str, Any]:
            prefix = f"seg-{digest}-{uuid.uuid4().hex[:8]}/"

            def progress(stage: str, fraction: float) -> None:
                if cancel is not None and cancel.is_set():
                    raise Cancelled("segmentation cancelled")
                emit({"event": "progress", "stage": "segment", "message": stage, "fraction": fraction})

            with self.run_lock:
                if cancel is not None and cancel.is_set():
                    raise Cancelled("segmentation cancelled")
                result = self.stages.segment(
                    img.rgb, img.dir / prefix, manager=self.manager, progress=progress, files_prefix=prefix, **key
                )
            result["dir"] = prefix.rstrip("/")
            _prune_segmentations(img.dir, f"seg-{digest}-", keep=2)
            return result

        result, cached = self._cached(img, "segment", key, compute)
        img.pinned.add(result["dir"])
        return {**result, "cached": cached}

    def masks(self, img: Image, segmentation: dict[str, Any], only: Iterable[int] | None = None) -> dict[int, np.ndarray]:
        """Decoded masks of a segmentation (only the ids in `only`; decoding all of them per object is O(n^2))."""
        return self.stages.load_masks(segmentation, img.dir / segmentation["dir"], only=only)

    def calibrate(
        self,
        img: Image,
        params: CalibrateParams,
        segment: SegmentParams | None = None,
        emit: Emit = _noop,
        cancel: threading.Event | None = None,
    ) -> dict[str, Any]:
        """Scale/camera of the photo. `ok: false` + `needs: "scale"` when nothing established one."""
        seg_key = segment.model_dump(mode="json") if (params.reference_instance is not None and segment) else None
        key = {"calibrate": params.model_dump(mode="json"), "segment": seg_key}

        def compute() -> dict[str, Any]:
            reference_mask = None
            if params.reference_instance is not None:
                if segment is None:
                    raise BadRequest("reference calibration needs segment parameters")
                seg = self.segment(img, segment, emit, cancel)
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

        result, cached = self._cached(img, "calibrate", key, compute)
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
        categories: str | None = None,
        classes: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Classes of the given instances: CLIP text prompts over `classes` (a ready vocabulary, which an edit takes from
        the stored run), else `categories` (a library-readable file / comma list), else the bank index's tool classes,
        else the built-in vocabulary."""
        classes = classes or stage_recognise.resolve_classes(bank_index, categories)
        key = {
            "seg": segmentation_identity(segmentation),
            "instances": sorted(instance_ids),
            "classes": classes,
            "topk": topk,
        }

        def compute() -> dict[str, Any]:
            masks = self.masks(img, segmentation, only=instance_ids)
            wanted = [i for i in segmentation["instances"] if i["id"] in set(instance_ids)]
            with self.run_lock:
                return self.stages.recognise(
                    img.rgb, wanted, masks, manager=self.manager, classes=classes, topk=topk
                )

        result, cached = self._cached(img, "recognise", key, compute)
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
            "seg": segmentation_identity(segmentation),
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
                    manager=self.manager,
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

        result, cached = self._cached(img, f"fit-{instance_id}", key, compute)
        return {**result, "cached": cached}

    def check(self, fit: dict[str, Any], views: list[dict[str, Any]], flag_below: float) -> dict[str, Any]:
        views = stage_multiview.resolve_views(views)  # mask files are decoded before the lock: disk I/O must not hold the GPU
        with self.run_lock:
            return self.stages.check_fit(fit, views, flag_below=flag_below)

    def check_generated(
        self, fit: dict[str, Any], views: list[GeneratedView], flag_below: float
    ) -> list[dict[str, Any]]:
        """Agreement of the fit with DRAWN views (hints, never the confidence): see `stages.multiview.check_generated`."""
        if not views:
            return []
        items = []
        for view in views:
            image = stage_multiview.load_drawing(view.image_path)
            items.append(
                {"image": image, "view": view.view, "azimuth_deg": view.azimuth_deg, "elevation_deg": view.elevation_deg, "name": view.name}
            )
        with self.run_lock:
            return self.stages.check_generated(fit, items, flag_below=flag_below)

    def status(self) -> dict[str, Any]:
        return {"manager": self.manager.status(), "libraryVersion": library_version()}
