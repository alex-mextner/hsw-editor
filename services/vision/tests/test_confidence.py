"""One confidence policy: the same fit has the same number on `/fit`, `/multiview`, in the wall proposal and in objects."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from helpers import make_service
from hsw_vision import objects, photo_to_wall
from hsw_vision.app import create_app
from hsw_vision.confidence import assess, fit_confidence, view_confidence
from hsw_vision.schemas import CalibrateParams, PhotoToObjectsRequest, PhotoToWallRequest

NAN = float("nan")


def fit(**conf: Any) -> dict[str, Any]:
    return {"confidence": conf, "views": [{"iou": 0.9}]}


def test_single_view_is_capped_several_views_are_not_a_heldout_view_wins() -> None:
    assert fit_confidence(fit(train_min_iou=0.93, n_views=1), 0.6) == 0.6
    assert fit_confidence(fit(train_min_iou=0.5, n_views=1), 0.6) == 0.5
    assert fit_confidence(fit(train_min_iou=0.93, n_views=3), 0.6) == 0.93
    assert fit_confidence(fit(train_min_iou=0.93, heldout_iou=0.81, n_views=3), 0.6) == 0.81


def test_nan_is_zero_never_one() -> None:
    assert fit_confidence(fit(heldout_iou=NAN), 0.6) == 0.0
    assert fit_confidence(fit(train_min_iou=NAN, n_views=3), 0.6) == 0.0
    assert view_confidence({"views": [{"iou": NAN}], "min_iou": NAN}) == 0.0


def test_checked_views_beat_the_fits_own_training_iou() -> None:
    check = {"views": [{"iou": 0.4}], "min_iou": 0.4, "status": "low", "needs_views": [{"azimuth_deg": 90, "elevation_deg": 0}]}
    verdict = assess(fit(train_min_iou=0.95, n_views=1), check, single_view_cap=0.6, view_flag_iou=0.75)
    assert verdict.confidence == 0.4 and verdict.needs_view is True


def test_needs_view_when_below_the_threshold_or_flagged_by_the_library() -> None:
    low = assess(fit(train_min_iou=0.93, n_views=1), None, single_view_cap=0.6, view_flag_iou=0.75)
    assert low.confidence == 0.6 and low.needs_view is True  # capped single view is below 0.75
    ok = assess(fit(train_min_iou=0.93, n_views=3), None, single_view_cap=0.6, view_flag_iou=0.75)
    assert ok.needs_view is False
    flagged = assess(
        fit(train_min_iou=0.93, n_views=3),
        {"views": [{"iou": 0.9}], "min_iou": 0.9, "status": "flagged", "needs_views": [{"azimuth_deg": 1, "elevation_deg": 2}]},
        single_view_cap=0.6,
        view_flag_iou=0.75,
    )
    assert flagged.needs_view is True and flagged.confidence == 0.9


def test_every_entry_point_reports_the_same_confidence(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    client = TestClient(create_app(service=service), base_url="http://127.0.0.1:8795")
    body = {"image_path": str(photo), "work_dir": str(tmp_path / "w"), "calibrate": {"mm_per_px": 1.0}}
    fit_response = client.post("/fit", json={**body, "instance": 1}).json()
    multi = client.post("/multiview", json={"fit": fit_response["fit"], "views": [], "flag_below": 0.75}).json()
    wall = photo_to_wall.run(service, PhotoToWallRequest(image_path=photo, work_dir=tmp_path / "w2", calibrate=CalibrateParams(mm_per_px=1.0)))
    objs = objects.run(
        service,
        PhotoToObjectsRequest(image_path=photo, work_dir=tmp_path / "w3", out_dir=tmp_path / "o", calibrate=CalibrateParams(mm_per_px=1.0)),
    )
    wall_item = next(i for i in wall["proposal"]["items"] if i["instanceId"] == 1)
    obj = next(o for o in objs["objects"] if o["id"] == 1)
    assert fit_response["confidence"] == multi["confidence"] == pytest.approx(0.6)
    assert wall_item["confidence"] == obj["confidence"] == pytest.approx(0.6)
