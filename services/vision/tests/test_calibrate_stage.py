"""Calibrate stage order + manual two-point scale applied to every fit. Uses a fake `threed_vision.calibrate`."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from helpers import make_service
from hsw_vision import photo_to_wall
from hsw_vision.errors import BadRequest
from hsw_vision.geometry import camera_from_calibration
from hsw_vision.schemas import CalibrateParams, PhotoToWallRequest
from hsw_vision.stages import calibrate as stage_calibrate

RGB = np.zeros((160, 240, 3), np.uint8)


def k_of(f: float, size: tuple[int, int]) -> np.ndarray:
    return np.array([[f, 0, size[0] / 2], [0, f, size[1] / 2], [0, 0, 1.0]])


def fake_lib(grid_ok: bool) -> SimpleNamespace:
    def detect_grid(rgb: np.ndarray, **_: Any) -> dict[str, Any]:
        if not grid_ok:
            return {"ok": False, "reason": "no honeycomb found"}
        return {
            "ok": True, "K": np.diag([700.0, 700.0, 1.0]), "f_px": 700.0, "R": np.eye(3), "t_mm": np.array([0.0, 0.0, 900.0]),
            "homography_px_to_grid_mm": np.array([[0.5, 0, -60.0], [0, -0.5, 40.0], [0, 0, 1]]),
            "reproj_median_px": 0.4, "reproj_p95_px": 0.9, "n_cells": 100, "n_inliers": 90, "quality": [],
            "mm_per_px_centre": 0.5, "f_source": "estimated", "timing_s": {"total": 0.1},
        }  # fmt: skip

    def scale_from_points(p1: Any, p2: Any, distance_mm: float, *, image_size: tuple[int, int], f_px: float | None = None, f_ratio: float = 0.375) -> dict[str, Any]:
        mm_per_px = distance_mm / float(np.hypot(p2[0] - p1[0], p2[1] - p1[1]))
        f = f_px or f_ratio * float(np.hypot(*image_size))
        return {"mm_per_px": mm_per_px, "plane_depth_mm": f * mm_per_px, "K": k_of(f, image_size), "f_px": f, "source": "points"}

    def scale_from_reference(mask: np.ndarray, length_mm: float, *, image_size: tuple[int, int], f_px: float | None = None, f_ratio: float = 0.375) -> dict[str, Any]:
        ys, xs = np.nonzero(mask)
        mm_per_px = length_mm / float(np.ptp(xs) + 1)
        f = f_px or f_ratio * float(np.hypot(*image_size))
        return {"mm_per_px": mm_per_px, "plane_depth_mm": f * mm_per_px, "K": k_of(f, image_size), "f_px": f, "source": "reference"}

    def default_intrinsics(w: int, h: int, f_px: float | None = None, f_ratio: float = 0.375) -> np.ndarray:
        f = f_px or f_ratio * float(np.hypot(w, h))
        return np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1.0]])

    return SimpleNamespace(
        detect_grid=detect_grid,
        scale_from_points=scale_from_points,
        scale_from_reference=scale_from_reference,
        default_intrinsics=default_intrinsics,
        local_mm_per_px=lambda h, pt: 0.5,
    )


def test_grid_is_tried_first_and_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stage_calibrate, "_lib", lambda: fake_lib(grid_ok=True))
    result = stage_calibrate.calibrate(RGB, points_px=[[0, 0], [100, 0]], distance_mm=150)
    assert result["ok"] and result["method"] == "grid"
    assert result["core"]["method"] == "grid" and len(result["core"]["homography"]) == 9
    assert result["core"]["reprojErrorPx"] == 0.4
    assert result["plane_depth_mm"] == pytest.approx(900.0 + 0.0)  # grid plane seen at the image centre
    cam = camera_from_calibration(result)
    assert cam.px_to_plane_mm(np.array([[120.0, 80.0]]))[0].tolist() == pytest.approx([0.0, 0.0])


def test_no_grid_falls_back_to_two_point_then_reference_then_manual(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stage_calibrate, "_lib", lambda: fake_lib(grid_ok=False))
    two_point = stage_calibrate.calibrate(RGB, points_px=[[0, 0], [100, 0]], distance_mm=150)
    assert (two_point["method"], two_point["mm_per_px"]) == ("two-point", pytest.approx(1.5))
    assert two_point["core"]["method"] == "two-point" and "homography" not in two_point["core"]
    mask = np.zeros((160, 240), bool)
    mask[10:20, 10:110] = True
    reference = stage_calibrate.calibrate(RGB, reference_mask=mask, reference_length_mm=200)
    assert (reference["method"], reference["mm_per_px"]) == ("reference", pytest.approx(2.0))
    assert reference["core"]["method"] == "vision"
    manual = stage_calibrate.calibrate(RGB, mm_per_px=1.25)
    assert (manual["method"], manual["core"]["method"]) == ("manual", "manual")


def test_nothing_to_go_on_is_needs_scale_not_an_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stage_calibrate, "_lib", lambda: fake_lib(grid_ok=False))
    result = stage_calibrate.calibrate(RGB)
    assert result["ok"] is False and result["needs"] == "scale"
    assert "grid: no honeycomb found" in result["tried"]


def test_forced_modes_and_bad_input(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stage_calibrate, "_lib", lambda: fake_lib(grid_ok=False))
    assert stage_calibrate.calibrate(RGB, mode="grid", points_px=[[0, 0], [1, 0]], distance_mm=5)["ok"] is False
    for kwargs in (
        {"mode": "two-point"},
        {"mode": "two-point", "points_px": [[0, 0]], "distance_mm": 5},
        {"mode": "two-point", "points_px": [[0, 0], [1, 0]], "distance_mm": -5},
        {"mode": "reference"},
        {"mode": "manual"},
        {"mode": "nonsense"},
    ):
        with pytest.raises(BadRequest):
            stage_calibrate.calibrate(RGB, **kwargs)


def test_fronto_parallel_camera_maps_pixels_to_plane_mm_with_y_up(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stage_calibrate, "_lib", lambda: fake_lib(grid_ok=False))
    cal = stage_calibrate.calibrate(RGB, points_px=[[0, 0], [100, 0]], distance_mm=150)
    cam = camera_from_calibration(cal)
    pts = cam.px_to_plane_mm(np.array([[120.0, 80.0], [220.0, 80.0], [120.0, 30.0]]))
    np.testing.assert_allclose(pts, [[0, 0], [150, 0], [0, 75]], atol=1e-9)  # right = +x, up the photo = +y
    # a point at the plane origin projects to the principal point through (K, R, t)
    x_cam = cam.R @ np.array([150.0, 0.0, 0.0]) + cam.t
    u = cam.K @ x_cam
    assert (u[0] / u[2], u[1] / u[2]) == pytest.approx((220.0, 80.0))
    assert cam.depth_at(np.array([50.0, 20.0])) == pytest.approx(cal["plane_depth_mm"])


def test_manual_two_point_scale_is_applied_to_every_fit(tmp_path: Path, photo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    service, calls = make_service(tmp_path)
    # run the REAL calibrate stage with the fake library so the scale really comes from the two picked points
    service.stages = replace(service.stages, calibrate=stage_calibrate.calibrate)
    monkeypatch.setattr(stage_calibrate, "_lib", lambda: fake_lib(grid_ok=False))
    request = PhotoToWallRequest(
        image_path=photo, work_dir=tmp_path / "w",
        calibrate=CalibrateParams(points_px=((10, 10), (110, 10)), distance_mm=250),
    )  # fmt: skip
    result = photo_to_wall.run(service, request)
    assert result["calibration"]["mm_per_px"] == pytest.approx(2.5)
    assert len(calls.fit) == 2 and all(c["mm_per_px"] == pytest.approx(2.5) for c in calls.fit)
    # the object sizes in the proposal follow that scale: the long tool is 180 px
    long_item = result["proposal"]["items"][0]
    assert long_item["dimensionsMm"]["length"] == pytest.approx(180 * 2.5)
    assert result["proposal"]["calibration"]["method"] == "two-point"
