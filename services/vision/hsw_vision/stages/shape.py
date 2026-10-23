"""Shape stage: principal axis, closed-form width profile (mm) and the upright (axis-aligned) crop of one object.

The numbers come from `threed_vision.fit_profile.fit_profile` (numpy, milliseconds); the axis convention is the
library's: unit vector along the principal axis, oriented so the WIDER end comes first ("handle first"), the same
convention `appearance.sample_part_colours` uses for its `t` coordinate.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

PROFILE_STATIONS = 12
PROFILE_KEYS = ("kind", "length_mm", "max_width_mm", "rect_mm", "elongation", "solidity", "rect_fill", "lateral_offset_mm", "stations", "iou_recon")
BACKGROUND_RGB = (127, 127, 127)


def axis_and_profile(mask: np.ndarray, mm_per_px: float | None) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """`(axis, profile)`. `axis` = `{deg, unit, centerPx}` (direction in photo pixels, y down; no scale needed).
    `profile` = the library's closed-form fit with its stations `{t, lo_mm, hi_mm}` (lateral extents about the axis,
    `t` 0..1 from the wide end), or None without a scale (the widths would not be millimetres)."""
    from threed_vision.fit_profile import fit_profile
    from threed_vision.io import to_jsonable

    fp = to_jsonable(fit_profile(mask, mm_per_px or 1.0, K=PROFILE_STATIONS))
    axis = {"deg": fp["axis_deg"], "unit": fp["axis_unit"], "centerPx": fp["center_px"]}
    profile = None if mm_per_px is None else {key: fp[key] for key in PROFILE_KEYS}
    return axis, profile


def upright_crops(
    rgb: np.ndarray, mask: np.ndarray, axis_deg: float, pad_frac: float = 0.1
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """`(crop, cutout, mask)` of the object rotated so its principal axis is horizontal (+x, wide end on the left).

    `crop` is RGB with the surrounding photo kept (outside the photo: grey), `cutout` RGBA with alpha = the rotated
    mask, and `mask` the rotated binary mask, all the same size: the tight bbox of the rotated mask plus `pad_frac` of
    its larger side."""
    import cv2

    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise ValueError("empty mask")
    cx, cy = (float(xs.min()) + float(xs.max()) + 1) / 2, (float(ys.min()) + float(ys.max()) + 1) / 2
    half = int(math.ceil(math.hypot(xs.max() - xs.min() + 1, ys.max() - ys.min() + 1) / 2)) + 4
    matrix = cv2.getRotationMatrix2D((cx, cy), axis_deg, 1.0)  # positive angle = counter-clockwise on screen
    matrix[:, 2] += (half - cx, half - cy)
    size = (2 * half, 2 * half)
    rotated = cv2.warpAffine(np.ascontiguousarray(rgb), matrix, size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=BACKGROUND_RGB)
    rotated_mask = cv2.warpAffine(mask.astype(np.uint8), matrix, size, flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 0
    rys, rxs = np.nonzero(rotated_mask)
    pad = int(pad_frac * max(rxs.max() - rxs.min() + 1, rys.max() - rys.min() + 1))
    x0, x1 = max(int(rxs.min()) - pad, 0), min(int(rxs.max()) + 1 + pad, size[0])
    y0, y1 = max(int(rys.min()) - pad, 0), min(int(rys.max()) + 1 + pad, size[1])
    crop = rotated[y0:y1, x0:x1]
    m = rotated_mask[y0:y1, x0:x1]
    cutout = np.dstack([crop, np.where(m, 255, 0).astype(np.uint8)])
    return crop, cutout, m
