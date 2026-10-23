"""Record `tests/data/carpet-fit/` from a real `photo-to-objects` run on the carpet photo (docs/vision.md, "Multi-view").

    python record_carpet_fit.py RUN_DIR PHOTO_A PHOTO_B

`RUN_DIR` is an `objects.json` directory of PHOTO_A (`hsw-editor vision photo-to-objects PHOTO_A --out RUN_DIR --mm-per-px
1.263`); PHOTO_B is a second viewpoint of the same scene (the one recorded here is the carpet photo warped by the exact
plane homography of a 25 degree camera move about the world X axis, so its registration is known). The held-out masks are
what `hsw_vision.stages.multiview.register_views` produces for each object; the files hold only what
`test_multiview_recorded_fit.py` needs: the library fit of three objects, their masks seen from B and B's camera (stored once).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from threed_vision import io as tv_io

from hsw_vision.geometry import camera_from_calibration
from hsw_vision.stages import multiview

OBJECTS = {25: "multimeter (lathe)", 26: "box", 10: "flat"}
FIT_KEYS = ("kind", "template", "params", "dims_mm", "pose", "fixed_dims", "method", "views", "confidence")
OUT = Path(__file__).resolve().parent / "carpet-fit"


def main(run_dir: Path, photo_a: Path, photo_b: Path) -> None:
    result = json.loads((run_dir / "objects.json").read_text())
    camera = camera_from_calibration(result["calibration"])
    records = {r["id"]: r for r in result["objects"] if r["fit"]}
    masks = [cv2.imread(str(run_dir / records[i]["mask"]), cv2.IMREAD_GRAYSCALE) > 127 for i in OBJECTS]
    registration = multiview.register_views(tv_io.load_rgb(photo_a), tv_io.load_rgb(photo_b), masks, camera)
    assert registration["ok"] and registration["baseline_ok"], registration
    OUT.mkdir(exist_ok=True)
    views = dict(zip(OBJECTS, registration["views"], strict=True))
    camera = views[next(iter(OBJECTS))]  # photo B is ONE camera: every object's view carries the same K, R, t
    fits: dict[str, object] = {}
    for obj_id, label in OBJECTS.items():
        name = f"view-b-{obj_id:03d}.png"
        cv2.imwrite(str(OUT / name), views[obj_id]["mask"].astype(np.uint8) * 255, [cv2.IMWRITE_PNG_COMPRESSION, 9])
        fits[str(obj_id)] = {
            "label": label,
            "fit": {k: records[obj_id]["fit"][k] for k in FIT_KEYS},
            "viewMask": name,
            "trainIou": records[obj_id]["fit"]["views"][0]["iou"],
        }
    summary = {k: registration[k] for k in ("matches", "inliers", "median_reproj_px", "rel_rot_deg")}
    doc = {
        "source": "carpet photo 2026-10-21, mm_per_px 1.263; view B = plane homography of a 25 degree camera move",
        "registration": summary,
        "camera": {key: np.asarray(camera[key]).tolist() for key in ("K", "R", "t")},
        "objects": fits,
    }
    (OUT / "fits.json").write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
