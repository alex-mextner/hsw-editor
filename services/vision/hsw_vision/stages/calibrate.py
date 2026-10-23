"""Calibrate stage: photo -> camera + scale. JSON in, JSON out; every number comes from `threed_vision.calibrate`.

Order in `auto` mode (a stage may be forced with `mode`): honeycomb grid detector, then the user's two-point scale,
then a reference object of known length (a bank object / measured tool), then a plain `mm_per_px`.
Without a grid there is no pose: the camera is assumed to look straight down on the plane (carpet/desk photo).
"""

from __future__ import annotations

from typing import Any

import numpy as np

from hsw_vision.errors import BadRequest
from hsw_vision.geometry import fronto_parallel_extrinsics

MODES = ("auto", "grid", "two-point", "reference", "manual")
DEFAULT_F_RATIO = 0.375  # phone main camera: f = 0.375 * image diagonal (measured on the HSW photos)


def _lib() -> Any:
    from threed_vision import calibrate

    return calibrate


def _jsonable(value: Any) -> Any:
    from threed_vision.io import to_jsonable

    return to_jsonable(value)


def calibrate(
    rgb: np.ndarray,
    *,
    mode: str = "auto",
    grid_pitch_mm: tuple[float, float] | None = None,
    f_px: float | None = None,
    f_ratio: float | None = None,
    points_px: list[list[float]] | None = None,
    distance_mm: float | None = None,
    reference_mask: np.ndarray | None = None,
    reference_length_mm: float | None = None,
    mm_per_px: float | None = None,
) -> dict[str, Any]:
    """Returns `{"ok", "method", "mm_per_px", "plane_depth_mm", "f_px", "camera": {K,R,t_mm}, ...}`.

    `ok` is False (with `needs: "scale"`) when nothing could establish a scale; that is the signal to open the
    two-point calibration widget, not an exception.
    """
    if mode not in MODES:
        raise BadRequest(f"unknown calibration mode {mode!r}; use one of {', '.join(MODES)}")
    h, w = rgb.shape[:2]
    lib = _lib()
    tried: list[str] = []

    if mode in ("auto", "grid"):
        kwargs: dict[str, Any] = {}
        if grid_pitch_mm is not None:
            kwargs["grid_pitch_mm"] = tuple(grid_pitch_mm)
        if f_px is not None:
            kwargs["f_px"] = f_px
        if f_ratio is not None:
            kwargs["f_ratio"] = f_ratio
        grid = lib.detect_grid(rgb, **kwargs)
        if grid.get("ok"):
            return _from_grid(grid, w, h)
        tried.append(f"grid: {grid.get('reason') or 'no grid found'}")
        if mode == "grid":
            return _needs_scale(w, h, tried)

    scale_kwargs: dict[str, Any] = {"image_size": (w, h)}
    if f_px is not None:
        scale_kwargs["f_px"] = f_px
    scale_kwargs["f_ratio"] = f_ratio if f_ratio is not None else DEFAULT_F_RATIO

    if mode in ("auto", "two-point") and points_px is not None and distance_mm is not None:
        if len(points_px) != 2:
            raise BadRequest("two-point calibration needs exactly two points [[x, y], [x, y]]")
        if distance_mm <= 0:
            raise BadRequest("distance_mm must be positive")
        scale = lib.scale_from_points(points_px[0], points_px[1], distance_mm, **scale_kwargs)
        return _from_scale(scale, "two-point", w, h, extra={"points_px": points_px, "distance_mm": distance_mm})
    if mode == "two-point":
        raise BadRequest("two-point calibration needs points_px and distance_mm")

    if mode in ("auto", "reference") and reference_mask is not None and reference_length_mm is not None:
        scale = lib.scale_from_reference(reference_mask, reference_length_mm, **scale_kwargs)
        return _from_scale(scale, "reference", w, h, extra={"reference_length_mm": reference_length_mm})
    if mode == "reference":
        raise BadRequest("reference calibration needs reference_mask and reference_length_mm")

    if mode in ("auto", "manual") and mm_per_px is not None:
        if mm_per_px <= 0:
            raise BadRequest("mm_per_px must be positive")
        k = np.asarray(lib.default_intrinsics(w, h, f_px=f_px, f_ratio=scale_kwargs["f_ratio"]), dtype=float)
        scale = {"mm_per_px": mm_per_px, "plane_depth_mm": float(k[0, 0]) * mm_per_px, "K": k, "f_px": float(k[0, 0])}
        return _from_scale(scale, "manual", w, h, extra={})
    if mode == "manual":
        raise BadRequest("manual calibration needs mm_per_px")

    return _needs_scale(w, h, tried)


def _needs_scale(w: int, h: int, tried: list[str]) -> dict[str, Any]:
    return {
        "ok": False,
        "needs": "scale",
        "method": None,
        "image": {"w": w, "h": h},
        "tried": tried,
        "message": "no grid found and no manual scale given: pick two points and enter their real distance",
    }


def _from_grid(grid: dict[str, Any], w: int, h: int) -> dict[str, Any]:
    h_px = np.asarray(grid["homography_px_to_grid_mm"], dtype=float).reshape(3, 3)
    centre_mm_per_px = grid.get("mm_per_px_centre")
    if centre_mm_per_px is None:
        centre_mm_per_px = float(_lib().local_mm_per_px(h_px, [w / 2, h / 2]))
    t = np.asarray(grid["t_mm"], dtype=float)
    r = np.asarray(grid["R"], dtype=float)
    centre = h_px @ np.array([w / 2, h / 2, 1.0])  # plane point seen at the image centre
    cx, cy = centre[:2] / centre[2]
    depth = float(r[2, 0] * cx + r[2, 1] * cy + t[2])
    result: dict[str, Any] = {
        "ok": True,
        "method": "grid",
        "image": {"w": w, "h": h},
        "mm_per_px": float(centre_mm_per_px),
        "plane_depth_mm": depth,
        "f_px": float(grid["f_px"]),
        "f_source": grid.get("f_source"),
        "camera": {"K": np.asarray(grid["K"], dtype=float).tolist(), "R": r.tolist(), "t_mm": t.tolist()},
        "homography_px_to_plane_mm": h_px.reshape(-1).tolist(),
        "reproj_median_px": grid.get("reproj_median_px"),
        "reproj_p95_px": grid.get("reproj_p95_px"),
        "n_cells": grid.get("n_cells"),
        "n_inliers": grid.get("n_inliers"),
        "quality": list(grid.get("quality") or []),
        # The photo cannot tell where the board corner is: cell (0, 0) is the min inlier cell, see docs/vision.md.
        "grid_origin": "min-inlier-cell",
        "timing_s": grid.get("timing_s"),
    }
    result["core"] = core_calibration(result)
    return _jsonable(result)


def _from_scale(scale: dict[str, Any], method: str, w: int, h: int, extra: dict[str, Any]) -> dict[str, Any]:
    r, t = fronto_parallel_extrinsics(float(scale["plane_depth_mm"]))
    result: dict[str, Any] = {
        "ok": True,
        "method": method,
        "image": {"w": w, "h": h},
        "mm_per_px": float(scale["mm_per_px"]),
        "plane_depth_mm": float(scale["plane_depth_mm"]),
        "f_px": float(scale["f_px"]),
        "f_source": scale.get("f_source"),
        "camera": {"K": np.asarray(scale["K"], dtype=float).tolist(), "R": r.tolist(), "t_mm": t.tolist()},
        "homography_px_to_plane_mm": None,
        "quality": list(scale.get("quality") or []),
        **extra,
    }
    result["core"] = core_calibration(result)
    return _jsonable(result)


_CORE_METHOD = {"grid": "grid", "two-point": "two-point", "manual": "manual", "reference": "vision"}


def core_calibration(result: dict[str, Any]) -> dict[str, Any]:
    """The `Calibration` object of `packages/core` (`setCalibration` op payload)."""
    core: dict[str, Any] = {
        "method": _CORE_METHOD[result["method"]],
        "mmPerPx": result["mm_per_px"],
        "focalPx": result["f_px"],
    }
    if result.get("homography_px_to_plane_mm"):
        core["homography"] = list(result["homography_px_to_plane_mm"])
    if result.get("reproj_median_px") is not None:
        core["reprojErrorPx"] = result["reproj_median_px"]
    return core
