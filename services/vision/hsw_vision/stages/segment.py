"""Segment stage: photo -> instances (mask PNGs + bboxes + polygons). The algorithm is `threed_vision.segment`."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, get_args

import numpy as np

from hsw_vision.engines import ensure_segmenter
from hsw_vision.errors import BadRequest
from hsw_vision.manager import ModelManager
from hsw_vision.schemas import DEFAULT_QUALITY, SegmentQuality

METHODS = ("sam2", "sam2-dense", "u2net")
QUALITIES = get_args(SegmentQuality)
FILLS = ("owlv2", "none")
Progress = Callable[[str, float], None]
PNG_THREADS = 4


def segment(
    rgb: np.ndarray,
    out_dir: Path,
    *,
    manager: ModelManager,
    method: str = "sam2",
    quality: str = DEFAULT_QUALITY,
    fill: str = "owlv2",
    reject_bg: bool = True,
    points_per_side: int = 32,
    progress: Progress | None = None,
    files_prefix: str = "",
) -> dict[str, Any]:
    """Run the segmenter, write `masks/NNN.png` + `overlay.jpg` under `out_dir`, return the JSON description.

    `u2net` is the single-object fast path (one tool on a plain background); `quality`, `fill` and `reject_bg` only apply
    to the SAM2 methods. Mask files are relative to `out_dir` (the caller records `out_dir` relative to its cache).
    """
    if method not in METHODS:
        raise BadRequest(f"unknown segmentation method {method!r}; use one of {', '.join(METHODS)}")
    if quality not in QUALITIES:
        raise BadRequest(f"unknown segmentation quality {quality!r}; use one of {', '.join(QUALITIES)}")
    if fill not in FILLS:
        raise BadRequest(f"unknown fill {fill!r}; use one of {', '.join(FILLS)}")
    if method == "u2net":
        quality, fill, reject_bg = DEFAULT_QUALITY, "none", False  # one u2net engine whatever the request says
    name = ensure_segmenter(
        manager, method=method, quality=quality, fill=fill, reject_bg=reject_bg, points_per_side=points_per_side
    )
    raw = manager.call(name, lambda engine: engine.run(rgb, progress=progress))
    return describe(rgb, raw, out_dir, files_prefix=files_prefix)


def describe(rgb: np.ndarray, raw: dict[str, Any], out_dir: Path, files_prefix: str = "") -> dict[str, Any]:
    """Library result -> JSON (+ files). Separate from `segment` so click-to-fix edits reuse it.

    `mask`/`overlay` paths are relative to `out_dir`; `_files` (what the cache verifies) are relative to the cache's
    image directory, hence `files_prefix` (e.g. `seg-1a2b3c/`)."""
    import cv2
    from threed_vision import io as tv_io

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "masks").mkdir(exist_ok=True)
    instances: list[dict[str, Any]] = []
    files: list[str] = []
    masks: list[np.ndarray] = []
    rels: list[str] = []
    for inst in raw["instances"]:
        mask = np.asarray(inst["mask"], dtype=bool)
        rel = f"masks/{int(inst['id']):03d}.png"
        files.append(files_prefix + rel)
        rels.append(rel)
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
    # The mask PNGs (lossless, light compression: the default level costs 13 ms per photo-sized mask) and the overlay are
    # independent: encode the PNGs on a few threads (OpenCV releases the GIL) while this thread blends the overlay.
    with ThreadPoolExecutor(max_workers=PNG_THREADS) as pool:
        saved = [pool.submit(_save_mask_png, out_dir / rel, mask) for rel, mask in zip(rels, masks, strict=True)]
        if masks:
            overlay = tv_io.draw_overlay(rgb, masks)
            cv2.imwrite(str(out_dir / overlay_rel), cv2.cvtColor(overlay, cv2.COLOR_RGB2BGR))
            files.append(files_prefix + overlay_rel)
        for future in saved:
            future.result()
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


def _save_mask_png(path: Path, mask: np.ndarray) -> None:
    """A bool mask as an 8-bit PNG (0 / 255), the format `threed_vision.io.load_mask` reads."""
    import cv2

    if not cv2.imwrite(str(path), mask.astype(np.uint8) * 255, [cv2.IMWRITE_PNG_COMPRESSION, 1]):
        raise OSError(f"cannot write the mask {path}")


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
