"""Appearance stage: per-part colours of a segmented object. The algorithm is `threed_vision.appearance`
(`sample_part_colours`); this module only calls it and reports whether the pinned library has it.
"""

from __future__ import annotations

import importlib.util
from typing import Any

import numpy as np


def available() -> bool:
    """Whether the installed `threed_vision` ships `appearance` (it is a separate 3d-cli PR; see docs/vision.md)."""
    try:
        return importlib.util.find_spec("threed_vision.appearance") is not None
    except ImportError:
        return False


def sample_colours(rgb: np.ndarray, mask: np.ndarray, fit: dict[str, Any] | None = None, max_colours: int = 4) -> dict[str, Any]:
    """`{"parts": [{t0, t1, colour_srgb, hex, lab, area_frac, n_pixels, role_guess}], "palette": [...], "axis_deg"}`.

    `t` runs 0..1 along the object's length from its wider end (it can be flipped against the fit pose's axis)."""
    from threed_vision import appearance
    from threed_vision import io as tv_io

    return tv_io.to_jsonable(appearance.sample_part_colours(rgb, mask, fit=fit, max_colours=max_colours))  # type: ignore[no-any-return]
