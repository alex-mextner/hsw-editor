"""Result cache: keyed by image sha256 + stage + params; idempotent; stale file references are misses."""

from __future__ import annotations

from pathlib import Path

from helpers import make_service
from hsw_vision.cache import ResultCache, file_sha256, params_hash
from hsw_vision.schemas import SegmentParams


def test_params_hash_is_order_independent_and_sensitive_to_values() -> None:
    assert params_hash({"a": 1, "b": [1, 2]}) == params_hash({"b": [1, 2], "a": 1})
    assert params_hash({"a": 1}) != params_hash({"a": 2})
    assert params_hash({"a": 1}, version="0.1") != params_hash({"a": 1}, version="0.2")


def test_get_or_compute_runs_once_per_image_and_params(tmp_path: Path) -> None:
    cache = ResultCache(tmp_path)
    calls = []

    def compute() -> dict[str, int]:
        calls.append(1)
        return {"value": 7}

    first, cached_first = cache.get_or_compute("a" * 64, "stage", {"k": 1}, compute)
    second, cached_second = cache.get_or_compute("a" * 64, "stage", {"k": 1}, compute)
    other_params, _ = cache.get_or_compute("a" * 64, "stage", {"k": 2}, compute)
    other_image, _ = cache.get_or_compute("b" * 64, "stage", {"k": 1}, compute)
    assert (first, cached_first, second, cached_second) == ({"value": 7}, False, {"value": 7}, True)
    assert len(calls) == 3
    assert (cache.hits, cache.misses) == (1, 3)
    assert other_params == other_image == {"value": 7}


def test_refresh_recomputes(tmp_path: Path) -> None:
    cache = ResultCache(tmp_path)
    n = []
    cache.get_or_compute("c" * 64, "s", {}, lambda: n.append(1) or {"n": len(n)})
    result, cached = cache.get_or_compute("c" * 64, "s", {}, lambda: n.append(1) or {"n": len(n)}, refresh=True)
    assert cached is False and result == {"n": 2}


def test_a_result_with_a_deleted_file_is_a_miss(tmp_path: Path) -> None:
    cache = ResultCache(tmp_path)
    sha = "d" * 64
    artefact = cache.image_dir(sha) / "masks" / "001.png"
    artefact.parent.mkdir(parents=True)
    artefact.write_bytes(b"png")
    cache.put(sha, "s", {}, {"_files": ["masks/001.png"]})
    assert cache.get(sha, "s", {}) is not None
    artefact.unlink()
    assert cache.get(sha, "s", {}) is None


def test_corrupt_cache_file_is_a_miss_not_a_crash(tmp_path: Path) -> None:
    cache = ResultCache(tmp_path)
    path = cache.put("e" * 64, "s", {}, {"ok": True})
    path.write_text("{not json")
    assert cache.get("e" * 64, "s", {}) is None


def test_service_stages_are_idempotent_and_results_live_under_the_work_dir(tmp_path: Path, photo: Path) -> None:
    from hsw_vision.schemas import ImageRef

    service, calls = make_service(tmp_path)
    work = tmp_path / "wall" / "vision"
    ref = ImageRef(image_path=photo, work_dir=work)
    img = service.open(ref)
    first = service.segment(img, SegmentParams())
    second = service.segment(service.open(ref), SegmentParams())
    assert calls.segment == 1
    assert (first["cached"], second["cached"]) == (False, True)
    assert second["instances"] == first["instances"]
    assert (img.dir / first["dir"] / "masks" / "001.png").is_file()
    assert str(img.dir).startswith(str(work))
    assert img.sha256 == file_sha256(photo)
    # a different segmentation parameter is a different cache entry
    service.segment(img, SegmentParams(points_per_side=16))
    assert calls.segment == 2


def test_the_key_lock_table_only_holds_keys_being_computed(tmp_path: Path) -> None:
    """The table of the long-lived sidecar grew by one lock per distinct (photo, stage, params) forever."""
    from hsw_vision import cache as cache_module

    cache = ResultCache(tmp_path)
    for index in range(20):
        cache.get_or_compute("a" * 64, "stage", {"k": index}, lambda: {"value": 1})
    assert cache_module._KEY_LOCKS == {}

    def failing() -> dict[str, int]:
        raise RuntimeError("boom")

    try:
        cache.get_or_compute("a" * 64, "stage", {"k": "fails"}, failing)
    except RuntimeError:
        pass
    assert cache_module._KEY_LOCKS == {}
