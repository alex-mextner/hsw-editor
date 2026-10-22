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


def classes_from_bank(bank_index: dict[str, Any] | None) -> list[dict[str, Any]]:
    """`[{"id", "prompts"}]` from a bank index's `toolClasses[]` (English name as the prompt), or the built-in vocabulary."""
    if not bank_index or not bank_index.get("toolClasses"):
        return [{"id": class_id, "prompts": [prompt]} for class_id, prompt in DEFAULT_CLASSES]
    classes = [
        {"id": tc["id"], "prompts": [str(tc.get("name", {}).get("en") or tc["id"]).lower()]} for tc in bank_index["toolClasses"]
    ]
    ids = [c["id"] for c in classes]
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise BadRequest(f"bank toolClasses repeat the id(s) {', '.join(duplicates)}; ids must be unique")
    return classes


def classes_from_file(spec: str) -> list[dict[str, Any]]:
    """External categories (`categories` request field): whatever `threed_vision.recognise.load_categories` reads - a JSON list of
    ToolClass objects (`id`, `name`/`prompts`/`synonyms`), an index document wrapping `toolClasses`, one label per line
    (`label: synonym, synonym`), or a comma list. The caller fuses the text scores with its own class prototypes."""
    from threed_vision.recognise import load_categories

    return [{"id": c.label, "prompts": list(c.prompts)} for c in load_categories(spec)]


def resolve_classes(bank_index: dict[str, Any] | None, categories: str | None = None) -> list[dict[str, Any]]:
    """The class list a request recognises against: an explicit `categories` file beats the bank index beats the default."""
    return classes_from_file(categories) if categories else classes_from_bank(bank_index)


def recognise(
    rgb: np.ndarray,
    instances: list[dict[str, Any]],
    masks: dict[int, np.ndarray],
    *,
    manager: ModelManager,
    classes: list[dict[str, Any]],
    topk: int = 5,
    calibrate: bool = True,
) -> dict[str, Any]:
    """`{"objects": {id: {"tool_class", "label", "score", "prob", "topk": [...], "bank_topk": [...]}}}`.

    `classes` come from `resolve_classes`. `prob` is the softmax share of the best class within the top-k (a margin
    signal in [0, 1], not a calibrated probability); `tool_class` is None for instances the model cannot place.
    """
    text_of = {c["id"]: c["prompts"][0] for c in classes}
    subjects = [{"id": inst["id"], "mask": masks[inst["id"]]} for inst in instances if inst["id"] in masks]
    if not subjects:
        return {"classes": [c["id"] for c in classes], "objects": {}}

    raw = manager.call(
        RECOGNISER,
        lambda engine: engine.classify(rgb, subjects, classes, calibrate=calibrate, topk=topk),
    )
    objects: dict[str, dict[str, Any]] = {}
    for entry in raw:
        ranked = [
            {"tool_class": item["label"], "label": text_of.get(item["label"], item["label"]), "score": float(item["score"])}
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
    return {"classes": [c["id"] for c in classes], "objects": objects}


def _margin_prob(scores: list[float]) -> float:
    """Softmax share of the best score among `scores` (sorted best first)."""
    if not scores:
        return 0.0
    top = scores[0]
    return float(1.0 / sum(math.exp(s - top) for s in scores))
