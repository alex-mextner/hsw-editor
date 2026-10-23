"""Mesh helper for user-made bank elements (probe an upload, convert it to the wall frame).

Lives beside, not inside, ``scripts/bank/py``: that directory is hashed into the cache key of every element
of the built bank, so touching it would rebuild the whole bank. This tool reuses its functions
(orientation, silhouette/footprint detection, thumbnail rendering) through an import.

Job document (JSON, argv[1]) -> result (JSON, argv[2], a file because GL libraries print to stdout):
  {"op": "probe",   "path": ..., "unit": "auto|mm|cm|m|in"}
  {"op": "convert", "path": ..., "partId": ..., "orient": {"out": "+z", "up": "+y"}, "anchor": "back-bbox",
                    "unit": ..., "repair": true, "grid": {...}, "backSlabMm": 1, "glb": out.glb,
                    "thumbnail": out.webp | "", "color": "#rrggbb", "views": ["iso"]}

Wall frame, units and the meaning of orient: docs/bank.md ("Geometry frame", "User elements").
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import traceback
from pathlib import Path

PY_DIR = Path(__file__).resolve().parent.parent / "py"
sys.path.insert(0, str(PY_DIR))

import mesh_tool  # noqa: E402  (sets PYOPENGL_PLATFORM before numpy/trimesh)
import numpy as np  # noqa: E402
import trimesh  # noqa: E402

UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
# A glTF is defined in metres: a model under this many units across is a metre-scale file (a holder is never < 2 mm).
GLTF_METRE_LIMIT = 2.0


def load_parts(path: str, unit: str) -> list[tuple[str, trimesh.Trimesh]]:
    """(partId, mesh in mm) of every part of the file."""
    parts = mesh_tool._load_scene(path)  # noqa: SLF001 - shared loader of the bank pipeline
    if not parts:
        raise ValueError("the file contains no triangles")
    for _, mesh in parts:
        mesh.merge_vertices()  # STL is a triangle soup: welded vertices are needed for the watertight check
    scale = UNIT_MM.get(unit)
    if scale is None:  # auto
        scale = 1.0
        if path.lower().endswith((".glb", ".gltf")):
            lows = np.min([m.bounds[0] for _, m in parts], axis=0)
            highs = np.max([m.bounds[1] for _, m in parts], axis=0)
            if float(np.max(highs - lows)) < GLTF_METRE_LIMIT:
                scale = 1000.0
    if scale != 1.0:
        for _, mesh in parts:
            mesh.apply_scale(scale)
    return parts


def volume_box(mesh: trimesh.Trimesh) -> float:
    return float(np.prod(mesh.extents))


def op_probe(job: dict) -> dict:
    path = job["path"]
    parts = load_parts(path, job.get("unit", "auto"))
    result = []
    for part_id, mesh in parts:
        lo, hi = mesh.bounds
        guess = mesh_tool.guess_orientation(mesh)
        result.append({
            "partId": part_id,
            "triangles": int(len(mesh.faces)),
            "bboxMm": {"min": [round(float(c), 3) for c in lo], "max": [round(float(c), 3) for c in hi]},
            "watertight": bool(mesh.is_watertight),
            "guess": {"out": guess["out"], "up": guess["up"]},
            "boxVolume": volume_box(mesh),
        })
    result.sort(key=lambda p: -p["boxVolume"])
    digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return {"sha256": digest, "parts": result, "defaultPartId": result[0]["partId"]}


def select_part(parts: list[tuple[str, trimesh.Trimesh]], part_id: str | None) -> trimesh.Trimesh:
    if part_id == "*":
        return trimesh.util.concatenate([m for _, m in parts])
    if part_id is None:
        return max(parts, key=lambda p: volume_box(p[1]))[1].copy()
    found = dict(parts).get(part_id)
    if found is None:
        raise ValueError(f"no part {part_id!r}; parts: {[p for p, _ in parts]}")
    return found.copy()


def repair(mesh: trimesh.Trimesh) -> bool:
    """Cheap in-process repair; True when the mesh is watertight afterwards."""
    mesh.merge_vertices()
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    trimesh.repair.fix_inversion(mesh)
    trimesh.repair.fix_winding(mesh)
    trimesh.repair.fill_holes(mesh)
    trimesh.repair.fix_normals(mesh)
    return bool(mesh.is_watertight)


def software_thumbnail(mesh: trimesh.Trimesh, out_path: str, color: str, views: list[str]) -> None:
    """Painter's-algorithm thumbnail (orthographic, flat shading) for machines without EGL; same tile layout as render_thumbnail."""
    from PIL import Image, ImageDraw

    base = np.array([int(color[i:i + 2], 16) for i in (1, 3, 5)], float)
    size, target = 384, 192
    centre = mesh.bounds.mean(axis=0)
    radius = float(np.linalg.norm(mesh.extents) / 2) or 1.0
    tiles = []
    for view in views:
        d = np.asarray(mesh_tool.VIEWS[view], float)
        d /= np.linalg.norm(d)
        helper = np.array([0.0, 1.0, 0.0]) if abs(d[1]) < 0.99 else np.array([0.0, 0.0, -1.0])
        right = np.cross(helper, d)
        right /= np.linalg.norm(right)
        up = np.cross(d, right)
        rel = mesh.vertices - centre
        scale = size / 2 / (radius * 1.08)
        px = size / 2 + (rel @ right) * scale
        py = size / 2 - (rel @ up) * scale
        depth = rel @ d
        facing = mesh.face_normals @ d
        light = np.array([0.6, 0.7, 0.9])
        light /= np.linalg.norm(light)
        shade = 0.35 + 0.65 * np.clip(mesh.face_normals @ light, 0.0, 1.0)
        visible = np.flatnonzero(facing > 0)
        order = visible[np.argsort(depth[mesh.faces[visible]].mean(axis=1))]
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        for face in order:
            tri = [(float(px[i]), float(py[i])) for i in mesh.faces[face]]
            r, g, b = (base * shade[face]).astype(int).tolist()
            draw.polygon(tri, fill=(r, g, b, 255))
        tiles.append(image.resize((target, target), Image.LANCZOS))
    sheet = Image.new("RGBA", (target * len(tiles), target), (0, 0, 0, 0))
    for i, tile in enumerate(tiles):
        sheet.paste(tile, (i * target, 0))
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, "WEBP", quality=72, method=6)


def op_convert(job: dict) -> dict:
    mesh = select_part(load_parts(job["path"], job.get("unit", "auto")), job.get("partId"))
    mesh.merge_vertices()
    mesh.remove_unreferenced_vertices()
    watertight_before = bool(mesh.is_watertight)
    repaired = False
    if not watertight_before and job.get("repair", True):
        repaired = repair(mesh)
    orient = job["orient"]
    transform = np.eye(4)
    transform[:3, :3] = mesh_tool.orientation_matrix(orient["out"], orient["up"])
    mesh.apply_transform(transform)
    mesh.fix_normals()
    mesh.apply_translation([0, 0, -mesh.bounds[0][2]])  # wall face at z = 0
    anchor = job["anchor"]
    pitch = job["grid"]
    ax, ay, cells, mounting = mesh_tool._anchor_and_cells(  # noqa: SLF001
        mesh, pitch["colPitchMm"], pitch["rowPitchMm"], job["backSlabMm"], anchor
    )
    if anchor != "origin":
        mesh.apply_translation([-ax, -ay, 0])
    lo, hi = mesh.bounds
    shaded = mesh_tool._smooth_normals(mesh)  # noqa: SLF001
    glb = Path(job["glb"])
    glb.parent.mkdir(parents=True, exist_ok=True)
    glb.write_bytes(trimesh.Scene(shaded).export(file_type="glb", include_normals=True))
    thumbnail_fallback = False
    if job.get("thumbnail"):
        views = job.get("views", ["iso"])
        try:
            if os.environ.get("HSW_USER_MESH_NO_GL") == "1":  # tests: exercise the software path on a machine with EGL
                raise RuntimeError("GL disabled")
            mesh_tool.render_thumbnail(shaded, job["thumbnail"], job.get("color", "#4f7fb0"), views)
        except Exception:  # noqa: BLE001 - no EGL/GPU (a CI box, a server): draw it in software instead
            software_thumbnail(shaded, job["thumbnail"], job.get("color", "#4f7fb0"), views)
            thumbnail_fallback = True
    return {
        "bboxMm": {"min": [round(float(c), 3) for c in lo], "max": [round(float(c), 3) for c in hi]},
        "triangles": int(len(mesh.faces)),
        "cells": sorted([int(c), int(r)] for c, r in cells),
        "mountingCells": sorted([int(c), int(r)] for c, r in mounting),
        "watertight": bool(mesh.is_watertight),
        "repaired": repaired,
        "watertightBefore": watertight_before,
        "thumbnailFallback": thumbnail_fallback,
        "geometryHash": mesh_tool.geometry_hash(mesh),
    }


def main() -> None:
    job = json.loads(Path(sys.argv[1]).read_text())
    out_path = Path(sys.argv[2])
    try:
        op = job["op"]
        if op == "probe":
            out = {"ok": True, **op_probe(job)}
        elif op == "convert":
            out = {"ok": True, **op_convert(job)}
        else:
            raise SystemExit(f"unknown op {op}")
    except Exception as exc:  # noqa: BLE001 - reported to the caller as a message, not a crash
        out = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc(limit=4)}
    out_path.write_text(json.dumps(out))


if __name__ == "__main__":
    main()
