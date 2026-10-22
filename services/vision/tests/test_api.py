"""HTTP contract of the sidecar with fake stages (no models): shapes, errors, streaming, user overrides."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from helpers import Calls, make_service
from hsw_vision.app import create_app
from hsw_vision.errors import ModelsMissing


@pytest.fixture
def api(tmp_path: Path) -> tuple[TestClient, Calls, Path]:
    service, calls = make_service(tmp_path)
    client = TestClient(create_app(service), base_url="http://127.0.0.1:8795")
    return client, calls, tmp_path


def body(photo: Path, tmp_path: Path, **extra: Any) -> dict[str, Any]:
    return {"image_path": str(photo), "work_dir": str(tmp_path / "work"), **extra}


TWO_POINT = {"mode": "auto", "points_px": [[0, 0], [100, 0]], "distance_mm": 150}


def test_segment_returns_masks_bboxes_and_polygons(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    response = client.post("/segment", json=body(photo, tmp, include_masks=True))
    assert response.status_code == 200
    data = response.json()
    first = data["instances"][0]
    assert set(first) >= {"id", "bbox_xywh", "area_px", "polygon", "mask", "bg_prob"}
    assert first["bbox_xywh"] == [20, 20, 180, 30]
    assert len(first["polygon"]) >= 4
    assert data["masks_png_base64"]["1"].startswith("iVBOR")  # PNG signature in base64
    assert (Path(data["imageDir"]) / data["dir"] / first["mask"]).is_file()
    assert data["image"]["w"] == 240


def test_calibrate_needs_scale_is_a_result_not_an_error(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    data = client.post("/calibrate", json=body(photo, tmp)).json()
    assert data["ok"] is False and data["needs"] == "scale"


def test_calibrate_two_point(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    data = client.post("/calibrate", json=body(photo, tmp, calibrate=TWO_POINT)).json()
    assert data["ok"] and data["method"] == "two-point"
    assert data["mm_per_px"] == pytest.approx(1.5)


def test_fit_returns_params_dimensions_and_residual_and_confidence(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    response = client.post("/fit", json=body(photo, tmp, calibrate=TWO_POINT, instance=1))
    assert response.status_code == 200
    data = response.json()
    assert data["dimensionsMm"]["length_mm"] == pytest.approx(180 * 1.5)
    assert data["residual"] == pytest.approx(0.07)
    # single-view fit: confidence is the training IoU capped (silhouette-consistent, 3-D unverified)
    assert data["confidence"] == pytest.approx(0.6)
    assert data["fit"]["glb"].startswith("models/fit-001-")
    assert (Path(data["imageDir"]) / data["fit"]["glb"]).is_file()


def test_fit_user_dimension_overrides_are_passed_as_hard_constraints(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, calls, tmp = api
    data = client.post(
        "/fit", json=body(photo, tmp, calibrate=TWO_POINT, instance=1, fixed_dims={"length": 200})
    ).json()
    assert calls.fit[-1]["fixed_dims"] == {"length": 200}
    assert data["dimensionsMm"]["length_mm"] == 200
    assert data["dimsFixed"] == {"length": 200}


def test_fit_without_any_scale_is_a_422_calibration_needed(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    response = client.post("/fit", json=body(photo, tmp, instance=1))
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "calibration_needed" and "two-point" in error["fix"]


def test_unknown_instance_is_a_422(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    response = client.post("/fit", json=body(photo, tmp, calibrate=TWO_POINT, instance=99))
    assert response.status_code == 422 and response.json()["error"]["code"] == "bad_request"


def test_missing_image_is_a_422(api: tuple[TestClient, Calls, Path], tmp_path: Path) -> None:
    client, _, _ = api
    response = client.post("/segment", json={"image_path": str(tmp_path / "nope.png")})
    assert response.status_code == 422 and "not found" in response.json()["error"]["message"]


def test_invalid_body_is_rejected_by_the_schema(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    assert client.post("/segment", json=body(photo, tmp, segment={"method": "magic"})).status_code == 422
    assert client.post("/segment", json=body(photo, tmp, bogus=1)).status_code == 422


def test_missing_models_surface_as_424_models_missing_with_the_fetch_command(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)

    def broken(*_: Any, **__: Any) -> dict[str, Any]:
        raise ModelsMissing("model sam2-tiny is missing", missing=["sam2-tiny"])

    service.stages = replace(service.stages, segment=broken)
    client = TestClient(create_app(service), base_url="http://127.0.0.1:8795")
    response = client.post("/segment", json=body(photo, tmp_path))
    assert response.status_code == 424
    error = response.json()["error"]
    assert error["code"] == "models_missing"
    assert error["fix"] == "hsw-editor vision fetch-models"
    assert error["details"]["missing"] == ["sam2-tiny"]


def test_multiview_reports_confidence_and_request_view(api: tuple[TestClient, Calls, Path]) -> None:
    client, _, _ = api
    fit = {"confidence": {"train_min_iou": 0.9, "n_views": 1}, "views": [{"iou": 0.9}]}
    data = client.post("/multiview", json={"fit": fit, "flag_below": 0.75}).json()
    assert data["status"] == "unverified"
    assert data["confidence"] == pytest.approx(0.6)
    assert data["request_view"] is True  # 0.6 < 0.75
    low = client.post("/multiview", json={"fit": fit, "flag_below": 0.5}).json()
    assert low["request_view"] is False  # threshold is configurable


def test_models_status_is_served(api: tuple[TestClient, Calls, Path]) -> None:
    client, _, _ = api
    data = client.get("/models/status").json()
    assert "manager" in data and data["manager"]["device"] == "auto"


def test_photo_to_wall_streams_ndjson_progress_and_a_final_result(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, _, tmp = api
    with client.stream("POST", "/photo-to-wall", json=body(photo, tmp, calibrate=TWO_POINT, photo_id="p-1")) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        events = [json.loads(line) for line in response.iter_lines() if line]
    kinds = [e.get("event") or e.get("type") for e in events]
    assert kinds[0] == "stage" and kinds[-1] == "result"
    assert {"stage", "object", "request_view", "result"} <= set(kinds)
    stages = [e["stage"] for e in events if e.get("event") == "stage" and e.get("state") == "done"]
    assert stages == ["open", "calibrate", "segment", "recognise", "fit", "proposal"]
    result = events[-1]["result"]
    assert result["status"] == "ok"
    items = result["proposal"]["items"]
    assert [i["instanceId"] for i in items] == [1, 2]  # the 4x4 px speck is filtered out
    assert result["diagnostics"]["skipped"]["too_small"] == 1


def test_photo_to_wall_without_scale_asks_for_calibration(api: tuple[TestClient, Calls, Path], photo: Path) -> None:
    client, calls, tmp = api
    with client.stream("POST", "/photo-to-wall", json=body(photo, tmp)) as response:
        events = [json.loads(line) for line in response.iter_lines() if line]
    assert events[-1]["result"]["status"] == "needs_calibration"
    assert any(e.get("event") == "needs_calibration" for e in events)
    assert events[-1]["result"]["proposal"] is None
    assert calls.segment == 0  # nothing expensive ran before the scale is known


def test_photo_to_wall_error_event_is_structured(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)

    def broken(*_: Any, **__: Any) -> dict[str, Any]:
        raise ModelsMissing("model sam2-tiny is missing", missing=["sam2-tiny"])

    service.stages = replace(service.stages, segment=broken)
    client = TestClient(create_app(service), base_url="http://127.0.0.1:8795")
    with client.stream("POST", "/photo-to-wall", json=body(photo, tmp_path, calibrate=TWO_POINT)) as response:
        events = [json.loads(line) for line in response.iter_lines() if line]
    assert events[-1]["event"] == "error"
    assert events[-1]["error"]["code"] == "models_missing"


def test_a_missing_python_extra_is_a_structured_error_not_zero_items(tmp_path: Path, photo: Path) -> None:
    """Review finding: a missing `trimesh` made every fit fail silently and the run returned status ok with no items."""
    service, _ = make_service(tmp_path)

    def no_trimesh(fit: dict[str, Any], path: Path) -> dict[str, float]:
        raise ModuleNotFoundError("No module named 'trimesh'")

    service.stages = replace(service.stages, write_glb=no_trimesh)
    client = TestClient(create_app(service), base_url="http://127.0.0.1:8795")
    with client.stream("POST", "/photo-to-wall", json=body(photo, tmp_path, calibrate=TWO_POINT)) as response:
        events = [json.loads(line) for line in response.iter_lines() if line]
    assert events[-1]["event"] == "error"
    assert events[-1]["error"]["code"] == "missing_dependency" and "--extra ml" in events[-1]["error"]["fix"]


def test_every_fit_failing_is_an_error_not_an_empty_proposal(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)

    def broken(*_: Any, **__: Any) -> dict[str, Any]:
        raise RuntimeError("degenerate mask")

    service.stages = replace(service.stages, fit_mask=broken)
    client = TestClient(create_app(service), base_url="http://127.0.0.1:8795")
    with client.stream("POST", "/photo-to-wall", json=body(photo, tmp_path, calibrate=TWO_POINT)) as response:
        events = [json.loads(line) for line in response.iter_lines() if line]
    assert events[-1]["event"] == "error" and "every fit failed" in events[-1]["error"]["message"]


def test_host_header_case_and_low_confidence_status() -> None:
    from hsw_vision.errors import LowConfidence

    assert TestClient(create_app(), base_url="http://LOCALHOST:8795").get("/health").status_code == 200
    assert LowConfidence("x").http_status == 422


def test_duplicate_bank_class_names_are_rejected() -> None:
    from hsw_vision.errors import BadRequest
    from hsw_vision.stages.recognise import classes_from_bank

    index = {"toolClasses": [{"id": "a", "name": {"en": "Snips"}}, {"id": "b", "name": {"en": "snips"}}]}
    with pytest.raises(BadRequest):
        classes_from_bank(index)
