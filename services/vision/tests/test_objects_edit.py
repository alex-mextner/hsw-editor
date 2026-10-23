"""Edit ops on a finished photo_to_objects directory: merge, split, reprofile, add (stages are the fakes of helpers.py)."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image as PilImage

from helpers import IMAGE_H, IMAGE_W, make_service
from hsw_vision import cli, objects, objects_edit
from hsw_vision.app import create_app
from hsw_vision.errors import BadRequest, CalibrationNeeded
from hsw_vision.mask_split import split_by_line, split_into, split_mask
from hsw_vision.schemas import CalibrateParams, PhotoToObjectsRequest
from hsw_vision.service import VisionService

SCALE = CalibrateParams(mm_per_px=1.0)


def first_run(tmp_path: Path, photo: Path, service: VisionService, **fields: Any) -> tuple[dict[str, Any], Path]:
    out = tmp_path / "out"
    request = PhotoToObjectsRequest(image_path=photo, work_dir=tmp_path / "work", out_dir=out, **fields)
    return objects.run(service, request), out


def on_disk(out: Path) -> dict[str, Any]:
    return json.loads((out / "objects.json").read_text())  # type: ignore[no-any-return]


def record(result: dict[str, Any], ident: int) -> dict[str, Any]:
    return next(r for r in result["objects"] if r["id"] == ident)


# ---- the run stores what the ops need ---------------------------------------------------------------------------


def test_a_run_stores_its_request_and_class_vocabulary(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    result, out = first_run(tmp_path, photo, service, calibrate=SCALE, topk=3)
    stored = on_disk(out)["request"]
    assert stored["topk"] == 3 and stored["calibrate"]["mm_per_px"] == 1.0
    assert {"id": "screwdriver", "prompts": ["screwdriver"]} in stored["classes"]
    assert not {"image_path", "out_dir", "work_dir", "bank_index"} & set(stored)
    assert result["request"] == stored


# ---- merge ------------------------------------------------------------------------------------------------------


def test_merge_makes_one_new_object_from_the_union_and_marks_the_sources(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    reply = objects_edit.merge_objects(service, out, [2, 1, 2])
    merged = reply["object"]
    assert merged["id"] == 3 and merged["source"] == "merged" and merged["status"] == "ok"
    assert merged["bboxXywh"] == [20, 20, 180, 120]  # the union of the long and the stubby tool
    assert merged["dimensionsMm"]["length"] == pytest.approx(180.0) and merged["fit"]["glb"] == "models/003.glb"
    assert (out / merged["mask"]).is_file() and (out / merged["fit"]["glb"]).is_file() and (out / merged["cropOriented"]).is_file()
    assert merged["embedding"] == {"file": "embeddings.npy", "row": 2, "dim": 512, "model": "clip-b32"}
    assert np.load(out / "embeddings.npy").shape == (3, 512)
    assert {s["id"] for s in reply["sources"]} == {1, 2}
    saved = on_disk(out)
    assert [record(saved, i)["status"] for i in (1, 2)] == ["merged", "merged"]
    assert record(saved, 1)["mergedInto"] == 3 and record(saved, 2)["mergedInto"] == 3
    assert saved["summary"]["analysed"] == 1 and reply["summary"] == saved["summary"] and saved["summary"]["found"] == 3
    assert saved["edits"][0]["op"] == "merge" and saved["edits"][0]["ids"] == [2, 1] and saved["edits"][0]["into"] == [3]
    assert calls.fit[-1]["mm_per_px"] == 1.0
    assert not (out / objects_edit.WORK_DIR).exists()


def test_merge_refuses_unknown_single_and_already_merged_ids(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    with pytest.raises(BadRequest, match="two or more"):
        objects_edit.merge_objects(service, out, [1, 1])
    with pytest.raises(BadRequest, match="no object 9"):
        objects_edit.merge_objects(service, out, [1, 9])
    objects_edit.merge_objects(service, out, [1, 2])
    with pytest.raises(BadRequest, match="already merged into 3"):
        objects_edit.merge_objects(service, out, [1, 3])


def test_merge_without_a_scale_keeps_masks_classes_and_embeddings(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service)
    reply = objects_edit.merge_objects(service, out, [1, 2])
    assert reply["object"]["fit"] is None and reply["object"]["status"] == "no_scale" and calls.fit == []
    assert reply["object"]["class"]["toolClass"] and reply["object"]["embedding"]["row"] == 2


# ---- split ------------------------------------------------------------------------------------------------------


def test_split_by_a_line_makes_one_object_per_side(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    reply = objects_edit.split_object(service, out, 1, line_px=((110.0, 0.0), (110.0, 100.0)))
    parts = reply["objects"]
    assert [p["id"] for p in parts] == [3, 4] and all(p["source"] == "split" for p in parts)
    assert sum(p["areaPx"] for p in parts) == 30 * 180
    assert {p["bboxXywh"][0] for p in parts} == {20, 111}  # pixels on the line go to one side
    assert reply["source"]["status"] == "split" and reply["source"]["splitInto"] == [3, 4]
    saved = on_disk(out)
    assert saved["summary"]["analysed"] == 3 and record(saved, 1)["status"] == "split"
    assert np.load(out / "embeddings.npy").shape == (4, 512) and parts[1]["embedding"]["row"] == 3
    assert saved["edits"][0]["op"] == "split" and saved["edits"][0]["id"] == 1 and saved["edits"][0]["into"] == [3, 4]


def test_split_into_n_parts_follows_the_neck() -> None:
    mask = np.zeros((IMAGE_H, IMAGE_W), bool)
    mask[40:100, 20:80] = True  # two blobs joined by a thin neck
    mask[40:100, 120:180] = True
    mask[65:75, 80:120] = True
    parts = split_mask(mask, n=2)
    assert len(parts) == 2 and all(p.sum() > 3000 for p in parts)
    assert not (parts[0] & parts[1]).any()
    left, right = sorted(parts, key=lambda p: int(np.nonzero(p)[1].min()))
    assert np.nonzero(left)[1].min() == 20 and np.nonzero(right)[1].max() == 179  # each blob stays on its own side
    assert (left | right).sum() == mask.sum()  # every pixel belongs to exactly one part


def test_split_n_through_the_service_creates_n_objects(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    reply = objects_edit.split_object(service, out, 1, n=3)
    assert len(reply["objects"]) == 3 and sum(p["areaPx"] for p in reply["objects"]) == 30 * 180


def test_split_refuses_a_line_that_misses_the_object_and_unknown_ways(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    with pytest.raises(BadRequest, match="move the line across"):
        objects_edit.split_object(service, out, 1, line_px=((0.0, 0.0), (0.0, 100.0)))
    with pytest.raises(BadRequest, match="exactly one"):
        split_mask(np.ones((4, 4), bool))
    with pytest.raises(BadRequest, match="two different points"):
        split_by_line(np.ones((4, 4), bool), ((1.0, 1.0), (1.0, 1.0)))
    with pytest.raises(BadRequest, match="at least two"):
        split_into(np.ones((4, 4), bool), 1)
    assert on_disk(out)["summary"]["analysed"] == 2  # nothing was written


# ---- reprofile --------------------------------------------------------------------------------------------------


def test_reprofile_refits_only_the_named_object_with_fixed_dims_and_keeps_class_and_embedding(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    before, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    fits_before = len(calls.fit)
    reply = objects_edit.reprofile_objects(service, out, fixed_dims={"1": {"length": 150.0}})
    (edited,) = reply["objects"]
    assert edited["id"] == 1 and edited["dimensionsMm"]["length"] == pytest.approx(150.0) and edited["fit"]["dimsFixed"] == {"length": 150.0}
    assert len(calls.fit) == fits_before + 1 and calls.fit[-1]["fixed_dims"] == {"length": 150.0}
    assert edited["class"] == record(before, 1)["class"] and edited["embedding"] == record(before, 1)["embedding"]
    saved = on_disk(out)
    assert record(saved, 2)["dimensionsMm"] == record(before, 2)["dimensionsMm"]
    assert saved["request"]["fixed_dims"] == {"1": {"length": 150.0}}
    # fixed dimensions accumulate, and null clears them
    objects_edit.reprofile_objects(service, out, fixed_dims={"1": {"width": 12.0}})
    assert record(on_disk(out), 1)["fit"]["dimsFixed"] == {"length": 150.0, "width": 12.0}
    objects_edit.reprofile_objects(service, out, fixed_dims={"1": None})
    assert record(on_disk(out), 1)["fit"]["dimsFixed"] is None and on_disk(out)["request"]["fixed_dims"] == {}


def test_reprofile_with_a_new_scale_refits_everything_and_turns_no_scale_into_ok(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service)
    assert on_disk(out)["status"] == "no_scale" and calls.fit == []
    reply = objects_edit.reprofile_objects(service, out, calibrate=CalibrateParams(mm_per_px=2.0))
    assert [o["id"] for o in reply["objects"]] == [1, 2] and reply["status"] == "ok"
    assert reply["objects"][0]["dimensionsMm"]["length"] == pytest.approx(360.0) and reply["objects"][0]["mmPerPx"] == 2.0
    saved = on_disk(out)
    assert saved["status"] == "ok" and "needs" not in saved and saved["calibration"]["mm_per_px"] == 2.0
    assert saved["overlay"]["fit"] == "fit-overlay.jpg" and (out / "fit-overlay.jpg").is_file()
    assert saved["request"]["calibrate"]["mm_per_px"] == 2.0


def test_reprofile_without_any_scale_says_what_to_send(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service)
    with pytest.raises(CalibrationNeeded) as caught:
        objects_edit.reprofile_objects(service, out, fixed_dims={"1": {"length": 100.0}})
    assert "mm_per_px" in (caught.value.fix or "")
    with pytest.raises(BadRequest, match="reference instance"):
        objects_edit.reprofile_objects(service, out, calibrate=CalibrateParams(reference_instance=1, reference_length_mm=100))
    with pytest.raises(BadRequest, match="no live object"):
        objects_edit.reprofile_objects(service, out, ids=[42], calibrate=SCALE)


# ---- add --------------------------------------------------------------------------------------------------------


def test_add_segments_a_prompted_object_with_the_prompt_stage(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    prompts: list[dict[str, Any]] = []

    def prompt_mask(rgb: np.ndarray, **kwargs: Any) -> dict[str, Any]:
        prompts.append(kwargs)
        mask = np.zeros(rgb.shape[:2], bool)
        mask[150:158, 100:140] = True
        return {"mask": mask, "stability": 0.8}

    service = dataclasses.replace(service, stages=dataclasses.replace(service.stages, prompt_mask=prompt_mask))
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    reply = objects_edit.add_object(service, out, point_px=(120.0, 154.0))
    assert reply["object"]["id"] == 3 and reply["object"]["source"] == "click" and reply["object"]["areaPx"] == 320
    assert prompts[0]["point_px"] == (120.0, 154.0) and prompts[0]["box_xywh"] is None and prompts[0]["method"] == "sam2"
    assert on_disk(out)["summary"]["analysed"] == 3 and on_disk(out)["edits"][0]["pointPx"] == [120.0, 154.0]

    def tiny(rgb: np.ndarray, **_: Any) -> dict[str, Any]:
        mask = np.zeros(rgb.shape[:2], bool)
        mask[10:12, 10:12] = True
        return {"mask": mask}

    small = dataclasses.replace(service, stages=dataclasses.replace(service.stages, prompt_mask=tiny))
    with pytest.raises(BadRequest, match="gave a mask of 4 px"):
        objects_edit.add_object(small, out, box_xywh=(5.0, 5.0, 10.0, 10.0))


# ---- guards -----------------------------------------------------------------------------------------------------


def test_an_old_result_a_missing_result_and_a_changed_photo_are_refused(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    with pytest.raises(BadRequest, match="no result directory"):
        objects_edit.merge_objects(service, tmp_path / "nowhere", [1, 2])
    saved = on_disk(out)
    (out / "objects.json").write_text(json.dumps({k: v for k, v in saved.items() if k != "request"}))
    with pytest.raises(BadRequest, match="predates the edit ops"):
        objects_edit.merge_objects(service, out, [1, 2])
    (out / "objects.json").write_text(json.dumps(saved))
    PilImage.fromarray(np.zeros((IMAGE_H, IMAGE_W, 3), np.uint8)).save(photo)
    with pytest.raises(BadRequest, match="changed since"):
        objects_edit.merge_objects(service, out, [1, 2])


# ---- HTTP + CLI -------------------------------------------------------------------------------------------------


def test_the_http_routes_return_the_updated_records(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    client = TestClient(create_app(service=service), base_url="http://127.0.0.1:8795")
    merged = client.post("/objects/merge", json={"out_dir": str(out), "ids": [1, 2]})
    assert merged.status_code == 200 and merged.json()["object"]["id"] == 3
    split = client.post("/objects/split", json={"out_dir": str(out), "id": 3, "n": 2})
    assert split.status_code == 200 and [o["id"] for o in split.json()["objects"]] == [4, 5]
    reprofile = client.post("/objects/reprofile", json={"out_dir": str(out), "fixed_dims": {"4": {"length": 99}}})
    assert reprofile.status_code == 200 and reprofile.json()["objects"][0]["dimensionsMm"]["length"] == pytest.approx(99.0)
    assert client.post("/objects/split", json={"out_dir": str(out), "id": 4}).status_code == 422  # neither line nor n
    assert client.post("/objects/split", json={"out_dir": str(out), "id": 4, "n": 2, "line_px": [[0, 0], [1, 1]]}).status_code == 422
    assert client.post("/objects/merge", json={"out_dir": str(out), "ids": [1]}).status_code == 422
    missing = client.post("/objects/merge", json={"out_dir": str(tmp_path / "nope"), "ids": [1, 2]})
    assert missing.status_code == 422 and missing.json()["error"]["code"] == "bad_request"
    assert client.post("/objects/add", json={"out_dir": str(out)}).status_code == 422
    foreign = client.post("/objects/merge", json={"out_dir": str(out), "ids": [4, 5]}, headers={"host": "evil.example"})
    assert foreign.status_code == 403


def test_the_cli_edits_a_result_directory(
    tmp_path: Path, photo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    monkeypatch.setattr(VisionService, "create", classmethod(lambda cls, config, **kw: service))
    assert cli.main(["objects", "merge", str(out), "1", "2"]) == 0
    assert json.loads(capsys.readouterr().out)["object"]["id"] == 3
    assert cli.main(["objects", "split", str(out), "3", "-n", "2"]) == 0
    assert [o["id"] for o in json.loads(capsys.readouterr().out)["objects"]] == [4, 5]
    assert cli.main(["objects", "reprofile", str(out), "--dim", "4:length=77"]) == 0
    assert json.loads(capsys.readouterr().out)["objects"][0]["dimensionsMm"]["length"] == pytest.approx(77.0)
    assert cli.main(["objects", "merge", str(out), "1", "99"]) == 2  # bad input


def test_dim_arguments_parse_and_reject_garbage() -> None:
    assert cli.parse_fixed_dims(["7:length=160,width=20", "8:none"]) == {"7": {"length": 160.0, "width": 20.0}, "8": None}
    for bad in ("length=3", "x:length=3", "7:length", "7:length=abc", "7:lenght=3", "7:length=-1"):
        with pytest.raises(BadRequest):
            cli.parse_fixed_dims([bad])


def test_reprofile_feeds_the_fit_the_recognition_that_produced_the_class(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    seen: list[Any] = []
    original = objects.fit_objects

    def spy(*args: Any, **kwargs: Any) -> Any:
        seen.append(args[6])  # the `recognition` argument
        return original(*args, **kwargs)

    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    try:
        objects.fit_objects = spy  # type: ignore[assignment]
        objects_edit.reprofile_objects(service, out, fixed_dims={"1": {"length": 120.0}})
    finally:
        objects.fit_objects = original  # type: ignore[assignment]
    entry = seen[-1]["objects"]["1"]
    assert entry["tool_class"] == "screwdriver" and entry["prob"] == pytest.approx(0.8) and entry["topk"][0]["tool_class"] == "screwdriver"


def test_reprofile_and_add_refuse_bad_keys_prompts_and_empty_masks(tmp_path: Path, photo: Path) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service, calibrate=SCALE)
    client = TestClient(create_app(service=service), base_url="http://127.0.0.1:8795")
    assert client.post("/objects/reprofile", json={"out_dir": str(out), "fixed_dims": {"abc": {"length": 1}}}).status_code == 422
    assert client.post("/objects/add", json={"out_dir": str(out), "box_xywh": [1, 1, 0, 5]}).status_code == 422
    for bad in ({"1": {"length": -5}}, {"1": {"lenght": 5}}):
        assert client.post("/objects/reprofile", json={"out_dir": str(out), "fixed_dims": bad}).status_code == 422
    with pytest.raises(BadRequest, match="outside the 240x160 photo"):
        objects_edit.add_object(service, out, point_px=(500.0, 10.0))
    with pytest.raises(BadRequest, match="must have a positive size and lie inside"):
        objects_edit.add_object(service, out, box_xywh=(200.0, 100.0, 80.0, 80.0))
    PilImage.fromarray(np.zeros((IMAGE_H, IMAGE_W), np.uint8)).save(out / "masks/001.png")
    with pytest.raises(BadRequest, match="mask of object 1"):
        objects_edit.merge_objects(service, out, [1, 2])


def test_split_refuses_slivers_instead_of_losing_their_pixels() -> None:
    mask = np.zeros((IMAGE_H, IMAGE_W), bool)
    mask[40:100, 20:100] = True
    with pytest.raises(BadRequest, match="under 150 px"):
        split_mask(mask, line_px=((21.0, 0.0), (21.0, 100.0)))  # the left side is 2 columns = 120 px


def test_the_cli_reprofiles_with_a_scale(
    tmp_path: Path, photo: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    service, _ = make_service(tmp_path)
    _, out = first_run(tmp_path, photo, service)
    monkeypatch.setattr(VisionService, "create", classmethod(lambda cls, config, **kw: service))
    assert cli.main(["objects", "reprofile", str(out), "--mm-per-px", "2"]) == 0
    assert json.loads(capsys.readouterr().out)["objects"][0]["mmPerPx"] == 2.0
