"""Multi-view check: held-out view IoU is the confidence; low confidence emits ONE aggregated `request_view`."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from helpers import make_service
from hsw_vision import photo_to_wall
from hsw_vision.schemas import CalibrateParams, PhotoToWallRequest
from hsw_vision.stages import multiview

TWO_POINT = CalibrateParams(points_px=((0, 0), (100, 0)), distance_mm=150)


def stage_stubs(iou: float, baseline_ok: bool = True) -> dict[str, Any]:
    seen_views: list[int] = []

    def register_views(rgb_a: Any, rgb_b: Any, masks_a: list[Any], camera: Any) -> dict[str, Any]:
        views = [{"mask": m, "K": camera.K, "R": camera.R, "t": camera.t} for m in masks_a] if baseline_ok else [None] * len(masks_a)
        return {"ok": True, "baseline_ok": baseline_ok, "matches": 100, "inliers": 90, "views": views}

    def check_fit(fit: dict[str, Any], views: list[dict[str, Any]], *, flag_below: float) -> dict[str, Any]:
        seen_views.append(len(views))
        if not views:
            return {"views": [], "min_iou": None, "status": "unverified", "needs_views": [{"azimuth_deg": 60.0, "elevation_deg": 30.0}]}
        low = iou < flag_below
        return {
            "views": [{"iou": iou, "flag": low}],
            "min_iou": iou,
            "status": "low" if low else "ok",
            "needs_views": [{"azimuth_deg": 90.0, "elevation_deg": 20.0}] if low else [],
        }

    return {"register_views": register_views, "check_fit": check_fit, "seen": seen_views}


def run_with(tmp_path: Path, photo: Path, other: Path, iou: float, baseline_ok: bool = True, **request: Any) -> dict[str, Any]:
    service, _ = make_service(tmp_path)
    stubs = stage_stubs(iou, baseline_ok)
    service.stages = replace(service.stages, register_views=stubs["register_views"], check_fit=stubs["check_fit"])
    req = PhotoToWallRequest(image_path=photo, work_dir=tmp_path / "w", calibrate=TWO_POINT, extra_photos=[other], **request)
    return photo_to_wall.run(service, req)


@pytest.fixture
def other_photo(tmp_path: Path, photo: Path) -> Path:
    path = tmp_path / "other.png"
    path.write_bytes(photo.read_bytes())
    return path


def test_held_out_view_iou_is_the_item_confidence(tmp_path: Path, photo: Path, other_photo: Path) -> None:
    result = run_with(tmp_path, photo, other_photo, iou=0.88)
    items = result["proposal"]["items"]
    assert [i["confidence"] for i in items] == [0.88, 0.88]
    assert all(i["check"]["status"] == "ok" and not i["needsView"] for i in items)
    assert result["events"] == []  # confident: no request_view
    assert result["diagnostics"]["extraPhotos"][0]["baseline_ok"] is True


def test_low_held_out_iou_emits_one_request_view_with_suggested_views(tmp_path: Path, photo: Path, other_photo: Path) -> None:
    result = run_with(tmp_path, photo, other_photo, iou=0.4, view_flag_iou=0.75)
    event = result["events"][0]
    assert event["type"] == "request_view" and event["reason"] == "low_confidence" and event["threshold"] == 0.75
    assert len(result["events"]) == 1  # one event per photo, not one per object
    assert {i["itemId"] for i in event["items"]} == {i["id"] for i in result["proposal"]["items"]}
    assert event["suggested"] == [{"azimuth_deg": 90.0, "elevation_deg": 20.0}]
    assert all(i["needsView"] for i in result["proposal"]["items"])


def test_threshold_is_configurable(tmp_path: Path, photo: Path, other_photo: Path) -> None:
    assert run_with(tmp_path, photo, other_photo, iou=0.6, view_flag_iou=0.5)["events"] == []
    assert run_with(tmp_path, photo, other_photo, iou=0.6, view_flag_iou=0.9, refresh=True)["events"] != []


def test_a_second_photo_from_the_same_viewpoint_holds_nothing_out(tmp_path: Path, photo: Path, other_photo: Path) -> None:
    result = run_with(tmp_path, photo, other_photo, iou=0.99, baseline_ok=False)
    items = result["proposal"]["items"]
    assert all(i["check"]["status"] == "unverified" for i in items)
    assert all(i["confidence"] == pytest.approx(0.6) for i in items)  # still the capped single-view confidence
    assert result["diagnostics"]["extraPhotos"][0]["baseline_ok"] is False


def test_single_photo_runs_the_sanity_mode_and_asks_for_views_below_the_threshold(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    req = PhotoToWallRequest(image_path=photo, work_dir=tmp_path / "w", calibrate=TWO_POINT)
    result = photo_to_wall.run(service, req)
    assert calls.check == 2
    assert result["proposal"]["items"][0]["check"]["status"] == "unverified"
    assert result["events"][0]["type"] == "request_view"  # 0.6 (capped single view) < 0.75


def test_request_view_event_lists_the_least_confident_first_and_is_capped() -> None:
    items = [{"id": f"i{n}", "confidence": 0.1 * n, "needs_view": True, "check": {"status": "low", "needs_views": [{"azimuth_deg": n, "elevation_deg": 0}]}} for n in range(1, 12)]
    event = multiview.request_view_event(items, photo_id="p-9", threshold=0.75, limit=3)
    assert event is not None
    assert [i["itemId"] for i in event["items"]] == ["i1", "i2", "i3"]
    assert event["totalWanting"] == 11 and event["photoId"] == "p-9"
    assert multiview.request_view_event([{"id": "x", "confidence": 0.9, "needs_view": False}], photo_id=None, threshold=0.75) is None


def test_registered_view_composes_the_relative_pose_with_the_camera(monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace

    from hsw_vision.geometry import Camera

    rel = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1.0]])
    reg = {"ok": True, "baseline_ok": True, "rel_R": rel, "t_over_depth": [0.1, 0.0, 0.0], "warped_masks": [np.ones((4, 4), bool)]}
    monkeypatch.setattr("threed_vision.register", SimpleNamespace(register=lambda *a, **k: reg), raising=False)
    import sys

    monkeypatch.setitem(sys.modules, "threed_vision.register", SimpleNamespace(register=lambda *a, **k: reg))
    cam = Camera(K=np.eye(3), R=np.eye(3), t=np.array([0, 0, 500.0]), h_px_to_plane=None, mm_per_px=1.0, plane_depth_mm=500.0, source="x")
    out = multiview.register_views(np.zeros((4, 4, 3)), np.zeros((4, 4, 3)), [np.ones((4, 4), bool)], cam)
    view = out["views"][0]
    np.testing.assert_allclose(view["R"], rel)
    np.testing.assert_allclose(view["t"], rel @ np.array([0, 0, 500.0]) + np.array([50.0, 0, 0]))
