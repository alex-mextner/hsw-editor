"""Segment stage: photo -> instances (mask PNGs + bboxes + polygons). The algorithm is `threed_vision.segment`."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

import numpy as np

from hsw_vision.engines import ensure_segmenter
from hsw_vision.errors import BadRequest
from hsw_vision.manager import ModelManager

METHODS = ("sam2", "sam2-dense", "u2net")
FILLS = ("owlv2", "none")
Progress = Callable[[str, float], None]


def segment(
    rgb: np.ndarray,
    out_dir: Path,
    *,
    manager: ModelManager,
    method: str = "sam2",
    fill: str = "owlv2",
    reject_bg: bool = True,
    points_per_side: int = 32,
    progress: Progress | None = None,
    files_prefix: str = "",
) -> dict[str, Any]:
    """Run the segmenter, write `masks/NNN.png` + `overlay.jpg` under `out_dir`, return the JSON description.

    `u2net` is the single-object fast path (one tool on a plain background); `fill` and `reject_bg` only apply to
    the SAM2 methods. Mask files are relative to `out_dir` (the caller records `out_dir` relative to its cache).
    """
    if method not in METHODS:
        raise BadRequest(f"unknown segmentation method {method!r}; use one of {', '.join(METHODS)}")
    if fill not in FILLS:
        raise BadRequest(f"unknown fill {fill!r}; use one of {', '.join(FILLS)}")
    if method == "u2net":
        fill, reject_bg = "none", False
    name = ensure_segmenter(manager, method=method, fill=fill, reject_bg=reject_bg, points_per_side=points_per_side)
    raw = manager.call(name, lambda engine: engine.run(rgb, progress=progress))
    return describe(rgb, raw, out_dir, files_prefix=files_prefix)


def describe(rgb: np.ndarray, raw: dict[str, Any], out_dir: Path, files_prefix: str = "") -> dict[str, Any]:
    """Library result -> JSON (+ files). Separate from `segment` so click-to-fix edits reuse it.

    `mask`/`overlay` paths are relative to `out_dir`; `_files` (what the cache verifies) are relative to the cache's
    image directory, hence `files_prefix` (e.g. `seg-1a2b3c/`)."""
    from threed_vision import io as tv_io

    out_dir.mkdir(parents=True, exist_ok=True)
    instances: list[dict[str, Any]] = []
    files: list[str] = []
    masks: list[np.ndarray] = []
    for inst in raw["instances"]:
        mask = np.asarray(inst["mask"], dtype=bool)
        rel = f"masks/{int(inst['id']):03d}.png"
        tv_io.save_png(out_dir / rel, mask)
        files.append(files_prefix + rel)
        masks.append(mask)
        instances.append(
            {
                "id": int(inst["id"]),
                "source": inst.get("source"),
                "bbox_xywh": [int(v) for v in inst["bbox_xywh"]],
                "area_px": int(inst["area_px"]),
                "bg_prob": _opt(inst.get("bg_prob")),
                "stability": _opt(inst.get("stability")),
                "polygon": tv_io.mask_polygon(mask),
                "mask": rel,
            }
        )
    overlay_rel = "overlay.jpg"
    if masks:
        import cv2

        overlay = tv_io.draw_overlay(rgb, masks)
        cv2.imwrite(str(out_dir / overlay_rel), cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR))
        files.append(files_prefix + overlay_rel)
    h, w = rgb.shape[:2]
    return tv_io.to_jsonable(
        {
            "image": {"w": w, "h": h},
            "method": raw.get("method"),
            "device": raw.get("device"),
            "timing_s": raw.get("timing_s"),
            "vram_mb": raw.get("vram_mb"),
            "instances": instances,
            "overlay": overlay_rel if masks else None,
            "_files": files,
        }
    )


def _opt(value: Any) -> float | None:
    return None if value is None else float(value)


def load_masks(result: dict[str, Any], base_dir: Path, only: Iterable[int] | None = None) -> dict[int, np.ndarray]:
    """Boolean masks of a segment result by instance id (all, or just the ids in `only`: one decode per mask)."""
    from threed_vision import io as tv_io

    wanted = None if only is None else set(only)
    return {
        int(inst["id"]): tv_io.load_mask(base_dir / inst["mask"])
        for inst in result["instances"]
        if wanted is None or int(inst["id"]) in wanted
    }
