"""The ONE confidence policy of the service: how sure we are of a fitted object, and when it asks for another photo.

Used by `/fit`, `/multiview`, the wall proposal and the objects library, so the same fit has the same number everywhere.

* a **held-out view** (another photo from a different viewpoint, checked by `view_check`): the worst held-out silhouette
  IoU is the confidence;
* several training views, none held out: the worst training IoU;
* **one view**: the training IoU capped at `single_view_cap`: the silhouette is reproduced, the unseen 3-D shape is not
  verified (single-view fits predicted an unseen view with IoU 0.03-0.5 in the spike);
* a fit asks for another view when its confidence is below `view_flag_iou`, or the library flagged a checked view.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


def _unit(value: float) -> float:
    """Clamp to [0, 1]; NaN (0/0 IoU of two empty silhouettes) is 0, never 1."""
    return 0.0 if value != value else float(max(0.0, min(1.0, value)))


def fit_confidence(fit: dict[str, Any], single_view_cap: float) -> float:
    """Geometry confidence in [0, 1] from the fit's own `confidence` block (held-out IoU, else the worst training IoU,
    capped for a single view)."""
    conf = fit.get("confidence") or {}
    heldout = conf.get("heldout_iou")
    if heldout is not None:
        return _unit(heldout)
    train = conf.get("train_min_iou")
    if train is None:
        views = fit.get("views") or []
        train = min((v.get("iou", 0.0) for v in views), default=0.0)
    value = _unit(train)
    n_views = int(conf.get("n_views") or len(fit.get("views") or []) or 1)
    return min(value, single_view_cap) if n_views <= 1 else value


def view_confidence(check: dict[str, Any] | None) -> float | None:
    """Worst IoU across the checked extra views (NaN -> 0); None when nothing was checked."""
    if not check or not check.get("views"):
        return None
    value = check.get("min_iou")
    return None if value is None else _unit(value)


@dataclass(frozen=True)
class Assessment:
    confidence: float
    needs_view: bool


def assess(
    fit: dict[str, Any],
    check: dict[str, Any] | None,
    *,
    single_view_cap: float,
    view_flag_iou: float,
) -> Assessment:
    """`check` is the `view_check` result (None when no check ran). Checked views beat the fit's own training IoU."""
    checked = view_confidence(check)
    confidence = checked if checked is not None else fit_confidence(fit, single_view_cap)
    flagged = bool(check and check.get("needs_views") and check.get("status") in ("low", "flagged"))
    return Assessment(confidence=confidence, needs_view=confidence < view_flag_iou or flagged)
