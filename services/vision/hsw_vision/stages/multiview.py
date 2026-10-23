"""Multi-view stage: render the fit into every other available view and compare silhouettes
(`threed_vision.view_check.check`). Without a second view the library runs its single-photo sanity mode
(status `unverified`) and the fit's confidence stays capped (see `hsw_vision.confidence`).

Two kinds of extra view, never mixed:

* **photos** (`check_fit`): other real photos registered against the main one (`register_views`) or given with their
  own camera. Their held-out IoU IS the confidence.
* **generated** views (`check_generated`): images drawn by a draw backend (docs/draw.md). They have no camera, only a
  name (front/side/top/back) or an explicit direction in the object frame, so the fit is rendered from that canonical
  direction and compared after a scale/translation/in-plane-rotation normalisation. They are hints, never ground truth:
  every row is `source: "generated"`, and they are NEVER part of `min_iou`, the confidence or `needs_view`.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, NamedTuple

import numpy as np

from hsw_vision.errors import BadRequest

#: Direction (azimuth, elevation in the OBJECT frame: X = length, Y = width, Z = thickness) a drawn view is compared at.
#: The convention is the one the draw prompt sets up (docs/draw.md): the reference the generator gets is the photo's upright
#: cut-out, presented as the object's FRONT view with the long axis horizontal; the other names follow from it.
GENERATED_VIEW_ANGLES: dict[str, tuple[float, float]] = {
    "front": (0.0, 90.0),  # the reference itself: length x width, looking down the thickness axis
    "back": (0.0, -90.0),  # the same silhouette mirrored
    "side": (0.0, 0.0),  # from the object's right: its end, width x thickness
    "top": (90.0, 0.0),  # from above: the profile along the length, length x thickness
}
#: A drawn view is flagged below this agreement: a little under the photo threshold (0.75) because a drawing keeps the
#: shape only approximately; measured on the carpet fits (docs/vision.md): the object's own drawing scores >= 0.96, another
#: object's side and end drawings 0.26-0.65.
GENERATED_FLAG_BELOW = 0.7
_WHITE_TOLERANCE = 28  # a pixel counts as ink when its darkest channel is this far below white
_MIN_AREA_FRACTION = 0.001  # a drawn silhouette smaller than this share of the image is no drawing of an object ...
_MAX_AREA_FRACTION = 0.9  # ... and one that fills the image is a background
#: Both silhouettes are normalised onto a canvas of this size (equal area, centroid at the centre). It is wide because tools
#: are long: an elongated silhouette (up to about 20:1) keeps its tips instead of being clipped by a square canvas.
_CANVAS_W, _CANVAS_H = 640, 160
_FILL = 0.15  # silhouette area / canvas area after normalisation
_ROUND_RATIO = 1.3  # principal axes this close: the in-plane orientation is arbitrary, sweep it
_SWEEP_DEG = 15
_MIN_MASK_VALUE = 64  # of 255: a thin line that survives shrinking at a quarter of its coverage stays a line
_FOREGROUND_VALUE = 128  # of 255: a warped silhouette pixel is object when at least half covered


def _lib() -> Any:
    from threed_vision import view_check

    return view_check


def resolve_views(views: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`views` with every `mask_path` replaced by the decoded `mask` (so JSON requests carry no pixel arrays)."""
    resolved = []
    for index, view in enumerate(views):
        if "mask_path" not in view:
            resolved.append(view)
            continue
        if "mask" in view:
            raise BadRequest(f"view {index}: give `mask` or `mask_path`, not both")
        rest = {key: value for key, value in view.items() if key != "mask_path"}
        resolved.append({**rest, "mask": load_mask_file(view["mask_path"])})
    return resolved


def check_fit(fit: dict[str, Any], views: list[dict[str, Any]], *, flag_below: float) -> dict[str, Any]:
    """`{"views": [{"iou", "flag"}], "min_iou", "status", "needs_views": [{"azimuth_deg", "elevation_deg"}]}`.

    `views` are `{mask | mask_path, K, R, t}` of other photos of the same object; `[]` = single-photo sanity mode.
    """
    from threed_vision import io as tv_io

    result = _lib().check(fit, resolve_views(views), flag_below=flag_below)
    return tv_io.to_jsonable(result)


def register_views(
    rgb_a: Any, rgb_b: Any, masks_a: list[Any], camera: Any
) -> dict[str, Any]:
    """Register photo B against photo A (SIFT + RANSAC, `threed_vision.register`) and turn A's masks into views of B.

    `views[i]` is `{mask, K, R, t}` for `masks_a[i]` seen in B, or None for all when the photos share a viewpoint
    (`baseline_ok` false): such a pair repeats the silhouette but cannot hold out any 3-D information.
    """
    import numpy as np
    from threed_vision import register as tv_register

    reg = tv_register.register(rgb_a, rgb_b, masks_a=masks_a, K_a=camera.K, K_b=camera.K, plane_depth_mm=camera.plane_depth_mm)
    summary = {
        "ok": bool(reg.get("ok")),
        "baseline_ok": bool(reg.get("baseline_ok")),
        "matches": reg.get("matches"),
        "inliers": reg.get("inliers"),
        "median_reproj_px": reg.get("median_reproj_px"),
        "rel_rot_deg": reg.get("rel_rot_deg"),
        "reason": reg.get("reason"),
        "repeatability": reg.get("repeatability") or [],
    }
    if not (summary["ok"] and summary["baseline_ok"]):
        return {**summary, "views": [None] * len(masks_a)}
    rel_r = np.asarray(reg["rel_R"], dtype=float)
    shift = np.asarray(reg["t_over_depth"], dtype=float).reshape(3) * float(camera.plane_depth_mm)
    r_b = rel_r @ camera.R
    t_b = rel_r @ camera.t + shift
    warped = reg.get("warped_masks") or []
    views = [
        {"mask": warped[i], "K": camera.K, "R": r_b, "t": t_b} if i < len(warped) else None for i in range(len(masks_a))
    ]
    return {**summary, "views": views}


def load_mask_file(path: Path | str) -> np.ndarray:
    """A view mask stored as an image: the alpha channel of an RGBA file when it varies (a cut-out), else the grey value;
    foreground = above half of the dtype's range (so an opaque white-on-black RGBA mask and a colour one are read by their grey)."""
    import cv2

    raw = cv2.imread(str(Path(path).expanduser()), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise BadRequest(f"cannot read mask image {path}")
    if raw.ndim == 3:
        alpha = raw[..., 3] if raw.shape[2] == 4 else None
        if alpha is not None and alpha.min() != alpha.max():
            raw = alpha
        else:
            raw = cv2.cvtColor(raw, cv2.COLOR_BGRA2GRAY if raw.shape[2] == 4 else cv2.COLOR_BGR2GRAY)
    half = np.iinfo(raw.dtype).max // 2 if raw.dtype.kind in "ui" else 0.5
    mask = np.asarray(raw > half)
    if not mask.any():  # e.g. a 0/1 mask, a black-on-white one, or the wrong image: unusable input, not a failed fit
        raise BadRequest(f"mask image {path} has no foreground (pixels above half of the {raw.dtype} range)")
    return mask


def load_drawing(path: Path | str) -> np.ndarray:
    """A drawn view as HxWx3 uint8 RGB with transparency flattened on WHITE: generators often return a PNG whose
    background is transparent, and the draw quality gate composites such pixels over white too."""
    import cv2

    raw = cv2.imread(str(Path(path).expanduser()), cv2.IMREAD_UNCHANGED)
    if raw is None:
        raise BadRequest(f"cannot read drawing {path}")
    if raw.dtype != np.uint8:
        raw = (raw.astype(np.float64) / np.iinfo(raw.dtype).max * 255).astype(np.uint8) if raw.dtype.kind in "ui" else (raw * 255).clip(0, 255).astype(np.uint8)
    if raw.ndim == 2:
        raw = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
    if raw.shape[2] == 4:
        alpha = raw[..., 3:4].astype(np.float64) / 255
        raw = (raw[..., :3] * alpha + 255 * (1 - alpha)).round().astype(np.uint8)
    return np.asarray(cv2.cvtColor(raw, cv2.COLOR_BGR2RGB))


def view_direction(view: str | None, azimuth_deg: float | None, elevation_deg: float | None) -> tuple[float, float]:
    """The (azimuth, elevation) a drawn view is compared at: a named view XOR both explicit angles."""
    explicit = azimuth_deg is not None or elevation_deg is not None
    if view is not None and explicit:
        raise BadRequest("give a drawn view's `view` name or its azimuth_deg + elevation_deg, not both")
    if azimuth_deg is not None and elevation_deg is not None:
        return float(azimuth_deg), float(elevation_deg)
    if explicit:
        raise BadRequest("an explicit direction needs both azimuth_deg and elevation_deg")
    if view in GENERATED_VIEW_ANGLES:
        return GENERATED_VIEW_ANGLES[view]
    raise BadRequest(f"a generated view needs `view` ({'|'.join(GENERATED_VIEW_ANGLES)}) or azimuth_deg + elevation_deg")


def drawn_silhouette(rgb: np.ndarray) -> np.ndarray | None:
    """Object silhouette of a drawn view on a white background: everything that is not white-connected-to-the-border
    (a white label inside the tool stays part of it), largest component. None when there is no usable object."""
    import cv2

    image = np.asarray(rgb)
    ink = (255 - image[..., :3].min(axis=2)) > _WHITE_TOLERANCE
    _, labels = cv2.connectedComponents((~ink).astype(np.uint8), connectivity=4)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    inside = ~np.isin(labels, border[border != 0])  # background = the white regions that touch the border; ink and enclosed white stay
    count, comp, stats, _ = cv2.connectedComponentsWithStats(inside.astype(np.uint8), connectivity=8)
    if count < 2:
        return None
    largest = comp == 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    fraction = float(largest.mean())
    return largest if _MIN_AREA_FRACTION <= fraction <= _MAX_AREA_FRACTION else None


def model_silhouette(fit: dict[str, Any], azimuth_deg: float, elevation_deg: float) -> np.ndarray:
    """The fit's silhouette seen from (azimuth, elevation) in the object frame (the library's canonical camera + hard rasteriser)."""
    from threed_vision import render

    lib = _lib()
    vertices, faces = render.mesh_from_fit(fit, ring=lib.EXPORT_RING)
    camera = lib.canonical_camera(fit, azimuth_deg, elevation_deg)
    return render.hard_mask(vertices, faces, camera["K"], camera["R"], camera["t"], (camera["size"], camera["size"]))


class _Shape(NamedTuple):
    area: float
    centroid: tuple[float, float]
    theta: float  # principal-axis angle, radians
    ratio: float  # major / minor axis length, >= 1


def _shape(mask: np.ndarray) -> _Shape:
    import cv2

    m = cv2.moments(mask.astype(np.uint8), binaryImage=True)
    area = m["m00"]
    mu20, mu02, mu11 = m["mu20"] / area, m["mu02"] / area, m["mu11"] / area
    spread = math.hypot((mu20 - mu02) / 2, mu11)
    major, minor = (mu20 + mu02) / 2 + spread, (mu20 + mu02) / 2 - spread
    return _Shape(area, (m["m10"] / area, m["m01"] / area), 0.5 * math.atan2(2 * mu11, mu20 - mu02), math.sqrt(major / max(minor, 1e-9)))


def _shrunk(mask: np.ndarray) -> np.ndarray:
    """`mask` shrunk (area-averaged, so a thin line survives) until it is at most twice the canvas scale: warping a huge
    mask straight down with a point sample aliases away its thin parts."""
    import cv2

    scale = math.sqrt(_FILL * _CANVAS_W * _CANVAS_H / float(mask.sum()))
    if scale >= 0.5:
        return mask
    small = cv2.resize(mask.astype(np.uint8) * 255, None, fx=2 * scale, fy=2 * scale, interpolation=cv2.INTER_AREA)
    return small >= _MIN_MASK_VALUE


def _normalised(mask: np.ndarray, shape: _Shape, extra_deg: float, mirror: bool) -> np.ndarray:
    """The silhouette with its principal axis horizontal (plus `extra_deg`, optionally mirrored across that axis), scaled to
    `_FILL` of the canvas and centred on its centroid: the comparison is blind to scale, position and in-plane rotation."""
    import cv2

    angle = -(shape.theta + math.radians(extra_deg))
    rotation = np.array([[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]])
    matrix = math.sqrt(_FILL * _CANVAS_W * _CANVAS_H / shape.area) * rotation
    if mirror:
        matrix = np.diag([1.0, -1.0]) @ matrix
    shift = np.array([_CANVAS_W / 2, _CANVAS_H / 2]) - matrix @ np.array(shape.centroid)
    warped = cv2.warpAffine(mask.astype(np.uint8) * 255, np.hstack([matrix, shift[:, None]]), (_CANVAS_W, _CANVAS_H), flags=cv2.INTER_LINEAR)
    return warped >= _FOREGROUND_VALUE


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    union = int((a | b).sum())
    return float((a & b).sum() / union) if union else 0.0


def silhouette_agreement(model: np.ndarray, drawn: np.ndarray) -> float:
    """IoU of two silhouettes after normalising scale, position and in-plane rotation; the best of the four flips of the
    principal axis (a round silhouette: of a sweep over the in-plane angle). Proportions and outline are what remain."""
    drawn = _shrunk(drawn)
    if not drawn.any():
        return 0.0
    model_shape, drawn_shape = _shape(model), _shape(drawn)
    reference = _normalised(model, model_shape, 0.0, False)
    sweep = (0, 180) if min(model_shape.ratio, drawn_shape.ratio) > _ROUND_RATIO else range(0, 360, _SWEEP_DEG)
    return max(_iou(reference, _normalised(drawn, drawn_shape, float(extra), mirror)) for extra in sweep for mirror in (False, True))


def check_generated(
    fit: dict[str, Any], generated: list[dict[str, Any]], *, flag_below: float = GENERATED_FLAG_BELOW
) -> list[dict[str, Any]]:
    """One row per drawn view: `{name, view, azimuth_deg, elevation_deg, iou, flag, usable, source: "generated"}`.

    `generated` items are `{image: HxWx3 uint8 RGB (white background), view: front|side|top|back}`, or an explicit
    `azimuth_deg` + `elevation_deg` in the object frame; optional `name`. `iou` is None (`usable` false) when the drawing
    has no object silhouette. The result NEVER feeds the confidence: see the module docstring."""
    _lib().validate_fit(fit)
    rows: list[dict[str, Any]] = []
    for item in generated:
        view = item.get("view")
        azimuth, elevation = view_direction(view, item.get("azimuth_deg"), item.get("elevation_deg"))
        model = model_silhouette(fit, azimuth, elevation)
        drawn = drawn_silhouette(item["image"])
        iou = silhouette_agreement(model, drawn) if drawn is not None and model.any() else None
        rows.append(
            {
                "name": item.get("name"),
                "view": view,
                "azimuth_deg": azimuth,
                "elevation_deg": elevation,
                "iou": iou,
                "flag": iou is None or iou < flag_below,
                "usable": iou is not None,
                "source": "generated",
            }
        )
    return rows


def summarise(check: dict[str, Any] | None, generated: list[dict[str, Any]] | None = None) -> dict[str, Any] | None:
    """The compact multi-view record of one object (objects.json `multiView`): per-view scores, the verdict and the
    sanity checks that failed. `generated` rows are kept apart from the photo views and never counted in `minIou`."""
    if not check:
        return None
    sanity = check.get("sanity") or {}
    return {
        "mode": check.get("mode"),
        "status": check.get("status"),
        "minIou": check.get("min_iou"),
        "flagBelow": check.get("flag_below"),
        "views": [
            {
                "source": "photo",
                "name": row.get("name"),
                "iou": row.get("iou"),
                "flag": row.get("flag"),
                "azimuthDeg": row.get("azimuth_deg"),
                "elevationDeg": row.get("elevation_deg"),
            }
            for row in check.get("views") or []
        ],
        "generatedViews": list(generated or []),
        "sanityOk": sanity.get("ok"),
        "sanityFailed": [c.get("name") for c in sanity.get("checks") or [] if not c.get("ok")],
    }


def request_view_event(
    items: list[dict[str, Any]], *, photo_id: str | None, threshold: float, limit: int = 8
) -> dict[str, Any] | None:
    """One `request_view` event per photo, listing the least confident items and the union of suggested views.

    `items` carry `id`, `confidence` and `check` (the multi-view result). Returns None when nothing needs a view.
    """
    wanting = [it for it in items if it.get("needs_view")]
    if not wanting:
        return None
    wanting.sort(key=lambda it: it["confidence"])
    chosen = wanting[:limit]
    suggested: list[dict[str, float]] = []
    for it in chosen:
        for view in (it.get("check") or {}).get("needs_views") or []:
            if view not in suggested:
                suggested.append(view)
    return {
        "type": "request_view",
        "reason": "low_confidence",
        "photoId": photo_id,
        "threshold": threshold,
        "items": [
            {
                "itemId": it["id"],
                "confidence": it["confidence"],
                "status": (it.get("check") or {}).get("status"),
                "suggested": (it.get("check") or {}).get("needs_views") or [],
            }
            for it in chosen
        ],
        "suggested": suggested,
        "totalWanting": len(wanting),
    }
