"""Shared fakes: engines for the ModelManager and stage fakes for the service (no torch, no models, no GPU)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image as PilImage

from hsw_vision.config import VisionConfig
from hsw_vision.manager import EngineSpec, ModelManager
from hsw_vision.service import Stages, VisionService
from hsw_vision.stages import segment as stage_segment

IMAGE_W, IMAGE_H = 240, 160


class FakeEngine:
    """Same lifecycle as the library classes: load/unload/loaded/device/vram_estimate_mb."""

    def __init__(self, name: str, device: str, vram: int, log: list[str], fail: Exception | None = None) -> None:
        self.name = name
        self.device = device
        self.vram_estimate_mb = vram
        self.loaded = False
        self.log = log
        self.fail = fail

    def load(self) -> None:
        self.log.append(f"load {self.name} {self.device}")
        if self.fail is not None and self.device == "cuda":
            raise self.fail
        self.loaded = True

    def unload(self) -> None:
        self.log.append(f"unload {self.name}")
        self.loaded = False


class Gpu:
    """A mutable fake card: engines loaded on `cuda` take their estimate out of `free_mb`."""

    def __init__(self, free_mb: int | None) -> None:
        self.free_mb = free_mb

    def __call__(self) -> int | None:
        return self.free_mb


def make_manager(
    gpu: Gpu,
    log: list[str],
    *,
    budget: int = 3000,
    headroom: int = 400,
    device: str = "auto",
    engines: dict[str, int] | None = None,
    fail: dict[str, Exception] | None = None,
    requires: dict[str, tuple[str, ...]] | None = None,
    clock: Any = None,
) -> ModelManager:
    sizes = engines or {"a": 1000, "b": 1000, "c": 1000}
    fail = fail or {}
    requires = requires or {}

    class Tracked(FakeEngine):
        def load(self) -> None:
            super().load()
            if self.device == "cuda" and gpu.free_mb is not None:
                gpu.free_mb -= self.vram_estimate_mb

        def unload(self) -> None:
            was_loaded = self.loaded
            super().unload()
            if was_loaded and self.device == "cuda" and gpu.free_mb is not None:
                gpu.free_mb += self.vram_estimate_mb

    def spec(name: str, vram: int) -> EngineSpec:
        return EngineSpec(
            name,
            lambda device, name=name, vram=vram: Tracked(name, device, vram, log, fail.get(name)),
            vram,
            requires=requires.get(name, ()),
        )

    kwargs: dict[str, Any] = {} if clock is None else {"clock": clock}
    return ModelManager(
        specs={n: spec(n, v) for n, v in sizes.items()},
        device=device,
        vram_budget_mb=budget,
        vram_headroom_mb=headroom,
        free_vram_fn=gpu,
        **kwargs,
    )


# ---- service fakes -------------------------------------------------------------------------------------------


def write_photo(directory: Path, name: str = "photo.png") -> Path:
    rgb = np.full((IMAGE_H, IMAGE_W, 3), 90, np.uint8)
    rgb[20:50, 20:200] = (200, 60, 60)  # a long thin "tool"
    rgb[80:140, 30:90] = (60, 200, 60)  # a stubby one
    path = directory / name
    PilImage.fromarray(rgb).save(path)
    return path


def raw_instances() -> dict[str, Any]:
    long_mask = np.zeros((IMAGE_H, IMAGE_W), bool)
    long_mask[20:50, 20:200] = True
    short_mask = np.zeros((IMAGE_H, IMAGE_W), bool)
    short_mask[80:140, 30:90] = True
    tiny = np.zeros((IMAGE_H, IMAGE_W), bool)
    tiny[150:154, 150:154] = True
    instances = []
    for ident, mask, bg in ((1, long_mask, 0.02), (2, short_mask, 0.05), (3, tiny, 0.0)):
        ys, xs = np.nonzero(mask)
        instances.append(
            {
                "id": ident,
                "source": "amg",
                "bbox_xywh": [int(xs.min()), int(ys.min()), int(np.ptp(xs) + 1), int(np.ptp(ys) + 1)],
                "area_px": int(mask.sum()),
                "bg_prob": bg,
                "stability": 0.9,
                "mask": mask,
            }
        )
    return {"instances": instances, "method": "fake", "device": "cpu", "timing_s": {"total": 0.01}, "vram_mb": 0}


class Calls:
    def __init__(self) -> None:
        self.segment = 0
        self.calibrate = 0
        self.fit: list[dict[str, Any]] = []
        self.recognise = 0
        self.check = 0
        self.colours = 0
        self.overlay = 0
        self.embed = 0


def fake_calibration(mm_per_px: float = 1.0, method: str = "two-point") -> dict[str, Any]:
    f = 400.0
    depth = f * mm_per_px
    return {
        "ok": True,
        "method": method,
        "image": {"w": IMAGE_W, "h": IMAGE_H},
        "mm_per_px": mm_per_px,
        "plane_depth_mm": depth,
        "f_px": f,
        "camera": {
            "K": [[f, 0, IMAGE_W / 2], [0, f, IMAGE_H / 2], [0, 0, 1]],
            "R": [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
            "t_mm": [0, 0, depth],
        },
        "homography_px_to_plane_mm": None,
        "core": {"method": method, "mmPerPx": mm_per_px, "focalPx": f},
    }


def fake_fit(mask: np.ndarray, camera: Any, *, fixed_dims: dict[str, float] | None = None, **_: Any) -> dict[str, Any]:
    ys, xs = np.nonzero(mask)
    length = float((xs.max() - xs.min() + 1) * camera.mm_per_px)
    width = float((ys.max() - ys.min() + 1) * camera.mm_per_px)
    dims = {"length_mm": length, "max_width_mm": width, "thickness_mm": width * 0.6}
    if fixed_dims:
        dims["length_mm"] = fixed_dims.get("length", dims["length_mm"])
    return {
        "kind": "box",
        "method": "closed_form",
        "device": "cpu",
        "tries": 1,
        "timing_s": {"refine": 0.001},
        "dims_mm": dims,
        "pose": {"R0": np.eye(3).tolist(), "t_mm": [0.0, 0.0, 10.0], "axis": [1, 0, 0]},
        "confidence": {"train_min_iou": 0.93, "heldout_iou": None, "n_views": 1, "status": "single_view"},
        "views": [{"iou": 0.93}],
        "centre_px": [float(xs.mean()), float(ys.mean())],
    }


def make_service(
    tmp_path: Path, calls: Calls | None = None, assist: Any = None, **config_overrides: Any
) -> tuple[VisionService, Calls]:
    calls = calls or Calls()
    config = VisionConfig(
        models_dir=tmp_path / "models",
        cache_dir=tmp_path / "cache",
        state_path=tmp_path / "state.json",
        device="cpu",
        **config_overrides,
    )

    def segment(rgb: np.ndarray, out_dir: Path, *, files_prefix: str = "", **_: Any) -> dict[str, Any]:
        calls.segment += 1
        return stage_segment.describe(rgb, raw_instances(), out_dir, files_prefix=files_prefix)

    def calibrate(rgb: np.ndarray, **kwargs: Any) -> dict[str, Any]:
        calls.calibrate += 1
        if kwargs.get("mode") in ("auto", "two-point") and kwargs.get("points_px") and kwargs.get("distance_mm"):
            (x1, y1), (x2, y2) = kwargs["points_px"]
            px = float(np.hypot(x2 - x1, y2 - y1))
            return fake_calibration(kwargs["distance_mm"] / px, "two-point")
        if kwargs.get("mm_per_px"):
            return fake_calibration(kwargs["mm_per_px"], "manual")
        return {"ok": False, "needs": "scale", "method": None, "message": "no grid and no manual scale", "image": {"w": IMAGE_W, "h": IMAGE_H}}

    def recognise(rgb: np.ndarray, instances: list[dict[str, Any]], masks: Any, **_: Any) -> dict[str, Any]:
        calls.recognise += 1
        objects = {}
        for inst in instances:
            cls = "screwdriver" if inst["id"] == 1 else "pliers"
            objects[str(inst["id"])] = {
                "tool_class": cls,
                "label": cls,
                "score": 28.0,
                "prob": 0.8,
                "topk": [{"tool_class": cls, "label": cls, "score": 28.0}],
                "bank_topk": [],
                "calibrated": True,
            }
        return {"classes": ["screwdriver", "pliers"], "objects": objects}

    def fit_mask(mask: np.ndarray, camera: Any, **kwargs: Any) -> dict[str, Any]:
        calls.fit.append({"mm_per_px": camera.mm_per_px, **{k: v for k, v in kwargs.items() if k in ("fixed_dims", "device")}})
        return fake_fit(mask, camera, **kwargs)

    def write_glb(fit: dict[str, Any], path: Path) -> dict[str, float]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"glTF-fake")
        return {"heading_deg": 0.0, "x": 1.0, "y": 2.0, "z": 3.0}

    def check_fit(fit: dict[str, Any], views: list[dict[str, Any]], *, flag_below: float) -> dict[str, Any]:
        calls.check += 1
        return {
            "views": [],
            "min_iou": None,
            "status": "unverified",
            "needs_views": [{"azimuth_deg": 60.0, "elevation_deg": 30.0}],
        }

    def sample_colours(rgb: np.ndarray, mask: np.ndarray, fit: dict[str, Any] | None = None, **_: Any) -> dict[str, Any]:
        calls.colours += 1
        mean = rgb[mask].mean(axis=0)
        hex_colour = "#%02x%02x%02x" % tuple(int(v) for v in mean)
        part = {"t0": 0.0, "t1": 1.0, "colour_srgb": [int(v) for v in mean], "hex": hex_colour, "lab": [50.0, 0.0, 0.0],
                "area_frac": 1.0, "n_pixels": int(mask.sum()), "role_guess": "body"}  # fmt: skip
        return {"parts": [part], "palette": [{k: part[k] for k in ("colour_srgb", "hex", "lab", "area_frac")}], "axis_deg": 0.0}

    def axis_and_profile(mask: np.ndarray, mm_per_px: float | None) -> tuple[dict[str, Any], dict[str, Any] | None]:
        ys, xs = np.nonzero(mask)
        pts = np.c_[xs, ys].astype(float)
        centre = pts.mean(axis=0)
        axis = np.linalg.svd(pts - centre, full_matrices=False)[2][0]
        deg = float(np.degrees(np.arctan2(axis[1], axis[0])))
        info = {"deg": deg, "unit": axis.tolist(), "centerPx": centre.tolist()}
        if mm_per_px is None:
            return info, None
        length = float(np.ptp(pts @ axis)) * mm_per_px
        stations = [{"t": t, "lo_mm": -1.0, "hi_mm": 1.0} for t in (0.0, 0.5, 1.0)]
        return info, {"kind": "box", "length_mm": length, "max_width_mm": 2.0, "stations": stations, "iou_recon": 0.95}

    def embed_objects(manager: Any, rgb: np.ndarray, masks: list[np.ndarray]) -> np.ndarray:
        calls.embed += 1
        rows = np.stack([np.resize(np.array([float(m.sum()), float(i + 1)]), 512) for i, m in enumerate(masks)]) if masks else np.zeros((0, 512))
        return (rows / np.maximum(np.linalg.norm(rows, axis=1, keepdims=True), 1e-9)).astype(np.float32) if masks else rows.astype(np.float32)

    def embed_images(manager: Any, images: list[np.ndarray]) -> np.ndarray:
        rows = np.stack([np.resize(np.array([float(im.mean()), 1.0]), 512) for im in images])
        return (rows / np.linalg.norm(rows, axis=1, keepdims=True)).astype(np.float32)

    def render_overlay(rgb: np.ndarray, items: list[Any], camera: Any) -> np.ndarray:
        calls.overlay += 1
        return rgb

    stages = Stages(
        calibrate=calibrate,
        segment=segment,
        recognise=recognise,
        fit_mask=fit_mask,
        write_glb=write_glb,
        check_fit=check_fit,
        colours_available=lambda: True,
        sample_colours=sample_colours,
        render_overlay=render_overlay,
        axis_and_profile=axis_and_profile,
        embed_objects=embed_objects,
        embed_images=embed_images,
    )
    manager = make_manager(Gpu(None), [])
    return VisionService(config=config, manager=manager, stages=stages, assist=assist), calls
