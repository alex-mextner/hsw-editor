"""Proposal builder: pipeline results -> a batch of `packages/core` ops the UI/agent confirms. Pure (no models).

Nothing here applies anything. Each detected object yields `[addModelRef, addItem]` (a tool item with
`source: {type: "vision", confidence, photoId, by}`); holders suggested from the bank's `fitsTool` hints are separate
optional proposals. `autoApply` marks the items a caller configured to be applied without asking
(`auto_apply_confidence`, default None = never): those at or above the threshold, recognised, not asking for a view.
"""

from __future__ import annotations

from typing import Any

from hsw_vision.geometry import Board, nearest_cell

PROPOSAL_VERSION = 1
PRODUCER = "hsw-vision"
#: A tool class is only attached when the recogniser's margin share is at least this.
MIN_RECOGNITION_PROB = 0.3
ROUND_KINDS = {"lathe", "cylinder_capsule", "lathe_profile", "ring_lathe"}
STATUS_OK = "ok"
STATUS_NEEDS_CONFIRMATION = "needs_confirmation"


def short_id(image_sha256: str) -> str:
    return image_sha256[:8] or "00000000"


def measured_dims(dimensions_mm: dict[str, float], kind: str | None) -> dict[str, float]:
    """Dimension keys in the bank's vocabulary for `fitsTool` matching (`diameter` aliases for round tools)."""
    dims = {k: v for k, v in dimensions_mm.items() if v is not None}
    if kind in ROUND_KINDS and "width" in dims:
        dims["diameter"] = dims["shaftDiameter"] = dims["width"]
    return dims


def _tightness(value: float, low: float, high: float) -> float:
    half = max((high - low) / 2.0, 1e-6)
    return max(0.0, 1.0 - abs(value - (low + high) / 2.0) / half)


def suggest_holders(
    bank_index: dict[str, Any] | None, tool_class: str | None, dims: dict[str, float], limit: int = 3
) -> list[dict[str, Any]]:
    """Bank holders whose `fitsTool[toolClass].dims` ranges contain the measured dimensions.

    Rank: tightness (how centred the measured values are in the ranges, 0.5 when the hint has no ranges), then
    capacity. Elements of the right class whose ranges do not contain the object are kept at the end with
    `inRange: false` so the UI can still offer them.
    """
    if not bank_index or not tool_class:
        return []
    found: list[dict[str, Any]] = []
    for element in bank_index.get("elements", []):
        for fits in element.get("fitsTool", []):
            if fits.get("toolClass") != tool_class:
                continue
            ranges = fits.get("dims") or {}
            scores: list[float] = []
            in_range = True
            for key, value in dims.items():
                rng = ranges.get(key)
                if not rng:
                    continue
                if value < rng["min"] or value > rng["max"]:
                    in_range = False
                scores.append(_tightness(value, rng["min"], rng["max"]))
            tightness = sum(scores) / len(scores) if scores else 0.5
            capacity = int(fits.get("capacity") or 1)
            thumb = (element.get("assets", {}).get("thumbnail") or {}).get("path")
            found.append(
                {
                    "bankId": element["id"],
                    "name": (element.get("name") or {}).get("en") or element["id"],
                    "capacity": capacity,
                    "tightness": round(tightness, 3),
                    "inRange": in_range,
                    "score": round((tightness if in_range else tightness * 0.25) + min(capacity, 10) * 0.01, 3),
                    "thumbnail": f"/bank/assets/{thumb}" if thumb else None,
                }
            )
            break
    found.sort(key=lambda h: (-h["score"], h["bankId"]))
    return found[:limit]


def _round(value: float, digits: int = 2) -> float:
    return round(float(value), digits)


def build_proposal(
    *,
    photo_id: str | None,
    image_sha256: str,
    calibration: dict[str, Any] | None,
    objects: list[dict[str, Any]],
    board: Board | None = None,
    bank_index: dict[str, Any] | None = None,
    auto_apply_confidence: float | None = None,
    min_confidence: float = 0.5,
    anchor_mm: tuple[float, float] = (0.0, 0.0),
) -> dict[str, Any]:
    """`objects`: one dict per fitted object with `instance_id`, `centre_mm` [x, y], `fit`, `confidence`,
    `needs_view`, optional `recognition` and `glb` (relative path) + `glb_pose` (heading/x/y/z)."""
    sid = short_id(image_sha256)
    grid_cells = bool(calibration and calibration.get("method") == "grid")
    items: list[dict[str, Any]] = []
    for index, obj in enumerate(sorted(objects, key=lambda o: o["instance_id"])):
        items.append(_item(index, sid, photo_id, obj, bank_index, auto_apply_confidence, min_confidence, anchor_mm))
    holders = _holders(items, sid, photo_id, Board() if board is None else board, grid_cells, bank_index)
    ops = [op for item in items for op in item["ops"]]
    return {
        "version": PROPOSAL_VERSION,
        "photoId": photo_id,
        "imageSha256": image_sha256,
        "autoApplyConfidence": auto_apply_confidence,
        "calibration": (calibration or {}).get("core"),
        "items": items,
        "holders": holders,
        "ops": ops,
        "summary": {
            "objects": len(items),
            "recognised": sum(1 for i in items if i["toolClass"]),
            "needsConfirmation": sum(1 for i in items if i["status"] == STATUS_NEEDS_CONFIRMATION),
            "needsViews": sum(1 for i in items if i["needsView"]),
            "autoApply": sum(1 for i in items if i["autoApply"]),
            "holders": len(holders),
        },
    }


def _item(
    index: int,
    sid: str,
    photo_id: str | None,
    obj: dict[str, Any],
    bank_index: dict[str, Any] | None,
    auto_apply_confidence: float | None,
    min_confidence: float,
    anchor_mm: tuple[float, float],
) -> dict[str, Any]:
    fit = obj["fit"]
    rec = obj.get("recognition") or {}
    confidence = float(obj["confidence"])
    tool_class = rec.get("tool_class") if (rec.get("prob") or 0.0) >= MIN_RECOGNITION_PROB else None
    # Ids come from the segmentation instance, not the list position: a re-run with other `instances` (or a failed
    # fit) must never make the same id mean a different object.
    item_id = f"v{sid}-{int(obj['instance_id']):03d}"
    model_id = f"m{sid}-{int(obj['instance_id']):03d}"
    dims = fit.get("dims_mm") or {}
    dimensions = {
        "length": _round(dims["length_mm"]) if dims.get("length_mm") else None,
        "width": _round(dims["max_width_mm"]) if dims.get("max_width_mm") else None,
        "thickness": _round(dims["thickness_mm"]) if dims.get("thickness_mm") else None,
    }
    params = {k: v for k, v in dimensions.items() if v is not None}
    label = _label(tool_class, bank_index, index)
    cx, cy = obj["centre_mm"]
    pose_src = obj.get("glb_pose") or {}
    pose = {
        "x": _round(pose_src.get("x", cx) + anchor_mm[0]),
        "y": _round(pose_src.get("y", cy) + anchor_mm[1]),
        "z": _round(max(pose_src.get("z", 0.0), 0.0)),
        "rotX": 0,
        "rotY": 0,
        "rotZ": _round(pose_src.get("heading_deg", 0.0)),
    }
    source: dict[str, Any] = {"type": "vision", "confidence": _round(confidence, 3), "by": PRODUCER}
    if photo_id:
        source["photoId"] = photo_id
    model: dict[str, Any] = {
        "id": model_id,
        "label": label,
        "status": "candidate",
        "source": {"type": "generated", "by": PRODUCER},
        "forItemId": item_id,
        "score": _round(confidence, 3),
    }
    if tool_class:
        model["toolClass"] = tool_class
    if all(dimensions[k] for k in ("length", "width", "thickness")):
        model["dimensionsMm"] = {"x": dimensions["length"], "y": dimensions["width"], "z": dimensions["thickness"]}
    item: dict[str, Any] = {
        "id": item_id,
        "kind": "tool",
        "modelRefId": model_id,
        "label": label,
        "pose": pose,
        "params": params,
        "source": source,
    }
    if tool_class:
        item["toolClass"] = tool_class
    status = STATUS_OK if confidence >= min_confidence else STATUS_NEEDS_CONFIRMATION
    needs_view = bool(obj.get("needs_view"))
    auto = (
        auto_apply_confidence is not None
        and confidence >= auto_apply_confidence
        and status == STATUS_OK
        and tool_class is not None
        and not needs_view
    )
    holders = suggest_holders(bank_index, tool_class, measured_dims(dimensions, (fit.get("kind") or "")), limit=3)
    return {
        "id": item_id,
        "modelId": model_id,
        "instanceId": obj["instance_id"],
        "label": label,
        "toolClass": tool_class,
        "confidence": _round(confidence, 3),
        "status": status,
        "autoApply": auto,
        "needsView": needs_view,
        "recognition": {
            "toolClass": rec.get("tool_class"),
            "prob": rec.get("prob"),
            "topk": rec.get("topk", []),
            "bankTopk": rec.get("bank_topk", []),
            **({"ai": rec["ai"], "source": rec.get("source")} if rec.get("ai") else {}),
        },
        "dimensionsMm": dimensions,
        "fit": {
            "kind": fit.get("kind"),
            "method": fit.get("method"),
            "device": fit.get("device"),
            "tries": fit.get("tries"),
            "timingS": fit.get("timing_s"),
            "confidence": fit.get("confidence"),
            "dimsFixed": obj.get("fixed_dims") or None,
        },
        "check": obj.get("check"),
        "holders": holders,
        "glb": obj.get("glb"),
        "ops": [{"type": "addModelRef", "model": model}, {"type": "addItem", "item": item}],
    }


def _label(tool_class: str | None, bank_index: dict[str, Any] | None, index: int) -> str:
    if tool_class and bank_index:
        for tc in bank_index.get("toolClasses", []):
            if tc["id"] == tool_class:
                return str((tc.get("name") or {}).get("en") or tool_class)
    if tool_class:
        return tool_class.replace("-", " ").capitalize()
    return f"Object {index + 1}"


def _holders(
    items: list[dict[str, Any]],
    sid: str,
    photo_id: str | None,
    board: Board,
    grid_cells: bool,
    bank_index: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """One optional holder proposal per chunk of tools that share a best holder (chunk size = its capacity)."""
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for item in items:
        if item["holders"]:
            top = item["holders"][0]
            groups.setdefault((item["toolClass"] or "", top["bankId"]), []).append(item)
    proposals: list[dict[str, Any]] = []
    for (_, bank_id), members in sorted(groups.items()):
        capacity = max(int(members[0]["holders"][0]["capacity"]), 1)
        suggestion = members[0]["holders"][0]
        for start in range(0, len(members), capacity):
            chunk = members[start : start + capacity]
            xs = [m["ops"][1]["item"]["pose"]["x"] for m in chunk]
            ys = [m["ops"][1]["item"]["pose"]["y"] for m in chunk]
            x, y = sum(xs) / len(xs), sum(ys) / len(ys)
            confidence = sum(m["confidence"] for m in chunk) / len(chunk) * suggestion["tightness"] ** 0.5
            holder_id = f"v{sid}-h{len(proposals):02d}"
            source: dict[str, Any] = {"type": "vision", "confidence": _round(confidence, 3), "by": PRODUCER}
            if photo_id:
                source["photoId"] = photo_id
            item: dict[str, Any] = {
                "id": holder_id,
                "kind": "holder",
                "bankId": bank_id,
                "label": suggestion["name"],
                "pose": {"x": _round(x), "y": _round(y), "z": 0, "rotX": 0, "rotY": 0, "rotZ": 0},
                "source": source,
            }
            if grid_cells:
                col, row = nearest_cell(board, x, y)
                item["cell"] = {"col": col, "row": row}
            proposals.append(
                {
                    "id": holder_id,
                    "bankId": bank_id,
                    "label": suggestion["name"],
                    "forItems": [m["id"] for m in chunk],
                    "confidence": _round(confidence, 3),
                    "inRange": suggestion["inRange"],
                    "ops": [{"type": "addItem", "item": item}],
                }
            )
    return proposals
