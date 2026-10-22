"""Regression on the real wall photo IMG_4937 (private; skipped when the photos directory is absent).

The reference is the HSW project's own calibration (`refit/photo_calibration.json`): f = 720.8221 px, median
reprojection 0.436 px, 283/300 inliers, grid 20.4382 x 23.6 mm. `threed_vision.calibrate.detect_grid` must
reproduce it within 1 px reprojection error and a few percent in focal length.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

PHOTOS = Path("/home/ultra/dev/garage-band/projects/HSW/docs/photos")
REFERENCE = Path("/home/ultra/dev/garage-band/projects/HSW/refit/photo_calibration.json")

pytestmark = pytest.mark.real_photo

if not PHOTOS.is_dir() or not (PHOTOS / "IMG_4937.jpeg").is_file() or not REFERENCE.is_file():
    pytest.skip("private HSW photos are not available", allow_module_level=True)

calibrate = pytest.importorskip("threed_vision.calibrate", reason="blocked until the VisionCalib library PR lands")
if not hasattr(calibrate, "detect_grid"):
    pytest.skip("threed_vision.calibrate.detect_grid is not available yet", allow_module_level=True)


@pytest.fixture(scope="module")
def grid() -> dict:  # type: ignore[type-arg]
    from threed_vision import io

    return calibrate.detect_grid(io.load_rgb(PHOTOS / "IMG_4937.jpeg"))  # type: ignore[no-any-return]


def test_grid_is_detected_with_sub_pixel_reprojection_error(grid: dict) -> None:  # type: ignore[type-arg]
    assert grid["ok"] is True
    assert grid["reproj_median_px"] < 1.0
    ref = json.loads(REFERENCE.read_text())
    ref_median = ref.get("median_reproj_px") or ref.get("reproj_median_px") or 0.436
    assert abs(grid["reproj_median_px"] - ref_median) < 1.0


def test_focal_length_is_close_to_the_hsw_calibration(grid: dict) -> None:  # type: ignore[type-arg]
    ref = json.loads(REFERENCE.read_text())
    ref_f = ref.get("focal_px") or ref.get("f_px") or 720.8221
    # f is weakly observable from a ~9 degree tilt (the library reports `f_rel_uncertainty` ~0.1 on this photo; the
    # reprojection residual is the same for 720 and 757 px). The wall-plane homography is what matters and is checked above.
    assert grid["f_px"] == pytest.approx(ref_f, rel=0.08)


def _rigid_residuals_mm(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Distances left after the best rotation + translation of point set `a` onto `b` (Kabsch, no scale)."""
    ca, cb = a.mean(0), b.mean(0)
    u, _, vt = np.linalg.svd((a - ca).T @ (b - cb))
    rot = vt.T @ np.diag([1.0, float(np.sign(np.linalg.det(vt.T @ u.T)))]) @ u.T
    return np.asarray(np.linalg.norm((a - ca) @ rot.T + cb - b, axis=1))


def test_the_detected_lattice_projects_like_the_reference_calibration(grid: dict) -> None:  # type: ignore[type-arg]
    """Assert the projection, not the focal length (f is weakly observable: 756.6 vs 720.8 px give the same image).

    The detected inlier cell centres are mapped onto the wall plane twice: through the detector's homography, and through
    the reference camera (ray - plane z = 0 of the reference object frame). The two planar point sets must agree up to a
    rigid motion (the lattice origin/handedness of the two frames differ); the residual, in pixels, must be < 1 px. Measured:
    median 0.09 px, max 0.32-0.35 px."""
    ref = json.loads(REFERENCE.read_text())
    pixels = np.asarray(grid["inlier_cells_px"], dtype=float)
    homogeneous = np.c_[pixels, np.ones(len(pixels))]
    on_plane = homogeneous @ np.asarray(grid["homography_px_to_grid_mm"], dtype=float).T
    detected = on_plane[:, :2] / on_plane[:, 2:3]

    rot, trans, focal = np.array(ref["camera_R_object_to_cv"]), np.array(ref["camera_t_object_to_cv_mm"]), ref["focal_px"]
    width, height = ref["image_size_px"]
    k_ref = np.array([[focal, 0, width / 2], [0, focal, height / 2], [0, 0, 1.0]])
    rays = homogeneous @ np.linalg.inv(k_ref).T
    normal = rot[:, 2]
    camera_points = rays * ((normal @ trans) / (rays @ normal))[:, None]
    reference = ((camera_points - trans) @ rot)[:, :2]  # R^T (X_cam - t): the plane z = 0 of the object frame

    mm_per_px = grid["mm_per_px_centre"]
    best_median = min(
        float(np.median(_rigid_residuals_mm(detected, reference * np.array([sign, 1.0])))) / mm_per_px for sign in (1.0, -1.0)
    )
    assert len(pixels) > 200
    assert best_median < 1.0


def test_the_calibrate_stage_wraps_it_into_a_core_calibration() -> None:
    from hsw_vision.stages import calibrate as stage
    from threed_vision import io

    result = stage.calibrate(io.load_rgb(PHOTOS / "IMG_4937.jpeg"), mode="grid")
    assert result["ok"] and result["method"] == "grid"
    core = result["core"]
    assert core["method"] == "grid" and len(core["homography"]) == 9
    assert core["reprojErrorPx"] < 1.0
