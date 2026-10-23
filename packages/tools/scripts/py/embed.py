"""CLIP embeddings for the recognition prototypes and the labelled evaluation crops (3d-cli `threed_vision` encoder).

Run with a Python that has onnxruntime + opencv + tokenizers and `threed_vision` importable, e.g.
  PYTHONPATH=~/xp/3d-cli/.worktrees/vision-seg/packages/threed-vision/src \
    ~/.cache/hsw-editor/spikes/vision/.venv/bin/python embed.py protos <prototype dir>
  ... embed.py crops <labels.json> <out dir> --image <photo> --masks <pipe_masks.npy>

Outputs raw little-endian float32 matrices (`*.f32`, L2-normalised rows) plus a `meta.json` describing them; the TS side
(`src/recognize/`) does all scoring so there is exactly one implementation of the fusion.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from threed_vision.clip import ClipEncoder, crop_masked


def read_rgb(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise SystemExit(f"cannot read {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def write_matrix(path: Path, m: np.ndarray) -> None:
    path.write_bytes(np.ascontiguousarray(m, dtype="<f4").tobytes())


def cmd_protos(args: argparse.Namespace) -> None:
    root = Path(args.dir)
    manifest = json.loads((root / "manifest.json").read_text())
    classes = json.loads((root / "classes.json").read_text())
    enc = ClipEncoder("auto")
    enc.load()
    imgs = [read_rgb(root / "img" / m["file"]) for m in manifest]
    emb = enc.images(imgs)
    write_matrix(root / "prototypes.f32", emb)
    text = []
    for c in classes:
        e = enc.texts(c["prompts"])
        mean = e.mean(0)
        text.append(mean / np.linalg.norm(mean))
    write_matrix(root / "text.f32", np.stack(text))
    (root / "meta.json").write_text(
        json.dumps({"dim": int(emb.shape[1]), "prototypes": len(manifest), "classes": [c["id"] for c in classes]})
    )
    print(f"{len(manifest)} prototypes, {len(classes)} classes, device={enc.device}")


def cmd_crops(args: argparse.Namespace) -> None:
    labels = json.loads(Path(args.labels).read_text())
    rgb = read_rgb(Path(args.image))
    masks = np.load(args.masks)
    crops = []
    for item in labels["crops"]:
        crop, _ = crop_masked(rgb, masks[item["index"]])
        crops.append(crop)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for item, crop in zip(labels["crops"], crops):
        cv2.imwrite(str(out / f"crop-{item['index']:03d}.png"), cv2.cvtColor(crop, cv2.COLOR_RGB2BGR))
    enc = ClipEncoder("auto")
    enc.load()
    emb = enc.images(crops)
    write_matrix(out / "crops.f32", emb)
    classes = json.loads(Path(args.classes).read_text())
    text = []
    for c in classes:
        e = enc.texts(c["prompts"])
        mean = e.mean(0)
        text.append(mean / np.linalg.norm(mean))
    write_matrix(out / "crop-text.f32", np.stack(text))
    (out / "crops-meta.json").write_text(
        json.dumps({"dim": int(emb.shape[1]), "crops": labels["crops"], "classes": [c["id"] for c in classes]})
    )
    print(f"{len(crops)} crops embedded")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("protos")
    p.add_argument("dir")
    p.set_defaults(fn=cmd_protos)
    c = sub.add_parser("crops")
    c.add_argument("labels")
    c.add_argument("out")
    c.add_argument("--image", required=True)
    c.add_argument("--masks", required=True)
    c.add_argument("--classes", required=True, help="classes.json written by prototypes.ts")
    c.set_defaults(fn=cmd_crops)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
