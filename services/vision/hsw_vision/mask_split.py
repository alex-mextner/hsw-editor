"""Split one object mask into parts: by a straight line, or into `n` parts that follow the object's necks.

Pure numpy/OpenCV on boolean masks (no models): the review grid's "split" for a mask that covers several tools (tape
rolls glued together by the segmenter, a hammer head fused with the wrench beside it).
"""

from __future__ import annotations

import numpy as np

from hsw_vision.errors import BadRequest

#: A part smaller than this many pixels is a sliver of the cut, not an object.
MIN_PART_PX = 150
#: Mask pixels assigned to their nearest k-means centre per step (bounds the temporary array).
CHUNK_PX = 200_000
#: Core of a part, as a fraction of its own deepest distance-to-edge, that seeds the watershed.
CORE_FRACTION = 0.6


def split_mask(
    mask: np.ndarray,
    *,
    line_px: tuple[tuple[float, float], tuple[float, float]] | None = None,
    n: int | None = None,
    min_area: int = MIN_PART_PX,
) -> list[np.ndarray]:
    """Parts of `mask` (largest first), each at least `min_area` px; `BadRequest` when fewer than two remain."""
    if (line_px is None) == (n is None):
        raise BadRequest("split needs exactly one of line_px and n")
    if line_px is not None:
        parts = split_by_line(mask, line_px)
    else:
        assert n is not None  # exactly one of the two ways was given (checked above)
        parts = split_into(mask, n)
    slivers = sum(1 for p in parts if int(p.sum()) < min_area)
    if slivers:
        # dropping a sliver would lose its pixels (the parts must tile the mask): refuse instead
        raise BadRequest(
            f"the split leaves {slivers} part(s) under {min_area} px; "
            + ("move the line across the object" if line_px is not None else "use a smaller n or split by a line")
        )
    return sorted(parts, key=lambda p: -int(p.sum()))


def split_by_line(mask: np.ndarray, line: tuple[tuple[float, float], tuple[float, float]]) -> list[np.ndarray]:
    """The two sides of the infinite line through the two photo pixels `line` (pixel centres on the line go left)."""
    (x1, y1), (x2, y2) = line
    if (x1, y1) == (x2, y2):
        raise BadRequest("the split line needs two different points")
    ys, xs = np.nonzero(mask)
    side = (x2 - x1) * (ys - y1) - (y2 - y1) * (xs - x1)
    on_left = side >= 0
    left, right = np.zeros_like(mask, dtype=bool), np.zeros_like(mask, dtype=bool)
    left[ys[on_left], xs[on_left]] = True
    right[ys[~on_left], xs[~on_left]] = True
    return [left, right]


def split_into(mask: np.ndarray, n: int) -> list[np.ndarray]:
    """`n` parts: k-means on the pixel positions finds where the parts are, a watershed on the distance transform
    (seeded at each part's thickest core) then cuts along the narrow necks between them."""
    import cv2

    if n < 2:
        raise BadRequest("split needs at least two parts")
    ys, xs = np.nonzero(mask)
    if xs.size < n:
        raise BadRequest("the mask is too small to split")
    all_px = np.column_stack([xs, ys]).astype(np.float32)
    sample_px = all_px
    if len(sample_px) > 50_000:  # the centres do not need every pixel
        sample_px = sample_px[np.random.default_rng(0).choice(len(sample_px), 50_000, replace=False)]
    cv2.setRNGSeed(0)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.5)
    _, _, centres = cv2.kmeans(sample_px, n, None, criteria, 5, cv2.KMEANS_PP_CENTERS)
    # nearest centre of every mask pixel (the labels above only cover the subsample), in chunks: a 12 MP mask would need
    # hundreds of MB for the (pixels, n, 2) difference array at once
    labels = np.full(mask.shape, -1, np.int32)
    for start in range(0, len(all_px), CHUNK_PX):
        chunk = all_px[start : start + CHUNK_PX]
        nearest = np.argmin(((chunk[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2), axis=1)
        labels[ys[start : start + CHUNK_PX], xs[start : start + CHUNK_PX]] = nearest

    binary = mask.astype(np.uint8)
    dist = cv2.distanceTransform(binary, cv2.DIST_L2, 5)
    markers = np.zeros(mask.shape, np.int32)
    markers[~mask] = n + 1
    for k in range(n):
        own = labels == k
        if not own.any():
            continue
        deepest = float(dist[own].max())
        markers[own & (dist >= CORE_FRACTION * deepest)] = k + 1
    relief = (255.0 * (1.0 - dist / max(float(dist.max()), 1e-6))).astype(np.uint8)
    cv2.watershed(cv2.cvtColor(relief, cv2.COLOR_GRAY2BGR), markers)
    parts = [(markers == k + 1) & mask for k in range(n)]
    # Pixels no part claimed (the watershed ridge, and the rim the background marker flooded into) go to the part the
    # k-means labels put them in, so the parts always tile the mask exactly.
    unclaimed = mask & ~np.logical_or.reduce(parts)
    for k in range(n):
        parts[k] |= unclaimed & (labels == k)
    return parts
