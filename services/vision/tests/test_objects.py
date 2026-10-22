"""photo_to_objects: the per-object library result (masks, crops, upright crops, class top-k, fit, colours, embeddings)."""

from __future__ import annotations

import json
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image as PilImage

from helpers import make_service
from hsw_vision import cli, objects
from hsw_vision.app import create_app
from hsw_vision.errors import BadRequest, Cancelled
from hsw_vision.schemas import CalibrateParams, PhotoToObjectsRequest
from hsw_vision.stages import recognise as stage_recognise
from hsw_vision.stages import shape as stage_shape

SCALE = {"mm_per_px": 1.0}


def run(tmp_path: Path, photo: Path, service: Any, **fields: Any) -> dict[str, Any]:
    request = PhotoToObjectsRequest(image_path=photo, work_dir=tmp_path / "work", out_dir=tmp_path / "out", **fields)
    return objects.run(service, request)


def test_every_object_has_mask_crops_class_fit_colours_and_embedding(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    result = run(tmp_path, photo, service, calibrate=CalibrateParams(**SCALE))
    out = Path(result["outDir"])
    assert result["status"] == "ok" and result["version"] == objects.RESULT_VERSION
    assert [o["id"] for o in result["objects"]] == [1, 2]  # largest first; the 16 px speck is filtered out
    long_tool = result["objects"][0]
    for key in ("mask", "cropOriented", "cutoutOriented", "cutout"):
        assert (out / long_tool[key]).is_file(), key
    assert (out / long_tool["crop"]["path"]).is_file() and len(long_tool["crop"]["boxXywh"]) == 4
    assert long_tool["class"]["toolClass"] == "screwdriver" and long_tool["class"]["topk"][0]["toolClass"] == "screwdriver"
    assert long_tool["class"]["prob"] == pytest.approx(0.8)
    assert long_tool["dimensionsMm"]["length"] == pytest.approx(180.0) and long_tool["mmPerPx"] == 1.0
    assert (out / long_tool["fit"]["glb"]).read_bytes() == b"glTF-fake" and long_tool["fit"]["kind"] == "box"
    assert long_tool["profile"]["length_mm"] == pytest.approx(180.0, abs=1.5) and min(abs(long_tool["axis"]["deg"]), 180 - abs(long_tool["axis"]["deg"])) < 1
    assert long_tool["colours"]["parts"][0]["hex"] == "#c83c3c" and long_tool["confidence"] == pytest.approx(0.6)
    assert long_tool["needsViews"] and long_tool["needsView"] is True and long_tool["status"] == "ok"
    embeddings = np.load(out / "embeddings.npy")
    assert embeddings.shape == (2, 512) and embeddings.dtype == np.float32
    assert long_tool["embedding"] == {"file": "embeddings.npy", "row": 0, "dim": 512, "model": "clip-b32"}
    assert result["overlay"] == {"segmentation": "overlay.jpg", "fit": "fit-overlay.jpg"}
    assert (out / "overlay.jpg").is_file() and (out / "fit-overlay.jpg").is_file()
    assert result["summary"] == {"found": 3, "analysed": 2, "recognised": 2, "fitted": 2, "failed": 0, "needsViews": 2, "needsConfirmation": 0}
    assert json.loads((out / "objects.json").read_text())["objects"][0]["id"] == 1
    assert calls.colours == 2 and calls.embed == 1


def test_a_run_without_scale_still_returns_masks_crops_classes_and_colours(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    result = run(tmp_path, photo, service)
    out = Path(result["outDir"])
    assert result["status"] == "no_scale" and result["needs"] == "scale" and calls.fit == []
    first = result["objects"][0]
    assert first["fit"] is None and first["dimensionsMm"] is None and first["profile"] is None and first["mmPerPx"] is None
    assert first["status"] == "no_scale" and first["axis"]["unit"]  # the axis needs no scale
    assert (out / first["mask"]).is_file() and (out / first["cropOriented"]).is_file()
    assert first["class"]["toolClass"] == "screwdriver" and first["colours"] is not None
    assert result["overlay"]["fit"] is None and not (out / "fit-overlay.jpg").exists()


def test_a_second_run_with_a_scale_reuses_the_cached_segmentation(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    run(tmp_path, photo, service)
    result = run(tmp_path, photo, service, calibrate=CalibrateParams(**SCALE))
    assert calls.segment == 1 and calls.recognise == 1 and result["status"] == "ok"


def test_colours_missing_from_the_library_are_reported_not_faked(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    service.stages = replace(service.stages, colours_available=lambda: False)
    result = run(tmp_path, photo, service, calibrate=CalibrateParams(**SCALE))
    assert all(o["colours"] is None for o in result["objects"]) and calls.colours == 0
    note = result["diagnostics"]["colours"]
    assert note["available"] is False and "appearance" in note["reason"]


def test_colours_can_be_switched_off(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    result = run(tmp_path, photo, service, calibrate=CalibrateParams(**SCALE), colours=False)
    assert calls.colours == 0 and result["diagnostics"]["colours"] == {"enabled": False}


def test_embeddings_can_be_inlined(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    result = run(tmp_path, photo, service, calibrate=CalibrateParams(**SCALE), inline_embeddings=True)
    vector = result["objects"][0]["embedding"]["vector"]
    assert len(vector) == 512 and sum(v * v for v in vector) == pytest.approx(1.0, abs=1e-4)
    on_disk = np.load(Path(result["outDir"]) / "embeddings.npy")
    np.testing.assert_allclose(on_disk[0], vector, atol=1e-6)


def test_user_dimensions_are_hard_constraints_for_the_fit(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    result = run(tmp_path, photo, service, calibrate=CalibrateParams(**SCALE), fixed_dims={"1": {"length": 150}})
    assert calls.fit[0]["fixed_dims"] == {"length": 150}
    assert result["objects"][0]["dimensionsMm"]["length"] == pytest.approx(150.0)
    assert result["objects"][0]["fit"]["dimsFixed"] == {"length": 150}


def test_the_library_entry_point_takes_plain_options(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    result = objects.photo_to_objects(photo, tmp_path / "lib", service=service, work_dir=tmp_path / "w", calibrate={"mm_per_px": 2.0})
    assert result["outDir"] == str((tmp_path / "lib").resolve()) and result["objects"][0]["dimensionsMm"]["length"] == pytest.approx(360.0)
    with pytest.raises(Exception, match="max_objects"):
        objects.photo_to_objects(photo, tmp_path / "lib", service=service, max_objects=0)


def test_default_out_dir_lives_in_the_image_cache(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    result = objects.run(service, PhotoToObjectsRequest(image_path=photo, work_dir=tmp_path / "w"))
    assert Path(result["outDir"]).parent.parent == (tmp_path / "w").resolve() and Path(result["outDir"]).name == "objects"


def test_a_missing_extra_photo_fails_before_any_stage(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    with pytest.raises(BadRequest):
        run(tmp_path, photo, service, extra_photos=[tmp_path / "gone.jpg"])
    assert calls.segment == 0


def test_cancellation_is_honoured(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        objects.run(service, PhotoToObjectsRequest(image_path=photo, work_dir=tmp_path / "w"), cancel=cancel)
    assert calls.segment == 0


def test_the_http_endpoint_streams_progress_and_the_result(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    client = TestClient(create_app(service=service), base_url="http://127.0.0.1:8795")
    body = {"image_path": str(photo), "work_dir": str(tmp_path / "w"), "out_dir": str(tmp_path / "o"), "calibrate": SCALE}
    with client.stream("POST", "/photo-to-objects", json=body) as response:
        events = [json.loads(line) for line in response.iter_lines() if line]
    assert [e["stage"] for e in events if e.get("event") == "stage" and e.get("state") == "done"][:4] == ["open", "calibrate", "segment", "recognise"]
    final = events[-1]
    assert final["event"] == "result" and final["result"]["objects"][0]["id"] == 1
    assert (tmp_path / "o" / "objects.json").is_file()


def test_the_cli_writes_the_result_directory_and_exits_2_without_a_scale(
    tmp_path: Path, photo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    service, _ = make_service(tmp_path)
    monkeypatch.setattr("hsw_vision.service.VisionService.create", classmethod(lambda cls, config, **kw: service))
    out = tmp_path / "cli-out"
    assert cli.main(["photo-to-objects", str(photo), "--out", str(out), "--mm-per-px", "1.0", "--bank-index", "none"]) == 0
    assert "fitted 2" in capsys.readouterr().out
    assert (out / "objects.json").is_file() and (out / "timings.json").is_file() and (out / "embeddings.npy").is_file()
    out2 = tmp_path / "cli-out2"
    assert cli.main(["photo-to-objects", str(photo), "--out", str(out2), "--bank-index", "none"]) == 2
    assert "NO SCALE" in capsys.readouterr().out


def test_an_external_categories_file_replaces_the_bank_classes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stage_recognise, "classes_from_file", lambda spec: [{"id": "my-class", "prompts": [f"from {spec}"]}])
    bank = {"toolClasses": [{"id": "x", "name": {"en": "X"}}]}
    assert stage_recognise.resolve_classes(bank, "tools.json") == [{"id": "my-class", "prompts": ["from tools.json"]}]
    assert stage_recognise.resolve_classes(bank)[0]["id"] == "x"
    assert stage_recognise.resolve_classes(None)[0]["id"] == "screwdriver"


def test_categories_files_are_read_by_the_library(tmp_path: Path) -> None:
    pytest.importorskip("threed_vision.recognise")
    path = tmp_path / "classes.json"
    path.write_text(json.dumps([{"id": "caliper", "name": {"en": "caliper"}, "synonyms": ["vernier caliper"]}, {"id": "awl", "name": {"en": "awl"}}]))
    classes = stage_recognise.resolve_classes(None, str(path))
    assert classes == [{"id": "caliper", "prompts": ["caliper", "vernier caliper"]}, {"id": "awl", "prompts": ["awl"]}]


def test_upright_crops_put_the_principal_axis_horizontal() -> None:
    rgb = np.full((300, 300, 3), 80, np.uint8)
    mask = np.zeros((300, 300), bool)
    import cv2

    pts = cv2.boxPoints(((150.0, 150.0), (160.0, 20.0), 35.0)).astype(np.int32)  # a 160x20 bar tilted 35 degrees
    cv2.fillConvexPoly(mask.view(np.uint8), pts, 1)
    ys, xs = np.nonzero(mask)
    axis = np.linalg.svd(np.c_[xs, ys] - np.c_[xs, ys].mean(0), full_matrices=False)[2][0]
    deg = float(np.degrees(np.arctan2(axis[1], axis[0])))
    crop, cutout, upright = stage_shape.upright_crops(rgb, mask, deg, 0.1)
    uy, ux = np.nonzero(upright)
    assert np.ptp(ux) + 1 > 6 * (np.ptp(uy) + 1)  # long axis is now x
    assert crop.shape[:2] == upright.shape == cutout.shape[:2] and cutout.shape[2] == 4
    assert abs(int(upright.sum()) - int(mask.sum())) < 0.05 * mask.sum()  # rotation keeps the area
    assert (cutout[..., 3] > 0).sum() == upright.sum()


def test_embed_writes_one_row_per_image_in_argument_order(tmp_path: Path, photo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    service, _ = make_service(tmp_path)
    monkeypatch.setattr("hsw_vision.service.VisionService.create", classmethod(lambda cls, config, **kw: service))
    dark = tmp_path / "dark.png"
    PilImage.fromarray(np.full((40, 60, 3), 10, np.uint8)).save(dark)
    out = tmp_path / "emb"
    assert cli.main(["embed", str(photo), str(dark), "--out", str(out), "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert [i["row"] for i in report["items"]] == [0, 1] and report["dim"] == 512 and report["items"][1]["size"] == [60, 40]
    rows = np.load(out / "embeddings.npy")
    assert rows.shape == (2, 512) and not np.allclose(rows[0], rows[1])
    assert json.loads((out / "embeddings.json").read_text())["items"][0]["sha256"] == report["items"][0]["sha256"]


def test_embed_object_does_not_deadlock_on_the_run_lock(tmp_path: Path, photo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """Review finding: `embed --object` held the (non re-entrant) run lock while `segment` took it again."""
    service, calls = make_service(tmp_path)
    monkeypatch.setattr("hsw_vision.service.VisionService.create", classmethod(lambda cls, config, **kw: service))
    done: list[int] = []
    thread = threading.Thread(target=lambda: done.append(cli.main(["embed", str(photo), "--out", str(tmp_path / "e"), "--object"])), daemon=True)
    thread.start()
    thread.join(10)
    assert done == [0] and calls.segment == 1 and calls.embed == 1


def test_every_fit_failing_keeps_the_masks_crops_and_classes(tmp_path: Path, photo: Path) -> None:
    """Review finding: one failing fit of a single object wiped out the whole objects result."""
    service, _ = make_service(tmp_path)

    def broken(mask: np.ndarray, camera: Any, **_: Any) -> dict[str, Any]:
        raise RuntimeError("degenerate silhouette")

    service.stages = replace(service.stages, fit_mask=broken)
    result = run(tmp_path, photo, service, calibrate=CalibrateParams(**SCALE))
    assert result["summary"]["failed"] == 2 and result["summary"]["fitted"] == 0
    first = result["objects"][0]
    assert first["status"] == "fit_failed" and "degenerate" in first["error"] and first["fit"] is None
    assert (Path(result["outDir"]) / first["mask"]).is_file() and first["class"]["toolClass"] == "screwdriver"
