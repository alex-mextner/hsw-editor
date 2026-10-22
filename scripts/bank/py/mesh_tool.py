"""Mesh helper for the HSW bank ingest: probe, normalise-to-GLB and thumbnail rendering.

Protocol: `mesh_tool.py <job.json>` reads a job file, writes one JSON document to stdout.
Job kinds (field `op`):
  probe   {"files": [{"path": str}]}                     -> parts of each file with geometry hashes
  build   {"items": [BuildItem]}                        -> normalised GLB + thumbnail per item

Frames. Source CAD files are Z-up, right-handed. The bank frame is the wall frame of
packages/core: x to the right, y up, z out of the wall towards the room (right-handed, = glTF Y-up),
millimetres. A source part is mapped by a proper rotation described by two signed source axes:
`out` (the direction that points away from the wall) and `up`. x_wall = up x out, so a part printed
on its back (out = +z, up = +y) keeps its left/right handedness.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("PYOPENGL_PLATFORM", "egl")

import numpy as np  # noqa: E402
import trimesh  # noqa: E402

TOOL_VERSION = 4
HASH_DECIMALS = 2  # 0.01 mm
STEP_LINEAR_TOL_MM = 0.05
AXES = {
    "+x": (1, 0, 0), "-x": (-1, 0, 0),
    "+y": (0, 1, 0), "-y": (0, -1, 0),
    "+z": (0, 0, 1), "-z": (0, 0, -1),
}


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def orientation_matrix(out: str, up: str) -> np.ndarray:
    """Rows are the wall-frame axes expressed in the source frame; v_wall = R @ v_source."""
    o = np.array(AXES[out], dtype=float)
    u = np.array(AXES[up], dtype=float)
    if abs(float(o @ u)) > 1e-9:
        raise ValueError(f"out={out} and up={up} must be orthogonal")
    x = np.cross(u, o)
    return np.vstack([x, u, o])


def _load_scene(path: str):
    """Returns a list of (partId, mesh) with placement transforms applied, units = mm."""
    lower = path.lower()
    if lower.endswith((".step", ".stp")):
        loaded = trimesh.load(
            path, file_type="step", tol_linear=STEP_LINEAR_TOL_MM, tol_angular=0.3, merge_primitives=True
        )
        scale = 1000.0  # cascadio exports metres
    else:
        loaded = trimesh.load(path, process=False)
        scale = 1.0
    parts: list[tuple[str, trimesh.Trimesh]] = []
    if isinstance(loaded, trimesh.Trimesh):
        parts.append(("0", loaded.copy()))
    else:
        seen: set[str] = set()
        for node in loaded.graph.nodes_geometry:
            transform, geom_name = loaded.graph[node]
            if geom_name in seen:
                continue
            seen.add(geom_name)
            geom = loaded.geometry[geom_name]
            if not isinstance(geom, trimesh.Trimesh):
                continue
            mesh = geom.copy()
            mesh.apply_transform(transform)
            parts.append((str(geom_name), mesh))
    out = []
    for part_id, mesh in parts:
        if scale != 1.0:
            mesh.apply_scale(scale)
        if len(mesh.faces) == 0:
            continue
        out.append((part_id, mesh))
    return out


def geometry_hash(mesh: trimesh.Trimesh) -> str:
    """Exact-duplicate hash: translation- and triangle-order-invariant, 0.01 mm quantised."""
    q = np.round((mesh.vertices - mesh.vertices.min(axis=0)) * 10**HASH_DECIMALS).astype(np.int64)
    side = 1 << 21
    keys = (q[:, 0] * side + q[:, 1]) * side + q[:, 2]
    faces = np.sort(keys[mesh.faces], axis=1)
    faces = faces[np.lexsort((faces[:, 2], faces[:, 1], faces[:, 0]))]
    return hashlib.sha256(faces.tobytes()).hexdigest()


def shape_signature(mesh: trimesh.Trimesh) -> dict:
    """Tessellation-independent fingerprint used to cluster STEP/STL/3MF copies of the same part."""
    dims = sorted(float(d) for d in mesh.extents)
    try:
        volume = float(abs(mesh.volume))
    except Exception:  # noqa: BLE001 - non-watertight meshes have no reliable volume
        volume = 0.0
    return {"sortedDimsMm": [round(d, 2) for d in dims], "volumeMm3": round(volume, 1), "areaMm2": round(float(mesh.area), 1)}


HEX_FLAT_MM = 22.5  # flat-to-flat of an HSW cell plug
HEX_CORNER_MM = 25.98  # corner-to-corner


def _plug_end(mesh: trimesh.Trimesh):
    """Finds an end of the part whose footprint is the 26 x 22.5 hex of an HSW plug.

    Returns (wall_face_name, corner_axis, flat_axis) or None. The wall face looks along the returned
    signed axis, so `out` is its opposite.
    """
    lo, hi = mesh.bounds
    verts = mesh.vertices
    best = None
    for axis in range(3):
        others = [a for a in range(3) if a != axis]
        for sign, extreme in ((-1, lo[axis]), (1, hi[axis])):
            slab = verts[np.abs(verts[:, axis] - extreme) < 0.6]
            if len(slab) < 6:
                continue
            ext = slab.max(axis=0) - slab.min(axis=0)
            for corner, flat in (others, others[::-1]):
                err = abs(ext[corner] - HEX_CORNER_MM) + abs(ext[flat] - HEX_FLAT_MM)
                if err < 0.8 and (best is None or err < best[0]):
                    best = (err, axis, sign, corner, flat)
    if best is None:
        return None
    _, axis, sign, corner, flat = best
    return axis, sign, corner, flat


def guess_orientation(mesh: trimesh.Trimesh) -> dict:
    """Guess (out, up): a hex plug end is the wall face; otherwise the largest flat face on the bbox is."""
    plug = _plug_end(mesh)
    if plug is not None:
        axis, sign, _corner, flat = plug
        out = ("+" if sign < 0 else "-") + "xyz"[axis]
        return {"out": out, "up": "+" + "xyz"[flat], "wallFaceAreaMm2": 0.0, "plug": True}
    lo, hi = mesh.bounds
    normals, areas, centers = mesh.face_normals, mesh.area_faces, mesh.triangles_center
    best, best_area = "+z", -1.0
    for axis, name in enumerate("xyz"):
        for sign, extreme in ((-1, lo[axis]), (1, hi[axis])):
            flat = normals[:, axis] * sign > 0.985
            near = np.abs(centers[:, axis] - extreme) < 0.4
            area = float(areas[flat & near].sum())
            if area > best_area:
                best_area = area
                best = ("+" if sign < 0 else "-") + name  # wall face looks along `sign`; out is the opposite
    up = "+y" if best[1] == "z" else "+z"
    return {"out": best, "up": up, "wallFaceAreaMm2": round(best_area, 1), "plug": False}


def read_3mf_metadata(path: str) -> dict[str, str]:
    """Title/Designer/License etc. embedded by slicers (Bambu Studio, Creality Print)."""
    import html
    import re
    import zipfile

    wanted = {"Title", "Designer", "License", "Origin", "Application"}
    meta: dict[str, str] = {}
    with zipfile.ZipFile(path) as archive:
        for name in archive.namelist():
            if name.lower().endswith("3dmodel.model"):
                text = archive.read(name).decode("utf8", "ignore")[:300000]
                for key, value in re.findall(r'<metadata name="(\w+)"[^>]*>([^<]{0,300})', text):
                    if key in wanted and value.strip():
                        meta[key] = html.unescape(html.unescape(value)).strip()
                link = re.search(r"https?://(?:www\.)?(?:printables|makerworld)\.com/[^\s\\\"&<]+", html.unescape(html.unescape(text)))
                if link:
                    meta["SourceLink"] = link.group(0)
                break
    return meta


def op_probe(job: dict) -> dict:
    result = []
    for item in job["files"]:
        path = item["path"]
        entry = {"path": path, "sha256": sha256_file(path), "parts": [], "error": None, "meta": {}}
        try:
            if path.lower().endswith(".3mf"):
                entry["meta"] = read_3mf_metadata(path)
            for part_id, mesh in _load_scene(path):
                lo, hi = mesh.bounds
                entry["parts"].append({
                    "partId": part_id,
                    "triangles": int(len(mesh.faces)),
                    "bboxMm": [[round(float(c), 3) for c in lo], [round(float(c), 3) for c in hi]],
                    "geometryHash": geometry_hash(mesh),
                    "watertight": bool(mesh.is_watertight),
                    **shape_signature(mesh),
                    "guess": guess_orientation(mesh),
                })
        except Exception as exc:  # noqa: BLE001 - report and continue with the next file
            entry["error"] = f"{type(exc).__name__}: {exc}"
        result.append(entry)
    return {"toolVersion": TOOL_VERSION, "files": result}


# ---------------------------------------------------------------- build

def _anchor_and_cells(mesh: trimesh.Trimesh, col_pitch: float, row_pitch: float, back_mm: float, anchor_mode: str):
    """Anchor (x,y mm) and footprint cells for a mesh already in the wall frame with min z = 0.

    anchor_mode "origin" keeps the source origin (parts modelled around a mount point); "back-bbox"
    centres the anchor on the bounding box of the wall-facing slab (z <= back_mm).
    """
    verts = mesh.vertices
    slab = verts[verts[:, 2] <= back_mm]
    if len(slab) == 0:
        slab = verts
    lo, hi = slab[:, :2].min(axis=0), slab[:, :2].max(axis=0)
    if anchor_mode == "origin":
        ax, ay = 0.0, 0.0
    else:
        ax, ay = float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2)
    # cells of the lattice whose centres fall inside the wall-facing silhouette
    cells = _cells_in_silhouette(mesh, back_mm, ax, ay, col_pitch, row_pitch)
    return ax, ay, cells


def _cells_in_silhouette(mesh, back_mm, ax, ay, col_pitch, row_pitch):
    from shapely.geometry import Point
    from shapely.ops import unary_union

    section = mesh.section(plane_origin=[0, 0, min(back_mm, mesh.bounds[1][2]) * 0.5 + 0.01], plane_normal=[0, 0, 1])
    polygons = []
    if section is not None:
        planar, to_3d = section.to_2D()
        polys = list(planar.polygons_full)
        polygons = [p for p in polys if p.is_valid and p.area > 1.0]
        if polygons:
            # to_2D may rotate/translate: map points through the transform instead of assuming identity
            inv = np.linalg.inv(to_3d)
            def to_planar(x, y):
                p = inv @ np.array([x, y, 0.0, 1.0])
                return p[0], p[1]
        else:
            to_planar = None
    else:
        to_planar = None
    if not polygons:
        return None
    union = unary_union(polygons).buffer(0.5)
    half_row = row_pitch / 2
    lo, hi = mesh.bounds
    cells = []
    d_col_max = int(np.ceil((hi[0] - lo[0]) / col_pitch)) + 2
    d_row2_max = int(np.ceil((hi[1] - lo[1]) / half_row)) + 2
    for d_col in range(-d_col_max, d_col_max + 1):
        for d_row2 in range(-d_row2_max, d_row2_max + 1):
            if (d_row2 - d_col) % 2:
                continue
            x = ax + d_col * col_pitch
            y = ay + d_row2 * half_row
            px, py = to_planar(x, y)
            if union.contains(Point(px, py)):
                cells.append((d_col, d_row2))
    return cells


def _smooth_normals(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    return trimesh.graph.smooth_shade(mesh, angle=np.radians(35.0))


def op_build(job: dict) -> dict:
    results = []
    pitch = job["grid"]
    for item in job["items"]:
        entry = {"key": item["key"], "ok": False, "error": None}
        try:
            parts = dict(_load_scene(item["path"]))
            mesh = parts[item["partId"]].copy()
            mesh.merge_vertices()
            mesh.remove_unreferenced_vertices()
            if item.get("scale", 1.0) != 1.0:
                mesh.apply_scale(item["scale"])
            rot = orientation_matrix(item["orient"]["out"], item["orient"]["up"])
            transform = np.eye(4)
            transform[:3, :3] = rot
            mesh.apply_transform(transform)
            if item["orient"].get("mirrorX"):
                # Only for sources flagged as mirrored copies; keeps winding valid.
                mesh.apply_transform(np.diag([-1, 1, 1, 1]))
                mesh.invert()
            mesh.fix_normals()
            anchor_mode = item["anchor"]
            lo = mesh.bounds[0]
            # wall face at z = 0
            mesh.apply_translation([0, 0, -lo[2]])
            ax, ay, cells = _anchor_and_cells(mesh, pitch["colPitchMm"], pitch["rowPitchMm"], item["backSlabMm"], anchor_mode)
            if cells is None or len(cells) == 0:
                cells = [(0, 0)]
            if anchor_mode != "origin":
                mesh.apply_translation([-ax, -ay, 0])
            lo, hi = mesh.bounds
            entry["bboxMm"] = {"min": [round(float(c), 3) for c in lo], "max": [round(float(c), 3) for c in hi]}
            entry["triangles"] = int(len(mesh.faces))
            entry["cells"] = [list(map(int, c)) for c in cells]
            entry["watertight"] = bool(mesh.is_watertight)
            entry["anchorSourceMm"] = [round(ax, 3), round(ay, 3)]
            shaded = _smooth_normals(mesh)
            scene = trimesh.Scene(shaded)
            Path(item["glb"]).parent.mkdir(parents=True, exist_ok=True)
            glb = scene.export(file_type="glb", include_normals=True)
            Path(item["glb"]).write_bytes(glb)
            if item.get("thumbnail"):
                render_thumbnail(shaded, item["thumbnail"], item.get("color", "#4f7fb0"), item.get("views", ["iso"]))
            entry["ok"] = True
        except Exception as exc:  # noqa: BLE001 - one bad part must not abort the batch
            import traceback
            entry["error"] = f"{type(exc).__name__}: {exc}"
            entry["trace"] = traceback.format_exc(limit=4)
        results.append(entry)
    return {"toolVersion": TOOL_VERSION, "items": results}


# ---------------------------------------------------------------- render

_RENDERER = None


def _renderer(size: int):
    global _RENDERER
    import pyrender

    if _RENDERER is None or _RENDERER.viewport_width != size:
        _RENDERER = pyrender.OffscreenRenderer(size, size)
    return _RENDERER


def _look_at(eye, target, up=(0.0, 1.0, 0.0)):
    eye = np.asarray(eye, float)
    f = np.asarray(target, float) - eye
    f /= np.linalg.norm(f)
    r = np.cross(f, up)
    r /= np.linalg.norm(r)
    u = np.cross(r, f)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = r, u, -f, eye
    return m


VIEWS = {
    # directions the camera sits at, in wall frame (x right, y up, z out)
    "iso": (0.75, 0.55, 1.0),
    "front": (0.0, 0.0, 1.0),
    "side": (1.0, 0.0, 0.0),
    "top": (0.0, 1.0, 0.001),
}


def render_png(mesh: trimesh.Trimesh, view: str, color: str, size: int = 384) -> "np.ndarray":
    import pyrender

    rgb = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    material = pyrender.MetallicRoughnessMaterial(baseColorFactor=[*rgb, 1.0], metallicFactor=0.05, roughnessFactor=0.55)
    scene = pyrender.Scene(bg_color=[0, 0, 0, 0], ambient_light=[0.22, 0.23, 0.25])
    scene.add(pyrender.Mesh.from_trimesh(mesh, material=material, smooth=False))
    centre = mesh.bounds.mean(axis=0)
    radius = float(np.linalg.norm(mesh.extents) / 2) or 1.0
    direction = np.asarray(VIEWS[view], float)
    direction /= np.linalg.norm(direction)
    camera = pyrender.OrthographicCamera(xmag=radius * 1.08, ymag=radius * 1.08, znear=0.1, zfar=radius * 20)
    cam_node = scene.add(camera, pose=_look_at(centre + direction * radius * 6, centre))
    for sign, intensity in ((1.0, 2.4), (-1.0, 0.7)):
        light = pyrender.DirectionalLight(color=np.ones(3), intensity=intensity)
        scene.add(light, pose=_look_at(centre + np.array([sign * 1.0, 1.2, 1.4]) * radius * 4, centre))
    scene.add(pyrender.DirectionalLight(color=np.ones(3), intensity=0.5), pose=cam_node.matrix)
    flags = pyrender.RenderFlags.RGBA
    color_img, _ = _renderer(size).render(scene, flags=flags)
    return color_img


def render_thumbnail(mesh, out_path: str, color: str, views: list[str]) -> None:
    from PIL import Image

    size = 384
    images = [Image.fromarray(render_png(mesh, v, color, size)) for v in views]
    target = 192 if len(images) == 1 else 192
    tiles = [im.resize((target, target), Image.LANCZOS) for im in images]
    sheet = Image.new("RGBA", (target * len(tiles), target), (0, 0, 0, 0))
    for i, tile in enumerate(tiles):
        sheet.paste(tile, (i * target, 0))
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, "WEBP", quality=72, method=6)


def main() -> None:
    job = json.loads(Path(sys.argv[1]).read_text())
    op = job["op"]
    if op == "probe":
        out = op_probe(job)
    elif op == "build":
        out = op_build(job)
    else:
        raise SystemExit(f"unknown op {op}")
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
