"""Fit stage: one mask + calibrated camera -> parametric 3-D fit. The algorithm is `threed_vision.fit.fit_auto`
(closed form first, soft-silhouette optimiser only when the closed form does not reproduce the mask, CMA-ES only
when the held-out confidence is low). Dimension overrides from the user are hard constraints (`fixed_dims`).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from hsw_vision.errors import BadRequest
from hsw_vision.geometry import Camera, rotation_z_deg, rz
from hsw_vision.manager import is_oom

DIM_KEYS = ("length_mm", "max_width_mm", "thickness_mm")


def _lib() -> Any:
    from threed_vision import fit

    return fit


def normalise_fixed_dims(fixed: dict[str, float] | None) -> dict[str, float] | None:
    """Accept `{length_mm|length: 160}` (mm) and return library keys; rejects unknown keys and non-positive values."""
    if not fixed:
        return None
    out: dict[str, float] = {}
    for key, value in fixed.items():
        lib_key = key if key.endswith("_mm") else f"{key}_mm"
        lib_key = {"width_mm": "max_width_mm"}.get(lib_key, lib_key)
        if lib_key not in DIM_KEYS:
            raise BadRequest(f"unknown dimension {key!r}; use length, width, thickness (mm)")
        if not value or value <= 0:
            raise BadRequest(f"dimension {key} must be positive")
        out[lib_key] = float(value)
    return out


def fit_mask(
    mask: np.ndarray,
    camera: Camera,
    *,
    fixed_dims: dict[str, float] | None = None,
    template: str | None = None,
    planar: bool = True,
    known_depth: float | None = None,
    extra_views: list[dict[str, Any]] | None = None,
    heldout_views: list[dict[str, Any]] | None = None,
    device: str = "auto",
    max_tries: int = 3,
    seed: int = 0,
) -> dict[str, Any]:
    """Fit one object. `extra_views` are more `{mask, K, R, t}` of the SAME object (joint multi-view fit)."""
    from threed_vision import io as tv_io

    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise BadRequest("empty mask")
    centre_px = [float(xs.mean()), float(ys.mean())]
    views = [camera.view(mask), *(extra_views or [])]
    kwargs: dict[str, Any] = {
        "planar": planar,
        "fixed_dims": normalise_fixed_dims(fixed_dims),
        "max_tries": max_tries,
        "seed": seed,
        "device": device,
    }
    if template:
        kwargs["template"] = template
    if len(views) == 1 or known_depth is not None:
        kwargs["known_depth"] = known_depth if known_depth is not None else camera.depth_at(np.array(centre_px))
    if heldout_views:
        kwargs["heldout_views"] = heldout_views
    lib = _lib()
    try:
        result = lib.fit_auto(views, **kwargs)
    except Exception as exc:
        if not (is_oom(exc) and device != "cpu"):
            raise
        result = lib.fit_auto(views, **{**kwargs, "device": "cpu"})
    out = tv_io.to_jsonable(result)
    out["centre_px"] = centre_px
    return out


def _unit(value: float) -> float:
    """Clamp to [0, 1]; NaN (0/0 IoU of two empty silhouettes) is 0, never 1."""
    return 0.0 if value != value else float(max(0.0, min(1.0, value)))


def fit_confidence(fit: dict[str, Any], single_view_cap: float) -> float:
    """Geometry confidence in [0, 1]: held-out IoU when a held-out view exists, else the worst training IoU
    (capped for a single view, whose silhouette fit says little about the unseen 3-D shape)."""
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


def local_mesh(fit: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, float, np.ndarray]:
    """Mesh of the fit relative to the object: `(vertices, faces, heading_deg, centre_mm)`.

    Vertices are in the wall frame translated to the object centre and with the heading (rotation about the wall
    normal) removed: item `pose.rotZ = heading` puts them back, so a snapped/rotated UI item stays editable.
    Any tilt of a non-planar fit stays baked into the vertices.
    """
    from threed_vision import render

    verts, faces = render.mesh_from_fit(fit)
    r0 = np.asarray(fit["pose"]["R0"], dtype=float)
    centre = np.asarray(fit["pose"]["t_mm"], dtype=float)
    heading = rotation_z_deg(r0)
    r_res = rz(-heading) @ r0
    local = (np.asarray(verts, dtype=float) - centre) @ r0  # object frame: X along the length
    return local @ r_res.T, np.asarray(faces), heading, centre


def write_glb(fit: dict[str, Any], path: Path) -> dict[str, float]:
    """Write the fit as a binary glTF in the wall frame (mm, y up, z out); returns heading and centre."""
    import trimesh

    vertices, faces, heading, centre = local_mesh(fit)
    path.parent.mkdir(parents=True, exist_ok=True)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    path.write_bytes(bytes(mesh.export(file_type="glb")))
    return {"heading_deg": heading, "x": float(centre[0]), "y": float(centre[1]), "z": float(centre[2])}


def dimensions(fit: dict[str, Any]) -> dict[str, float]:
    dims = fit.get("dims_mm") or {}
    return {key: float(dims[key]) for key in DIM_KEYS if dims.get(key) is not None}
