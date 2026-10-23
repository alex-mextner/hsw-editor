"""`describe`: the masks go to disk as lossless PNGs that `threed_vision.io.load_mask` reads back bit for bit."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from threed_vision import io as tv_io

from helpers import IMAGE_H, IMAGE_W, raw_instances
from hsw_vision.stages import segment as stage_segment


def test_describe_writes_exact_mask_pngs_an_overlay_and_the_file_list(tmp_path: Path) -> None:
    raw = raw_instances()
    rgb = np.full((IMAGE_H, IMAGE_W, 3), 90, np.uint8)
    out = stage_segment.describe(rgb, raw, tmp_path / "seg", files_prefix="seg-1/")
    assert [i["mask"] for i in out["instances"]] == ["masks/001.png", "masks/002.png", "masks/003.png"]
    for inst, src in zip(out["instances"], raw["instances"], strict=True):
        assert (tmp_path / "seg" / inst["mask"]).is_file()
        assert np.array_equal(tv_io.load_mask(tmp_path / "seg" / inst["mask"]), src["mask"])
        assert inst["polygon"] and inst["area_px"] == int(src["mask"].sum())
    assert out["overlay"] == "overlay.jpg" and (tmp_path / "seg" / "overlay.jpg").is_file()
    assert out["_files"] == [f"seg-1/masks/00{i}.png" for i in (1, 2, 3)] + ["seg-1/overlay.jpg"]


def test_describe_without_instances_writes_no_overlay(tmp_path: Path) -> None:
    rgb = np.zeros((IMAGE_H, IMAGE_W, 3), np.uint8)
    out = stage_segment.describe(rgb, {"instances": [], "method": "fake", "device": "cpu"}, tmp_path / "seg")
    assert out["instances"] == [] and out["overlay"] is None and out["_files"] == []
    assert not (tmp_path / "seg" / "overlay.jpg").exists()
