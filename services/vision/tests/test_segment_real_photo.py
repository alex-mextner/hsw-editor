"""Timing regression on the real carpet photo (private; skipped when the photo, the models or a free GPU are absent).

The default segmentation (`quality="fast"`) of the 2000x1500 tools-on-carpet photo must stay under 3 s warm on the
workstation GPU (hsw-editor #10): measured 2.4 s for the stage (1.6-1.9 s of it the library) on the shared RTX 4060 (docs/vision.md, "Segmentation speed"). It loads
SAM2 / OWLv2 / CLIP, so it only runs when asked for: `HSW_VISION_REAL_TIMING=1 uv run pytest tests/test_segment_real_photo.py`
under the heavy-run wrapper (flock + systemd-run MemoryMax=6G, scratch under ~/.cache/hsw-editor/).
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any

import pytest

PHOTOS = Path(os.environ.get("HSW_PHOTOS_DIR", "/home/ultra/dev/garage-band/projects/HSW/docs/photos"))
PHOTO = PHOTOS / "tools-on-carpet-2026-10-21.heic"

pytestmark = pytest.mark.real_photo

if os.environ.get("HSW_VISION_REAL_TIMING") != "1":
    pytest.skip("set HSW_VISION_REAL_TIMING=1 to load the models and time the real photo", allow_module_level=True)
if not PHOTO.is_file():
    pytest.skip("private HSW photos are not available", allow_module_level=True)

#: Warm budget of the default path on the GPU (the ticket's "< 3 s per photo"), and what the photo must still yield.
WARM_BUDGET_S = 3.0
MIN_INSTANCES = 80  # 91 measured; the accurate path gives 98 of which ~10 are carpet patches / part pieces


def test_default_segmentation_of_the_carpet_photo_is_fast_and_finds_the_tools(tmp_path: Path) -> None:
    from hsw_vision.config import VisionConfig
    from hsw_vision.engines import build_manager
    from hsw_vision.stages import segment as stage_segment
    from threed_vision import io

    config = VisionConfig.from_env()
    config.apply_to_environment()
    manager = build_manager(config)
    rgb = io.load_rgb(PHOTO)
    try:
        first = stage_segment.segment(rgb, tmp_path / "cold", manager=manager)
        if first["device"] != "cuda":
            pytest.skip(f"no free GPU for the engines (ran on {first['device']}): the 3 s budget is a GPU number")
        warm: list[dict[str, Any]] = []
        walls: list[float] = []
        for i in range(2):
            started = time.perf_counter()
            warm.append(stage_segment.segment(rgb, tmp_path / f"warm{i}", manager=manager))
            walls.append(time.perf_counter() - started)
    finally:
        manager.unload_all()
    assert first["timing_s"]["total"] > 0
    # the whole stage as the service runs it: library run + mask PNGs + overlay + polygons (1.6-1.9 s of the 2.4 s measured)
    best = min(walls)
    assert best < WARM_BUDGET_S, f"warm default segmentation took {best:.2f} s: {warm[-1]['timing_s']}"
    assert len(warm[-1]["instances"]) >= MIN_INSTANCES
    assert warm[-1]["method"].startswith("sam2")
