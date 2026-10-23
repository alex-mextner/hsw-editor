"""Prompt stage: one click or box -> one object mask (`threed_vision.segment.Segmenter.add_by_point/add_by_box`, SAM2)."""

from __future__ import annotations

from typing import Any

import numpy as np

from hsw_vision.engines import ensure_segmenter
from hsw_vision.errors import BadRequest
from hsw_vision.manager import ModelManager


def prompt_mask(
    rgb: np.ndarray,
    *,
    manager: ModelManager,
    point_px: tuple[float, float] | None = None,
    box_xywh: tuple[float, float, float, float] | None = None,
    method: str = "sam2",
) -> dict[str, Any]:
    """The library instance (`mask`, `bbox_xywh`, `area_px`, `stability`) SAM2 predicts for the prompt.

    Only SAM2 runs (no OWLv2 fill, no CLIP background rejection): the user pointed at the object. `u2net` cannot take
    prompts, so a result made by it is edited with `sam2`."""
    if (point_px is None) == (box_xywh is None):
        raise ValueError("exactly one of point_px and box_xywh")
    name = ensure_segmenter(manager, method="sam2" if method == "u2net" else method, fill="none", reject_bg=False)

    def run(engine: Any) -> dict[str, Any]:
        if box_xywh is not None:
            x, y, w, h = box_xywh
            added = engine.add_by_box(rgb, [], [x, y, x + w, y + h])
        else:
            assert point_px is not None
            added = engine.add_by_point(rgb, [], [list(point_px)])
        if not added:
            raise BadRequest("the prompt produced no object")
        return added[-1]  # type: ignore[no-any-return]

    return manager.call(name, run)  # type: ignore[no-any-return]
