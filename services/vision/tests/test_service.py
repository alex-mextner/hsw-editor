"""Service-level guarantees found in review: atomic mask directories, one refresh per stage, validated extra photos,
cancellation inside the segmentation, cache identity of a segmentation."""

from __future__ import annotations

import threading
import time
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from helpers import fake_calibration, make_service, raw_instances
from hsw_vision import photo_to_wall
from hsw_vision.cache import ResultCache
from hsw_vision.errors import BadRequest, Cancelled
from hsw_vision.schemas import CalibrateParams, ImageRef, PhotoToWallRequest, SegmentParams
from hsw_vision.service import segmentation_digest, segmentation_identity
from hsw_vision.stages import segment as stage_segment


def test_segmentation_digest_changes_when_instances_are_renumbered() -> None:
    a = {"instances": [{"id": 1, "bbox_xywh": [0, 0, 5, 5], "area_px": 25}]}
    b = {"instances": [{"id": 2, "bbox_xywh": [0, 0, 5, 5], "area_px": 25}]}
    assert segmentation_digest(a) != segmentation_digest(b)
    assert segmentation_digest(a) == segmentation_digest({"instances": [{"id": 1, "bbox_xywh": (0, 0, 5, 5), "area_px": 25}]})


def test_same_content_in_another_directory_is_another_cache_identity(tmp_path: Path, photo: Path) -> None:
    """Two segmentations can agree on ids/boxes/areas with different masks (another method): the recognise/fit result of
    one must not be served for the other."""
    service, calls = make_service(tmp_path)
    img = service.open(ImageRef(image_path=photo, work_dir=tmp_path / "w"))
    seg_a = service.segment(img, SegmentParams())
    seg_b = service.segment(img, SegmentParams(points_per_side=16))
    assert segmentation_digest(seg_a) == segmentation_digest(seg_b) and seg_a["dir"] != seg_b["dir"]
    assert segmentation_identity(seg_a) != segmentation_identity(seg_b)
    service.recognise(img, seg_a, [1], None)
    service.recognise(img, seg_b, [1], None)
    assert calls.recognise == 2
    service.recognise(img, seg_a, [1], None)
    assert calls.recognise == 2


def test_every_segmentation_run_writes_a_new_mask_directory_and_old_ones_stay_readable(tmp_path: Path, photo: Path) -> None:
    """Review finding: a refresh rewrote the masks of the directory a concurrent request was decoding."""
    service, _ = make_service(tmp_path)
    ref = ImageRef(image_path=photo, work_dir=tmp_path / "w", refresh=True)
    first = service.segment(service.open(ref), SegmentParams())
    img = service.open(ref)
    second = service.segment(img, SegmentParams())
    assert first["dir"] != second["dir"]
    # a reader holding the first result still decodes its masks after the refresh
    assert 1 in service.masks(img, first, only=[1])
    third = service.segment(service.open(ref), SegmentParams())
    dirs = sorted(p.name for p in img.dir.glob("seg-*") if p.is_dir())
    assert dirs == sorted([second["dir"], third["dir"]])  # the oldest run was pruned, the newest two kept


def test_a_refresh_recomputes_each_stage_once_even_when_two_stages_need_it(tmp_path: Path, photo: Path) -> None:
    """Review finding: refresh + reference calibration ran SAM2 twice (once for the reference, once for the pipeline)."""
    service, calls = make_service(tmp_path)

    def calibrate(rgb: np.ndarray, **kwargs: Any) -> dict[str, Any]:
        calls.calibrate += 1
        assert kwargs["reference_mask"] is not None
        return fake_calibration(1.0, "reference")

    service.stages = replace(service.stages, calibrate=calibrate)
    request = PhotoToWallRequest(
        image_path=photo,
        work_dir=tmp_path / "w",
        refresh=True,
        calibrate=CalibrateParams(mode="reference", reference_instance=1, reference_length_mm=180),
    )
    photo_to_wall.run(service, request)
    assert calls.segment == 1 and calls.calibrate == 1


def test_concurrent_requests_for_one_key_compute_once(tmp_path: Path) -> None:
    cache = ResultCache(tmp_path)
    computed: list[int] = []

    def compute() -> dict[str, int]:
        computed.append(1)
        time.sleep(0.05)
        return {"v": 1}

    results: list[bool] = []
    threads = [
        threading.Thread(target=lambda: results.append(cache.get_or_compute("f" * 64, "s", {}, compute)[1])) for _ in range(6)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(computed) == 1 and sorted(results) == [False] + [True] * 5


def test_a_missing_extra_photo_is_a_cheap_422_before_any_stage_runs(tmp_path: Path, photo: Path) -> None:
    """Review finding: extra photos skipped `open` validation and failed after the segmentation ran."""
    service, calls = make_service(tmp_path)
    request = PhotoToWallRequest(image_path=photo, work_dir=tmp_path / "w", extra_photos=[tmp_path / "nope.jpg"])
    with pytest.raises(BadRequest, match="image not found"):
        photo_to_wall.run(service, request, img=None)
    assert (calls.segment, calls.calibrate) == (0, 0)


def test_a_corrupt_extra_photo_is_a_422(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    broken = tmp_path / "broken.jpg"
    broken.write_bytes(b"not an image")
    request = PhotoToWallRequest(image_path=photo, work_dir=tmp_path / "w", extra_photos=[broken])
    with pytest.raises(BadRequest):
        photo_to_wall.run(service, request)
    assert calls.segment == 0


def test_the_main_photo_and_duplicates_are_not_extra_views(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    registered: list[int] = []

    def register_views(rgb_a: Any, rgb_b: Any, masks_a: list[Any], camera: Any) -> dict[str, Any]:
        registered.append(len(masks_a))
        return {"ok": False, "baseline_ok": False, "views": [None] * len(masks_a)}

    service.stages = replace(service.stages, register_views=register_views)
    other = tmp_path / "other.png"
    other.write_bytes(photo.read_bytes())
    request = PhotoToWallRequest(
        image_path=photo, work_dir=tmp_path / "w", calibrate=CalibrateParams(mm_per_px=1.0), extra_photos=[photo, other, other]
    )
    photo_to_wall.run(service, request)
    assert registered == [2]  # only `other`, once


def test_cancelling_during_the_segmentation_stops_it_at_the_next_progress_tick(tmp_path: Path, photo: Path) -> None:
    """Review finding: cancellation was only checked between objects, so a cancelled job still ran the whole SAM2 pass."""
    service, calls = make_service(tmp_path)
    cancel = threading.Event()
    ticks: list[str] = []

    def segment(rgb: np.ndarray, out_dir: Path, *, progress: Any, files_prefix: str = "", **_: Any) -> dict[str, Any]:
        for n, name in enumerate(("grid", "masks", "fill")):
            progress(name, n / 3)
            ticks.append(name)
            if name == "masks":
                cancel.set()  # the caller goes away mid-run
        return stage_segment.describe(rgb, raw_instances(), out_dir, files_prefix=files_prefix)

    service.stages = replace(service.stages, segment=segment)
    img = service.open(ImageRef(image_path=photo, work_dir=tmp_path / "w"))
    with pytest.raises(Cancelled):
        service.segment(img, SegmentParams(), cancel=cancel)
    assert ticks == ["grid", "masks"]
    assert img.cache.get(img.sha256, "segment", SegmentParams().model_dump(mode="json")) is None  # nothing cached


def test_a_cancelled_pipeline_run_stops_before_the_next_stage(tmp_path: Path, photo: Path) -> None:
    service, calls = make_service(tmp_path)
    cancel = threading.Event()
    cancel.set()
    request = PhotoToWallRequest(image_path=photo, work_dir=tmp_path / "w", calibrate=CalibrateParams(mm_per_px=1.0))
    with pytest.raises(Cancelled):
        photo_to_wall.run(service, request, cancel=cancel)
    assert calls.segment == 0 and calls.fit == []


def test_concurrent_requests_for_one_photo_share_the_lock_across_cache_objects(tmp_path: Path) -> None:
    """Review finding: the lock table was per `ResultCache` and the service builds a cache per request."""
    computed: list[int] = []

    def compute() -> dict[str, int]:
        computed.append(1)
        time.sleep(0.05)
        return {"v": 1}

    def request() -> None:
        ResultCache(tmp_path).get_or_compute("f" * 64, "s", {}, compute)  # a NEW cache object each time

    threads = [threading.Thread(target=request) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(computed) == 1
