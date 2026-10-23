"""Multi-view check on RECORDED real fits (hsw-editor #13: regression test on a recorded fit; no GPU, no models).

`tests/data/carpet-fit/` (18 KB, `tests/data/record_carpet_fit.py`) holds three library fits of the carpet photo
(multimeter = lathe, box, flat) and each object's mask seen from a second viewpoint (the carpet photo as a camera 25 degrees
up the world X axis would see it, registered by `register_views`). The assertions are the numbers measured when it was
recorded, with a tolerance: a good fit holds out with a high IoU, a wrong one with a low IoU and asks for views.
"""

from __future__ import annotations

import copy
import json
import math
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest

pytest.importorskip("threed_vision.view_check", reason="the threed-vision library is required")
cv2 = pytest.importorskip("cv2")

from fastapi.testclient import TestClient  # noqa: E402
from helpers import make_service  # noqa: E402

from hsw_vision.app import create_app  # noqa: E402
from hsw_vision.confidence import assess  # noqa: E402
from hsw_vision.errors import BadRequest  # noqa: E402
from hsw_vision.stages import multiview  # noqa: E402

DATA = Path(__file__).parent / "data" / "carpet-fit"
RECORD: dict[str, Any] = json.loads((DATA / "fits.json").read_text())
RECORDED: dict[str, Any] = RECORD["objects"]
#: Held-out IoU measured at recording time, per object id.
HELD_OUT = {"10": 0.970, "25": 0.912, "26": 0.921}
TOLERANCE = 0.03
THRESHOLD = 0.75
CAP = 0.6  # `single_view_confidence_cap`


def view_of(obj: dict[str, Any]) -> dict[str, Any]:
    """The object's mask as photo B's camera sees it (one camera for every object)."""
    return {"mask_path": str(DATA / obj["viewMask"]), **RECORD["camera"]}


def rotated(fit: dict[str, Any], degrees: float) -> dict[str, Any]:
    """The same fit turned about the object's thickness axis: right size and shape, wrong pose."""
    wrong = copy.deepcopy(fit)
    a = math.radians(degrees)
    about_z = np.array([[math.cos(a), -math.sin(a), 0], [math.sin(a), math.cos(a), 0], [0, 0, 1.0]])
    wrong["pose"]["R0"] = (np.array(fit["pose"]["R0"]) @ about_z).tolist()
    return wrong


def scaled(fit: dict[str, Any], factor: float) -> dict[str, Any]:
    """The same fit `factor` times too big (or small): right pose and shape, wrong size."""
    wrong = copy.deepcopy(fit)
    wrong["params"]["L_mm"] *= factor
    wrong["params"]["w_mm"] = [w * factor for w in wrong["params"]["w_mm"]]
    return wrong


def score(fit: dict[str, Any], obj: dict[str, Any]) -> tuple[dict[str, Any], Any]:
    check = multiview.check_fit(fit, [view_of(obj)], flag_below=THRESHOLD)
    return check, assess(fit, check, single_view_cap=CAP, view_flag_iou=THRESHOLD)


@pytest.mark.parametrize("obj_id", sorted(RECORDED))
def test_a_good_fit_holds_out_with_a_high_iou_and_needs_no_view(obj_id: str) -> None:
    obj = RECORDED[obj_id]
    check, verdict = score(obj["fit"], obj)
    iou = check["views"][0]["iou"]
    assert iou == pytest.approx(HELD_OUT[obj_id], abs=TOLERANCE)
    assert check["mode"] == "heldout" and check["status"] == "ok" and check["min_iou"] == pytest.approx(iou)
    assert verdict.confidence == pytest.approx(iou)  # the worst held-out silhouette IoU IS the confidence
    assert verdict.confidence > obj["trainIou"] - 0.1  # the view agrees with what the fit saw
    assert not verdict.needs_view and check["needs_views"] == []


@pytest.mark.parametrize("obj_id", sorted(RECORDED))
@pytest.mark.parametrize(
    ("wrong", "ceiling"),
    [(lambda f: rotated(f, 35.0), 0.60), (lambda f: scaled(f, 1.6), 0.40), (lambda f: scaled(f, 0.5), 0.30)],
    ids=["rotated-35deg", "1.6x-too-big", "half-size"],
)
def test_a_wrong_fit_holds_out_with_a_low_iou_and_asks_for_views(obj_id: str, wrong: Any, ceiling: float) -> None:
    obj = RECORDED[obj_id]
    check, verdict = score(wrong(obj["fit"]), obj)
    assert check["views"][0]["iou"] < ceiling
    assert check["status"] == "flagged" and check["views"][0]["flag"] is True
    assert verdict.confidence < ceiling and verdict.needs_view
    assert check["needs_views"], "a flagged fit suggests where to shoot next"
    for suggestion in check["needs_views"]:
        assert -180.0 <= suggestion["azimuth_deg"] <= 180.0 and -90.0 <= suggestion["elevation_deg"] <= 90.0


@pytest.mark.parametrize("obj_id", sorted(RECORDED))
def test_one_photo_is_capped_and_unverified_with_suggested_views(obj_id: str) -> None:
    obj = RECORDED[obj_id]
    check = multiview.check_fit(obj["fit"], [], flag_below=THRESHOLD)
    verdict = assess(obj["fit"], check, single_view_cap=CAP, view_flag_iou=THRESHOLD)
    assert check["mode"] == "single_photo" and check["status"] == "unverified" and check["min_iou"] is None
    assert verdict.confidence == pytest.approx(CAP)  # the training IoU is 0.94-0.97: still capped
    assert verdict.needs_view and check["needs_views"]
    assert check["sanity"]["ok"] is True  # a real fit passes the synthetic-view sanity check


def test_the_threshold_is_configurable() -> None:
    obj = RECORDED["26"]
    off_by_35 = rotated(obj["fit"], 35.0)  # held-out IoU about 0.56
    for threshold, wants_view in ((0.4, False), (0.75, True)):
        check = multiview.check_fit(off_by_35, [view_of(obj)], flag_below=threshold)
        verdict = assess(off_by_35, check, single_view_cap=CAP, view_flag_iou=threshold)
        assert verdict.needs_view is wants_view and check["flag_below"] == threshold
    strict = multiview.check_fit(obj["fit"], [view_of(obj)], flag_below=0.99)
    assert strict["status"] == "flagged"  # even the good fit (0.92) is below 0.99


def test_the_request_view_event_is_aggregated_and_lists_the_least_confident_first() -> None:
    items = []
    for obj_id, factor in (("10", 1.6), ("25", 0.5), ("26", 1.0)):
        obj = RECORDED[obj_id]
        check, verdict = score(scaled(obj["fit"], factor), obj)
        items.append({"id": obj_id, "confidence": verdict.confidence, "needs_view": verdict.needs_view, "check": check})
    event = multiview.request_view_event(items, photo_id="p-1", threshold=THRESHOLD)
    assert event is not None and event["type"] == "request_view"
    assert [i["itemId"] for i in event["items"]] == ["25", "10"]  # the good one (26) is not asked about
    assert event["items"][0]["confidence"] < event["items"][1]["confidence"]
    assert event["suggested"], "the event carries the union of suggested views"


def test_the_summary_keeps_photo_views_apart_from_drawn_ones() -> None:
    obj = RECORDED["25"]
    check, _ = score(obj["fit"], obj)
    drawn = [{"source": "generated", "view": "side", "iou": 0.1, "flag": True}]
    summary = multiview.summarise(check, drawn)
    assert summary is not None and summary["status"] == "ok"
    assert summary["minIou"] == pytest.approx(check["min_iou"])  # a bad drawing does not touch the photo score
    assert [v["source"] for v in summary["views"]] == ["photo"] and summary["generatedViews"] == drawn
    assert multiview.summarise(None) is None


def drawing_of(fit: dict[str, Any], view: str) -> np.ndarray:
    """What an ideal drawing of `fit` seen from `view` would be: its silhouette on white, turned, shrunk and moved."""
    az, el = multiview.GENERATED_VIEW_ANGLES[view]
    mask = multiview.model_silhouette(fit, az, el)
    big = cv2.resize(mask.astype(np.uint8), (768, 768), interpolation=cv2.INTER_NEAREST)
    matrix = cv2.getRotationMatrix2D((384, 384), 17.0, 0.8)
    matrix[:, 2] += (20, -10)
    big = cv2.warpAffine(big, matrix, (768, 768), flags=cv2.INTER_NEAREST)
    image = np.full((768, 768, 3), 255, np.uint8)
    image[big > 0] = (90, 60, 40)
    return image


def test_the_view_names_follow_the_draw_prompt_convention() -> None:
    """The reference the generator gets is the photo's cut-out presented as the FRONT view (long axis horizontal,
    `apps/server/src/tools/draw-view.ts`), so front = down the thickness axis, side = the end, top = the profile."""
    angles = multiview.GENERATED_VIEW_ANGLES
    assert angles["front"] == (0.0, 90.0) and angles["back"] == (0.0, -90.0)  # the length x width silhouette, the photo's own
    assert angles["side"] == (0.0, 0.0)  # looking along the length: width x thickness
    assert angles["top"] == (90.0, 0.0)  # looking along the width: length x thickness
    fit = RECORDED["10"]["fit"]  # a flat part: 211 mm long, 18 mm thick
    area, longest = {}, {}
    for name, (az, el) in angles.items():
        mask = multiview.model_silhouette(fit, az, el)
        ys, xs = np.nonzero(mask)
        area[name], longest[name] = int(mask.sum()), max(xs.max() - xs.min(), ys.max() - ys.min()) + 1
    assert area["front"] > 3 * max(area["side"], area["top"])  # looking down the thickness axis shows the whole flat face
    assert area["back"] == pytest.approx(area["front"], rel=0.05)
    assert longest["top"] > 1.2 * longest["side"]  # the profile runs along the length, the end across the width


@pytest.mark.parametrize("obj_id", sorted(RECORDED))
def test_a_drawing_of_the_same_object_agrees_and_one_of_another_is_flagged(obj_id: str) -> None:
    fit = RECORDED[obj_id]["fit"]
    other = RECORDED[{"10": "25", "25": "10", "26": "10"}[obj_id]]["fit"]
    for view in ("front", "side", "top"):
        same, different = multiview.check_generated(
            fit, [{"image": drawing_of(fit, view), "view": view}, {"image": drawing_of(other, view), "view": view}]
        )
        assert same["source"] == "generated" and same["iou"] > 0.9 and not same["flag"]
        assert different["iou"] < same["iou"] - 0.05
        if view != "front":  # the outlines of two elongated tools seen from above are alike (0.88); the profile and the end tell them apart
            assert different["iou"] < 0.7 and different["flag"]


def test_a_drawing_missing_the_tip_of_a_long_part_is_noticed() -> None:
    """The flat part is 211 x 18 mm in its profile (11:1): a canvas too small for that clips both tips away and a drawing
    without one still scores about 1."""
    fit = RECORDED["10"]["fit"]
    whole = drawing_of(fit, "top")
    ink = np.nonzero((255 - whole.min(axis=2)) > multiview._WHITE_TOLERANCE)
    left, right = ink[1].min(), ink[1].max()
    cut = whole.copy()
    cut[:, left + int(0.75 * (right - left)) :] = 255  # the right quarter of the part erased
    row_whole, row_cut = multiview.check_generated(fit, [{"image": whole, "view": "top"}, {"image": cut, "view": "top"}])
    assert row_whole["iou"] > 0.95 and row_cut["iou"] < 0.9


def test_a_thin_part_in_a_huge_drawing_is_still_a_drawing() -> None:
    image = np.full((3000, 3000, 3), 255, np.uint8)
    image[1500:1503, 200:2800] = 0  # a 3 px line: 7800 px = 0.087 % of the image, under the 0.1 % floor
    assert multiview.drawn_silhouette(image) is None
    image[1500:1504, 200:2800] = 0  # 4 px: 0.116 %, a drawing
    row = multiview.check_generated(RECORDED["10"]["fit"], [{"image": image, "view": "top"}])[0]
    assert row["usable"] is True and row["iou"] is not None and 0.0 <= row["iou"] <= 1.0


def test_a_blank_drawing_is_unusable_and_flagged_not_scored() -> None:
    row = multiview.check_generated(RECORDED["25"]["fit"], [{"image": np.full((64, 64, 3), 255, np.uint8), "view": "top"}])[0]
    assert row["usable"] is False and row["iou"] is None and row["flag"] is True


@pytest.mark.parametrize(
    ("view", "azimuth", "elevation"),
    [(None, None, None), ("side", 10.0, 20.0), ("side", 10.0, None), (None, None, 20.0)],
    ids=["nothing", "name-and-angles", "name-and-one-angle", "one-angle"],
)
def test_a_drawing_needs_exactly_one_direction(view: str | None, azimuth: float | None, elevation: float | None) -> None:
    with pytest.raises(BadRequest):
        multiview.view_direction(view, azimuth, elevation)
    blank = np.full((64, 64, 3), 255, np.uint8)
    with pytest.raises(BadRequest):
        multiview.check_generated(RECORDED["25"]["fit"], [{"image": blank, "view": view, "azimuth_deg": azimuth, "elevation_deg": elevation}])
    assert multiview.view_direction(None, 30.0, 40.0) == (30.0, 40.0) and multiview.view_direction("top", None, None) == (90.0, 0.0)


def test_a_drawing_with_a_transparent_background_is_flattened_on_white(tmp_path: Path) -> None:
    fit = RECORDED["10"]["fit"]
    opaque = drawing_of(fit, "top")
    rgba = cv2.cvtColor(opaque, cv2.COLOR_RGB2BGRA)
    background = opaque.min(axis=2) == 255
    rgba[background] = (0, 0, 0, 0)  # what many generators return: a transparent background (black in the colour channels)
    path = tmp_path / "transparent.png"
    cv2.imwrite(str(path), rgba)
    flattened = multiview.load_drawing(path)
    assert flattened.shape == opaque.shape and (flattened[background] == 255).all()
    same, transparent = multiview.check_generated(fit, [{"image": opaque, "view": "top"}, {"image": flattened, "view": "top"}])
    assert transparent["usable"] is True and transparent["iou"] == pytest.approx(same["iou"], abs=0.01)
    with pytest.raises(BadRequest):
        multiview.load_drawing(tmp_path / "missing.png")


def test_a_16_bit_mask_file_is_binarised_at_half_its_range(tmp_path: Path) -> None:
    mask = np.zeros((8, 8), np.uint16)
    mask[2:4, 2:4] = 65535
    mask[5:7, 5:7] = 300  # dark grey: background, not the object
    path = tmp_path / "mask16.png"
    cv2.imwrite(str(path), mask)
    loaded = multiview.load_mask_file(path)
    assert loaded.sum() == 4 and loaded[2, 2] and not loaded[5, 5]
    with pytest.raises(BadRequest):
        multiview.load_mask_file(tmp_path / "missing.png")


def test_a_mask_file_is_read_by_its_alpha_when_that_varies_and_by_its_grey_otherwise(tmp_path: Path) -> None:
    object_px = (slice(2, 4), slice(2, 4))
    cutout = np.zeros((8, 8, 4), np.uint8)  # a cut-out: the object is opaque (any colour), the rest transparent
    cutout[object_px] = (10, 20, 200, 255)
    opaque = np.zeros((8, 8, 4), np.uint8)  # an exported mask: white object on black, fully opaque everywhere
    opaque[..., 3] = 255
    opaque[object_px] = (255, 255, 255, 255)
    colour = np.zeros((8, 8, 3), np.uint8)  # a colour image: red background is dark in grey, a white object is bright
    colour[...] = (0, 0, 255)
    colour[object_px] = (255, 255, 255)
    for name, image in (("cutout", cutout), ("opaque", opaque), ("colour", colour)):
        path = tmp_path / f"{name}.png"
        cv2.imwrite(str(path), image)
        loaded = multiview.load_mask_file(path)
        assert loaded.sum() == 4 and loaded[object_px].all(), name


def test_a_mask_file_without_foreground_is_rejected_not_scored_as_a_failed_fit(tmp_path: Path) -> None:
    for name, image in (("zero-one", np.eye(8, dtype=np.uint8)), ("blank", np.zeros((8, 8), np.uint8))):  # 0/1 values are all below half range
        path = tmp_path / f"{name}.png"
        cv2.imwrite(str(path), image)
        with pytest.raises(BadRequest, match="no foreground"):
            multiview.load_mask_file(path)


def test_the_multiview_endpoint_scores_photos_by_mask_file_and_drawings_as_hints(tmp_path: Path) -> None:
    obj = RECORDED["26"]
    drawing = tmp_path / "side.png"
    cv2.imwrite(str(drawing), cv2.cvtColor(drawing_of(obj["fit"], "side"), cv2.COLOR_RGB2BGR))
    service, _ = make_service(tmp_path)
    service.stages = replace(service.stages, check_fit=multiview.check_fit, check_generated=multiview.check_generated)
    client = TestClient(create_app(service), base_url="http://127.0.0.1:8795")
    record_fit = {**obj["fit"], "glb": "models/026.glb", "glbPose": {"heading_deg": 0.0, "x": 1.0, "y": 2.0, "z": 3.0}, "centreMm": [1.0, 2.0], "dimsFixed": None}
    body = {
        "fit": record_fit,  # the fit as `objects.json` stores it (what the server sends): the library's keys plus the GLB bookkeeping
        "views": [view_of(obj)],
        "generated_views": [{"image_path": str(drawing), "view": "side"}],
        "flag_below": THRESHOLD,
    }
    data = client.post("/multiview", json=body).json()
    assert data["status"] == "ok" and data["confidence"] == pytest.approx(HELD_OUT["26"], abs=TOLERANCE)
    assert data["request_view"] is False
    generated = data["generatedViews"]
    assert len(generated) == 1 and generated[0]["source"] == "generated" and generated[0]["iou"] > 0.9
    assert data["multiView"]["generatedViews"] == generated and data["multiView"]["minIou"] == data["min_iou"]
    # the drawing alone changes nothing about the confidence: without the photo view the fit is the capped single-photo one
    alone = client.post("/multiview", json={**body, "views": []}).json()
    assert alone["status"] == "unverified" and alone["confidence"] == pytest.approx(CAP) and alone["request_view"] is True
    assert alone["generatedViews"][0]["iou"] > 0.9


def _client_and_body(tmp_path: Path) -> tuple[TestClient, dict[str, Any], Path]:
    obj = RECORDED["26"]
    drawing = tmp_path / "side.png"
    cv2.imwrite(str(drawing), cv2.cvtColor(drawing_of(obj["fit"], "side"), cv2.COLOR_RGB2BGR))
    service, _ = make_service(tmp_path)
    service.stages = replace(service.stages, check_fit=multiview.check_fit, check_generated=multiview.check_generated)
    client = TestClient(create_app(service), base_url="http://127.0.0.1:8795")
    return client, {"fit": obj["fit"], "views": [view_of(obj)], "generated_views": [{"image_path": str(drawing), "view": "side"}]}, drawing


def test_a_photo_view_may_carry_its_mask_as_pixels(tmp_path: Path) -> None:
    client, body, _ = _client_and_body(tmp_path)
    mask = (cv2.imread(str(DATA / RECORDED["26"]["viewMask"]), cv2.IMREAD_GRAYSCALE) > 127).astype(int).tolist()  # JSON booleans as ints
    pixels = {k: v for k, v in body["views"][0].items() if k != "mask_path"} | {"mask": mask}
    by_pixels = client.post("/multiview", json={**body, "views": [pixels], "generated_views": []}).json()
    by_file = client.post("/multiview", json={**body, "generated_views": []}).json()
    assert by_pixels["views"][0]["iou"] == pytest.approx(by_file["views"][0]["iou"])


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param({"generated_views": [{"image_path": "x.png"}]}, id="no-direction"),
        pytest.param({"generated_views": [{"image_path": "x.png", "view": "side", "azimuth_deg": 1.0, "elevation_deg": 2.0}]}, id="two-directions"),
        pytest.param({"generated_views": [{"image_path": "x.png", "azimuth_deg": float("nan"), "elevation_deg": 0.0}]}, id="nan-angle"),
        pytest.param({"views": [{"K": RECORD["camera"]["K"], "R": RECORD["camera"]["R"], "t": RECORD["camera"]["t"]}]}, id="view-without-mask"),
        pytest.param({"views": [{**RECORD["camera"], "mask": [[1]], "mask_path": "m.png"}]}, id="view-with-two-masks"),
        pytest.param({"views": [{**RECORD["camera"], "mask": [[1]], "K": [[float("nan")] * 3] * 3}]}, id="nan-camera"),
        pytest.param({"views": [{**RECORD["camera"], "mask": [[1]], "t": [0.0, 1.0]}]}, id="short-translation"),
        pytest.param({"views": [{**RECORD["camera"], "mask": [[1, 0], [1]]}]}, id="ragged-mask"),
        pytest.param({"views": [{**RECORD["camera"], "mask": []}]}, id="empty-mask"),
    ],
)
def test_a_malformed_request_is_a_422_never_a_500(tmp_path: Path, bad: dict[str, Any]) -> None:
    client, body, _ = _client_and_body(tmp_path)
    raw = json.dumps({**body, **bad})  # json.dumps writes NaN as a bare token, which a hand-written client can send too
    assert client.post("/multiview", content=raw, headers={"content-type": "application/json"}).status_code == 422
