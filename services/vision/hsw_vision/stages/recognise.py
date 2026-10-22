"""Recognise stage: instances -> tool class (CLIP text prompts, class-mean calibrated) + optional bank re-rank.

The categories are the bank's tool classes (`toolClasses[]` of `/api/bank/index`), so a recognised label IS a bank
tool-class id that drives holder suggestions. Without a bank index the built-in vocabulary below (the same ids) is used.
Image -> bank-object retrieval (`bank` argument of the library) only runs when a bank of tool thumbnails exists.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from hsw_vision.engines import RECOGNISER
from hsw_vision.errors import BadRequest
from hsw_vision.manager import ModelManager

# (tool-class id, prompt). Ids follow packages/bank/src/toolClasses.ts.
DEFAULT_CLASSES: tuple[tuple[str, str], ...] = (
    ("screwdriver", "screwdriver"),
    ("pliers", "pliers"),
    ("snips", "side cutters"),
    ("wrench", "wrench"),
    ("hex-key", "hex key"),
    ("drill", "cordless drill"),
    ("caliper", "caliper"),
    ("tape-measure", "tape measure"),
    ("tape-roll", "roll of tape"),
    ("hammer", "hammer"),
    ("scissors", "scissors"),
    ("knife", "utility knife"),
    ("clamp", "clamp"),
    ("bit-set", "bit set"),
    ("multimeter", "multimeter"),
    ("file", "file"),
    ("saw", "saw"),
    ("brush", "brush"),
    ("pen", "marker pen"),
    ("ruler", "ruler"),
    ("spool", "spool of filament"),
    ("cable", "cable"),
    ("usb-stick", "usb stick"),
    ("sd-card", "sd card"),
    ("spray-can", "spray can"),
    ("toothbrush", "toothbrush"),
    ("screws", "box of screws"),
)


def classes_from_bank(bank_index: dict[str, Any] | None) -> list[tuple[str, str]]:
    """`(id, prompt)` pairs from a bank index, or the built-in vocabulary."""
    if not bank_index or not bank_index.get("toolClasses"):
        return list(DEFAULT_CLASSES)
    classes = [(tc["id"], str(tc.get("name", {}).get("en") or tc["id"]).lower()) for tc in bank_index["toolClasses"]]
    prompts = [prompt for _, prompt in classes]
    duplicates = sorted({p for p in prompts if prompts.count(p) > 1})
    if duplicates:  # results are mapped back to ids through the prompt text: it must identify one class
        raise BadRequest(f"bank toolClasses share the English name(s) {', '.join(duplicates)}; names must be unique")
    return classes


def recognise(
    rgb: np.ndarray,
    instances: list[dict[str, Any]],
    masks: dict[int, np.ndarray],
    *,
    manager: ModelManager,
    bank_index: dict[str, Any] | None = None,
    topk: int = 5,
    calibrate: bool = True,
) -> dict[str, Any]:
    """`{"objects": {id: {"tool_class", "label", "score", "prob", "topk": [...], "bank_topk": [...]}}}`.

    `prob` is the softmax share of the best class within the top-k (a margin signal in [0, 1], not a calibrated
    probability); `tool_class` is None for instances the model cannot place.
    """
    classes = classes_from_bank(bank_index)
    prompts = [prompt for _, prompt in classes]
    by_prompt = {prompt: class_id for class_id, prompt in classes}
    subjects = [{"id": inst["id"], "mask": masks[inst["id"]]} for inst in instances if inst["id"] in masks]
    if not subjects:
        return {"classes": [c for c, _ in classes], "objects": {}}

    raw = manager.call(
        RECOGNISER,
        lambda engine: engine.classify(rgb, subjects, prompts, calibrate=calibrate, topk=topk),
    )
    objects: dict[str, dict[str, Any]] = {}
    for entry in raw:
        ranked = [
            {"tool_class": by_prompt.get(item["label"]), "label": item["label"], "score": float(item["score"])}
            for item in entry.get("text_topk", [])
        ]
        best = ranked[0] if ranked else None
        objects[str(entry["id"])] = {
            "tool_class": best["tool_class"] if best else None,
            "label": best["label"] if best else None,
            "score": best["score"] if best else None,
            "prob": _margin_prob([r["score"] for r in ranked]),
            "topk": ranked,
            "bank_topk": [dict(b) for b in entry.get("bank_topk", [])],
            "calibrated": bool(entry.get("calibrated", calibrate)),
        }
    return {"classes": [c for c, _ in classes], "objects": objects}


def _margin_prob(scores: list[float]) -> float:
    """Softmax share of the best score among `scores` (sorted best first)."""
    if not scores:
        return 0.0
    top = scores[0]
    return float(1.0 / sum(math.exp(s - top) for s in scores))
