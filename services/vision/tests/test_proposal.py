"""Proposal builder: ops shape, confidence threshold, auto-apply mode, holder suggestions from bank `fitsTool` hints."""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import pytest

from helpers import fake_fit
from hsw_vision.geometry import Board, camera_from_calibration
from hsw_vision.proposal import build_proposal, suggest_holders

SHA = "ab12cd34" + "0" * 56


def bank_index() -> dict[str, Any]:
    def element(ident: str, name: str, tool_class: str, dims: dict[str, list[float]] | None, capacity: int) -> dict[str, Any]:
        fits: dict[str, Any] = {"toolClass": tool_class, "capacity": capacity}
        if dims:
            fits["dims"] = {k: {"min": lo, "max": hi} for k, (lo, hi) in dims.items()}
        return {
            "id": ident,
            "name": {"ru": name, "en": name},
            "fitsTool": [fits],
            "assets": {"thumbnail": {"path": f"thumb/{ident}.webp"}},
        }

    return {
        "toolClasses": [
            {"id": "screwdriver", "name": {"en": "Screwdriver", "ru": "Отвёртка"}, "synonyms": {"en": [], "ru": []}},
            {"id": "pliers", "name": {"en": "Pliers", "ru": "Плоскогубцы"}, "synonyms": {"en": [], "ru": []}},
        ],
        "elements": [
            element("sd-wide", "Wide screwdriver rack", "screwdriver", {"length": (100, 400), "width": (5, 40)}, 6),
            element("sd-tight", "Tight screwdriver slot", "screwdriver", {"length": (150, 300), "width": (10, 30)}, 1),
            element("sd-short", "Short bits holder", "screwdriver", {"length": (20, 100)}, 12),
            element("pl-any", "Pliers hook", "pliers", None, 1),
        ],
    }


def obj(instance_id: int, confidence: float, tool_class: str | None = "screwdriver", prob: float = 0.8, length: float = 200, needs_view: bool = False) -> dict[str, Any]:
    fit = {
        "kind": "lathe",
        "method": "closed_form",
        "device": "cpu",
        "tries": 1,
        "timing_s": {},
        "dims_mm": {"length_mm": length, "max_width_mm": 20.0, "thickness_mm": 12.0},
        "confidence": {"train_min_iou": confidence, "n_views": 1},
    }
    return {
        "instance_id": instance_id,
        "centre_mm": [100.0 + instance_id * 50, 80.0],
        "fit": fit,
        "check": {"status": "unverified", "needs_views": []},
        "confidence": confidence,
        "needs_view": needs_view,
        "recognition": {"tool_class": tool_class, "prob": prob, "topk": [], "bank_topk": []},
        "glb": f"models/fit-{instance_id:03d}.glb",
        "glb_pose": {"heading_deg": 30.0, "x": 100.0 + instance_id * 50, "y": 80.0, "z": 6.0},
    }


def build(objects: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
    defaults: dict[str, Any] = {"photo_id": "p-1", "image_sha256": SHA, "calibration": {"method": "grid", "core": {"method": "grid"}}, "bank_index": bank_index()}
    return build_proposal(objects=objects, **{**defaults, **kwargs})


def test_each_object_is_a_model_ref_plus_a_vision_sourced_tool_item() -> None:
    proposal = build([obj(1, 0.9)])
    ops = proposal["ops"]
    assert [op["type"] for op in ops] == ["addModelRef", "addItem"]
    model, item = ops[0]["model"], ops[1]["item"]
    assert item["kind"] == "tool" and item["modelRefId"] == model["id"] and model["forItemId"] == item["id"]
    assert item["source"] == {"type": "vision", "confidence": 0.9, "photoId": "p-1", "by": "hsw-vision"}
    assert item["toolClass"] == "screwdriver" and item["label"] == "Screwdriver"
    assert item["params"] == {"length": 200.0, "width": 20.0, "thickness": 12.0}
    assert item["pose"]["rotZ"] == 30.0 and item["pose"]["z"] == 6.0
    assert model["dimensionsMm"] == {"x": 200.0, "y": 20.0, "z": 12.0}
    assert model["status"] == "candidate" and model["source"]["type"] == "generated"
    json.dumps(proposal)  # plain JSON


def test_ids_are_deterministic_and_match_the_core_id_pattern() -> None:
    import re

    a, b = build([obj(2, 0.9), obj(1, 0.9)]), build([obj(1, 0.9), obj(2, 0.9)])
    ids = [op["item"]["id"] for op in a["ops"] if op["type"] == "addItem"]
    assert ids == [op["item"]["id"] for op in b["ops"] if op["type"] == "addItem"]
    pattern = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
    assert all(pattern.match(i) for i in ids + [m["model"]["id"] for m in a["ops"] if m["type"] == "addModelRef"])


def test_without_a_photo_id_the_source_omits_it() -> None:
    item = build([obj(1, 0.9)], photo_id=None)["ops"][1]["item"]
    assert "photoId" not in item["source"]


def test_default_is_never_auto_apply() -> None:
    proposal = build([obj(1, 0.99)])
    assert proposal["autoApplyConfidence"] is None
    assert proposal["items"][0]["autoApply"] is False and proposal["summary"]["autoApply"] == 0


def test_auto_mode_flags_only_confident_recognised_items_without_pending_views() -> None:
    objects = [
        obj(1, 0.95),
        obj(2, 0.70),  # below the auto threshold
        obj(3, 0.95, tool_class=None, prob=0.1),  # unrecognised
        obj(4, 0.95, needs_view=True),
    ]
    proposal = build(objects, auto_apply_confidence=0.9)
    flags = {i["instanceId"]: i["autoApply"] for i in proposal["items"]}
    assert flags == {1: True, 2: False, 3: False, 4: False}
    assert proposal["summary"]["autoApply"] == 1
    # every op is still in the proposal: applying is the caller's decision
    assert len(proposal["ops"]) == 8


def test_confidence_below_the_threshold_needs_confirmation() -> None:
    proposal = build([obj(1, 0.4), obj(2, 0.5), obj(3, 0.9)], min_confidence=0.5)
    status = {i["instanceId"]: i["status"] for i in proposal["items"]}
    assert status == {1: "needs_confirmation", 2: "ok", 3: "ok"}
    assert proposal["summary"]["needsConfirmation"] == 1


def test_unrecognised_object_has_no_tool_class_and_a_generic_label() -> None:
    item = build([obj(1, 0.9, tool_class="screwdriver", prob=0.1)])["items"][0]
    assert item["toolClass"] is None and item["label"] == "Object 1"
    assert "toolClass" not in item["ops"][1]["item"]


def test_holder_suggestions_use_fits_tool_ranges_and_rank_by_tightness_then_capacity() -> None:
    suggestions = suggest_holders(bank_index(), "screwdriver", {"length": 200, "width": 20})
    assert [s["bankId"] for s in suggestions][:2] == ["sd-tight", "sd-wide"]
    assert suggestions[0]["tightness"] > suggestions[1]["tightness"]
    assert all(s["inRange"] for s in suggestions[:2])
    out_of_range = [s for s in suggestions if not s["inRange"]]
    assert [s["bankId"] for s in out_of_range] == ["sd-short"]  # 200 mm is outside 20..100, kept last
    assert suggestions[-1]["bankId"] == "sd-short"
    assert suggestions[0]["thumbnail"] == "/bank/assets/thumb/sd-tight.webp"


def test_hint_without_ranges_matches_by_class_only() -> None:
    assert [s["bankId"] for s in suggest_holders(bank_index(), "pliers", {"length": 90})] == ["pl-any"]
    assert suggest_holders(bank_index(), "hammer", {"length": 90}) == []
    assert suggest_holders(None, "pliers", {}) == []
    assert suggest_holders(bank_index(), None, {}) == []


def test_round_tools_also_match_on_diameter_aliases() -> None:
    index = bank_index()
    index["elements"][0]["fitsTool"][0]["dims"] = {"shaftDiameter": {"min": 5, "max": 30}}
    item = build([obj(1, 0.9)], bank_index=index)["items"][0]
    assert item["holders"][0]["inRange"] is True  # `lathe` kind: width doubles as shaftDiameter


def test_holder_proposals_group_by_capacity_and_snap_to_cells_on_a_grid_photo() -> None:
    index = bank_index()
    index["elements"] = [e for e in index["elements"] if e["id"] == "sd-wide"]  # capacity 6
    objects = [obj(i, 0.9) for i in range(1, 8)]  # 7 screwdrivers -> 2 holders (6 + 1)
    proposal = build(objects, bank_index=index, board=Board())
    holders = proposal["holders"]
    assert [len(h["forItems"]) for h in holders] == [6, 1]
    holder_item = holders[0]["ops"][0]["item"]
    assert holder_item["kind"] == "holder" and holder_item["bankId"] == "sd-wide"
    assert set(holder_item["cell"]) == {"col", "row"}
    assert holder_item["source"]["type"] == "vision"
    # holders are separate optional proposals, not mixed into the tool ops
    assert all(op["item"]["kind"] == "tool" for op in proposal["ops"] if op["type"] == "addItem")


def test_holders_have_no_cell_when_the_photo_is_not_grid_calibrated() -> None:
    proposal = build([obj(1, 0.9)], calibration={"method": "two-point", "core": {}})
    assert "cell" not in proposal["holders"][0]["ops"][0]["item"]


def test_anchor_shifts_every_pose() -> None:
    base = build([obj(1, 0.9)])["ops"][1]["item"]["pose"]
    moved = build([obj(1, 0.9)], anchor_mm=(40.8764, 23.6))["ops"][1]["item"]["pose"]
    assert moved["x"] == pytest.approx(base["x"] + 40.8764, abs=0.01)
    assert moved["y"] == pytest.approx(base["y"] + 23.6, abs=0.01)


def test_calibration_core_object_travels_with_the_proposal() -> None:
    assert build([obj(1, 0.9)])["calibration"] == {"method": "grid"}


def test_fake_fit_helper_matches_the_library_result_keys_the_builder_reads() -> None:
    from hsw_vision.stages.fit import fit_confidence

    cal = {
        "camera": {"K": np.eye(3).tolist(), "R": np.eye(3).tolist(), "t_mm": [0, 0, 100]},
        "mm_per_px": 1.0,
        "plane_depth_mm": 100.0,
    }
    camera = camera_from_calibration(cal)
    mask = np.zeros((20, 40), bool)
    mask[5:10, 5:30] = True
    fit = fake_fit(mask, camera)
    assert fit_confidence(fit, single_view_cap=0.6) == 0.6  # single view: capped
    fit["confidence"] = {"train_min_iou": 0.93, "heldout_iou": 0.81, "n_views": 3}
    assert fit_confidence(fit, single_view_cap=0.6) == 0.81  # held-out view wins
    fit["confidence"] = {"train_min_iou": 0.93, "heldout_iou": None, "n_views": 3}
    assert fit_confidence(fit, single_view_cap=0.6) == 0.93  # several views, no held-out


def test_ids_follow_the_segmentation_instance_not_the_list_position() -> None:
    """Review finding: positional ids made `instances=[2]` reuse the id of instance 1 from an earlier run."""
    both = build([obj(1, 0.9), obj(2, 0.9)])
    only_second = build([obj(2, 0.9)])
    ids_both = {i["instanceId"]: (i["id"], i["modelId"]) for i in both["items"]}
    ids_alone = {i["instanceId"]: (i["id"], i["modelId"]) for i in only_second["items"]}
    assert ids_both[2] == ids_alone[2]
    assert ids_both[1] != ids_both[2]
