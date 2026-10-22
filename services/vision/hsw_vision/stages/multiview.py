"""Multi-view stage: render the fit into every other available view and compare silhouettes
(`threed_vision.view_check.check`). Without a second view the library runs its single-photo sanity mode
(status `unverified`) and the fit's confidence stays capped (see `hsw_vision.confidence`).
"""

from __future__ import annotations

from typing import Any


def _lib() -> Any:
    from threed_vision import view_check

    return view_check


def check_fit(fit: dict[str, Any], views: list[dict[str, Any]], *, flag_below: float) -> dict[str, Any]:
    """`{"views": [{"iou", "flag"}], "min_iou", "status", "needs_views": [{"azimuth_deg", "elevation_deg"}]}`.

    `views` are `{mask, K, R, t}` of other photos of the same object; `[]` = single-photo sanity mode.
    """
    from threed_vision import io as tv_io

    result = _lib().check(fit, views, flag_below=flag_below)
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
