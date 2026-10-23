"""The segmenter engine of a `SegmentParams` variant: its name separates the qualities and the library gets the choice."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from hsw_vision.config import VisionConfig
from hsw_vision.engines import build_manager, ensure_segmenter, segmenter_name, segmenter_spec


class RecordingSegmenter:
    """TEST DOUBLE: stands in for `threed_vision.segment.Segmenter` and records its constructor arguments."""

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


@pytest.fixture
def manager(tmp_path: Path) -> Any:
    config = VisionConfig(
        models_dir=tmp_path / "models", cache_dir=tmp_path / "cache", state_path=tmp_path / "state.json", device="cpu"
    )
    return build_manager(config, free_vram_fn=lambda: 8000)


def test_each_quality_is_its_own_engine_name(manager: Any) -> None:
    fast = ensure_segmenter(manager, method="sam2", quality="fast")
    accurate = ensure_segmenter(manager, method="sam2", quality="accurate")
    assert fast != accurate
    assert fast == segmenter_name(method="sam2", quality="fast", fill="owlv2", reject_bg=True, points_per_side=32)
    assert ensure_segmenter(manager, method="sam2") == fast  # the sidecar default is fast


def test_the_library_segmenter_is_built_with_the_requested_quality(
    manager: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    from threed_vision import segment as tv_segment

    monkeypatch.setattr(tv_segment, "Segmenter", RecordingSegmenter)
    spec = segmenter_spec(
        manager, method="sam2", quality="accurate", fill="none", reject_bg=False, points_per_side=24
    )
    engine = spec.factory("cpu")
    assert isinstance(engine, RecordingSegmenter)
    assert engine.kwargs == {
        "method": "sam2",
        "quality": "accurate",
        "fill": "none",
        "reject_bg": False,
        "device": "cpu",
        "points_per_side": 24,
    }
