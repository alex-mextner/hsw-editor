"""ModelManager: lazy load, VRAM budget, LRU eviction, idle unload, GPU->CPU fallback, offline-first errors."""

from __future__ import annotations

import pytest

from hsw_vision.errors import InsufficientVram, MissingDependency, ModelsMissing
from hsw_vision.manager import EngineSpec, is_oom
from helpers import FakeEngine, Gpu, make_manager


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_nothing_is_loaded_until_requested() -> None:
    log: list[str] = []
    manager = make_manager(Gpu(8000), log)
    assert log == []
    assert manager.status()["engines"]["a"]["loaded"] is False
    engine = manager.get("a")
    assert engine.loaded and engine.device == "cuda"
    assert log == ["load a cuda"]
    assert manager.get("a") is engine  # resident: no second load
    assert log == ["load a cuda"]


def test_lru_evicted_when_budget_exceeded() -> None:
    log: list[str] = []
    clock = Clock()
    manager = make_manager(Gpu(8000), log, budget=2000, clock=clock)
    manager.get("a")
    clock.now = 1
    manager.get("b")
    clock.now = 2
    manager.get("a")  # a is now more recent than b
    clock.now = 3
    manager.get("c")  # 3 x 1000 > 2000: evict the LRU = b
    assert "unload b" in log and "unload a" not in log
    assert set(n for n, e in manager.status()["engines"].items() if e["loaded"]) == {"a", "c"}
    assert manager.resident_gpu_mb() == 2000


def test_eviction_when_card_is_nearly_full_for_other_processes() -> None:
    log: list[str] = []
    gpu = Gpu(1600)  # other processes hold the rest; 1600 free
    manager = make_manager(gpu, log, headroom=400)
    manager.get("a")  # needs 1000 + 400 headroom: ok (1600 free), now 600 free
    manager.get("b")  # 600 free < 1400: evict a, then 1600 free again
    assert "unload a" in log
    assert manager.status()["engines"]["b"]["device"] == "cuda"


def test_falls_back_to_cpu_when_nothing_can_be_evicted() -> None:
    log: list[str] = []
    manager = make_manager(Gpu(300), log)  # even an empty service cannot fit 1000 MB
    engine = manager.get("a")
    assert engine.device == "cpu"
    assert any("using cpu" in e for e in manager.status()["events"])


def test_device_cuda_is_strict_and_reports_insufficient_vram() -> None:
    manager = make_manager(Gpu(300), [], device="cuda")
    with pytest.raises(InsufficientVram) as info:
        manager.get("a")
    assert info.value.code == "insufficient_vram"


def test_device_cuda_without_gpu_is_a_missing_dependency() -> None:
    manager = make_manager(Gpu(None), [], device="cuda")
    with pytest.raises(MissingDependency):
        manager.get("a")


def test_no_gpu_runs_on_cpu_and_cpu_device_never_asks_the_gpu() -> None:
    assert make_manager(Gpu(None), []).get("a").device == "cpu"
    asked: list[int] = []

    def spy() -> int | None:
        asked.append(1)
        return 8000

    manager = make_manager(Gpu(8000), [], device="cpu")
    manager.free_vram_fn = spy
    assert manager.get("a").device == "cpu"
    assert asked == []


def test_oom_while_loading_falls_back_to_cpu() -> None:
    log: list[str] = []
    oom = RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")
    manager = make_manager(Gpu(8000), log, fail={"a": oom})
    engine = manager.get("a")
    assert engine.device == "cpu" and engine.loaded
    assert log[:3] == ["load a cuda", "unload a", "load a cpu"]
    assert manager.status()["engines"]["a"]["forced_cpu"] is True


def test_oom_during_inference_reloads_on_cpu_and_retries_once() -> None:
    manager = make_manager(Gpu(8000), [])
    attempts: list[str] = []

    def work(engine) -> str:  # type: ignore[no-untyped-def]
        attempts.append(engine.device)
        if engine.device == "cuda":
            raise RuntimeError("CUDA error: out of memory")
        return "done"

    assert manager.call("a", work) == "done"
    assert attempts == ["cuda", "cpu"]


def test_non_oom_errors_are_not_retried() -> None:
    manager = make_manager(Gpu(8000), [])
    attempts: list[str] = []

    def work(engine) -> None:  # type: ignore[no-untyped-def]
        attempts.append(engine.device)
        raise ValueError("bad mask")

    with pytest.raises(ValueError):
        manager.call("a", work)
    assert attempts == ["cuda"]


def test_idle_engines_unload_after_the_timeout() -> None:
    log: list[str] = []
    clock = Clock()
    manager = make_manager(Gpu(8000), log, clock=clock)
    manager.idle_unload_s = 60
    manager.get("a")
    clock.now = 30
    manager.get("b")
    clock.now = 80  # a idle 80 s, b idle 50 s
    assert manager.unload_idle() == ["a"]
    assert manager.status()["engines"]["b"]["loaded"] is True
    clock.now = 200
    assert manager.unload_idle() == ["b"]
    assert manager.resident_gpu_mb() == 0


def test_shared_dependency_is_loaded_once_and_unloaded_with_its_dependents() -> None:
    log: list[str] = []
    manager = make_manager(
        Gpu(8000), log, engines={"clip": 500, "rec": 100, "seg": 1000}, requires={"rec": ("clip",), "seg": ("clip",)}
    )
    manager.get("rec")
    manager.get("seg")
    assert log.count("load clip cuda") == 1
    manager.unload("clip")  # dependents go first
    assert log.index("unload rec") < log.index("unload clip")
    assert log.index("unload seg") < log.index("unload clip")
    assert manager.resident_gpu_mb() == 0


def test_pinned_dependency_is_not_evicted_to_make_room_for_its_dependent() -> None:
    log: list[str] = []
    manager = make_manager(
        Gpu(8000), log, budget=1600, engines={"clip": 500, "seg": 1000}, requires={"seg": ("clip",)}
    )
    manager.get("seg")  # clip 500 + seg 1000 = 1500 <= 1600
    assert "unload clip" not in log
    assert manager.status()["engines"]["seg"]["device"] == "cuda"


def test_missing_model_is_a_structured_error_naming_the_fetch_command() -> None:
    class MissingDependencyError(Exception):  # same class name as threed_vision.errors.MissingDependency
        pass

    MissingDependencyError.__name__ = "MissingDependency"
    error = MissingDependencyError("model sam2-tiny is missing: run `3d models pull sam2-tiny`")
    manager = make_manager(Gpu(8000), [], fail={"a": error})
    with pytest.raises(ModelsMissing) as info:
        manager.get("a")
    assert info.value.code == "models_missing"
    assert info.value.fix == "hsw-editor vision fetch-models"
    assert info.value.details["missing"] == ["sam2-tiny"]
    assert info.value.http_status == 424


def test_import_error_becomes_a_missing_dependency_with_the_extra_to_install() -> None:
    manager = make_manager(Gpu(8000), [], fail={"a": ImportError("No module named 'torch'")})
    with pytest.raises(MissingDependency) as info:
        manager.get("a")
    assert "vision setup" in (info.value.fix or "")


def test_unknown_engine_is_an_error() -> None:
    with pytest.raises(Exception, match="unknown engine"):
        make_manager(Gpu(8000), []).get("nope")


def test_is_oom_recognises_torch_and_ort_messages() -> None:
    assert is_oom(RuntimeError("CUDA out of memory"))
    assert is_oom(RuntimeError("CUBLAS_STATUS_ALLOC_FAILED"))
    assert not is_oom(ValueError("shape mismatch"))


def test_segmenter_with_its_shared_clip_and_owl_fits_the_default_budget_on_the_gpu() -> None:
    """Regression: the library class reports 2000 MB (CLIP/OWLv2 included); counting that on top of the shared
    CLIP + OWLv2 engines pushed SAM2 onto the CPU (145 s instead of ~5 s). The spec's own share is what counts."""
    log: list[str] = []
    manager = make_manager(Gpu(4600), log, budget=3000, engines={"clip": 500, "owl": 700}, requires={})
    manager.specs["seg"] = EngineSpec("seg", lambda device: FakeEngine("seg", device, 2000, log), 1300, requires=("clip", "owl"))
    assert manager.get("seg").device == "cuda"
    assert manager.resident_gpu_mb() == 2500
    assert all(e["device"] == "cuda" for e in manager.status()["engines"].values() if e["loaded"])


def test_using_an_engine_keeps_its_shared_dependencies_fresh() -> None:
    """Review finding: only the asked-for engine was touched, so CLIP looked idle and the reaper unloaded the
    segmenter and recogniser built on it every `idle_unload_s` even under constant use."""
    clock = Clock()
    manager = make_manager(Gpu(8000), [], clock=clock, engines={"clip": 500, "seg": 1000}, requires={"seg": ("clip",)})
    manager.idle_unload_s = 300
    manager.get("seg")
    clock.now = 250
    manager.get("seg")  # constant use
    clock.now = 400  # clip was loaded 400 s ago but its dependent was used 150 s ago
    assert manager.unload_idle() == []
    clock.now = 700
    assert sorted(manager.unload_idle()) == ["clip", "seg"]


def test_an_engine_running_inference_is_never_idle_unloaded_or_evicted() -> None:
    log: list[str] = []
    clock = Clock()
    manager = make_manager(Gpu(8000), log, budget=1500, clock=clock)
    manager.idle_unload_s = 10

    def long_inference(engine) -> str:  # type: ignore[no-untyped-def]
        clock.now = 1000  # the inference outlasts the idle timeout
        assert manager.unload_idle() == []  # reaper tick during the run
        manager.get("b")  # budget pressure: "a" is busy, so "b" cannot evict it and falls back to the CPU
        assert engine.loaded
        return "done"

    assert manager.call("a", long_inference) == "done"
    assert "unload a" not in log
    assert manager.status()["engines"]["b"]["device"] == "cpu"
    assert manager.status()["engines"]["a"]["busy"] is False  # released afterwards


def test_status_and_the_reaper_do_not_wait_for_a_model_load() -> None:
    import threading

    manager = make_manager(Gpu(8000), [])
    manager.get("a")
    held = threading.Event()
    release = threading.Event()

    def loader() -> None:
        with manager._lock:  # a cold start holding the manager lock for the length of a model load
            held.set()
            release.wait(5)

    thread = threading.Thread(target=loader)
    thread.start()
    assert held.wait(5)
    try:
        assert manager.status()["engines"]["a"]["loaded"] is True  # lock-free
        assert manager.unload_idle() == []  # the reaper skips this tick instead of blocking
    finally:
        release.set()
        thread.join()


def test_registering_specs_is_idempotent() -> None:
    manager = make_manager(Gpu(8000), [])
    spec = manager.specs["a"]
    manager.register(spec)
    manager.register(EngineSpec("a", lambda device: FakeEngine("a", device, 1, []), 1))
    assert manager.specs["a"] is spec


def test_oom_during_inference_moves_the_shared_dependencies_to_the_cpu_too() -> None:
    """Review finding: after a GPU OOM the shared CLIP/OWL stayed on CUDA, so the CPU retry ran against a CUDA CLIP
    and the card that had just run out of memory was not freed."""
    log: list[str] = []
    gpu = Gpu(8000)
    manager = make_manager(gpu, log, engines={"clip": 500, "seg": 1000}, requires={"seg": ("clip",)})
    seen: list[tuple[str, str]] = []

    def work(engine) -> str:  # type: ignore[no-untyped-def]
        seen.append((engine.device, manager.status()["engines"]["clip"]["device"]))
        if engine.device == "cuda":
            raise RuntimeError("CUDA out of memory")
        return "done"

    assert manager.call("seg", work) == "done"
    assert seen == [("cuda", "cuda"), ("cpu", "cpu")]
    assert manager.resident_gpu_mb() == 0 and gpu.free_mb == 8000  # nothing left on the card


def test_the_cpu_retry_translates_library_errors_like_the_first_attempt() -> None:
    """Review finding: errors of the CPU retry escaped as raw library exceptions (HTTP 500 instead of 422)."""

    class BadInput(Exception):  # the library's class is matched by name
        pass

    manager = make_manager(Gpu(8000), [])

    def work(engine) -> None:  # type: ignore[no-untyped-def]
        if engine.device == "cuda":
            raise RuntimeError("CUDA out of memory")
        raise BadInput("mask is empty")

    with pytest.raises(Exception, match="mask is empty") as info:
        manager.call("a", work)
    assert type(info.value).__name__ == "BadRequest"


def test_an_engine_placed_on_the_cpu_is_not_handed_a_cuda_dependency() -> None:
    """Review finding: a CPU segmenter was given the resident CUDA CLIP/OWL."""
    log: list[str] = []
    manager = make_manager(
        Gpu(8000), log, budget=1200, engines={"clip": 500, "seg": 1000}, requires={"seg": ("clip",)}
    )
    manager.get("clip")  # resident on cuda (500 of the 1200 budget)
    assert manager.get("seg").device == "cpu"  # 500 + 1000 > 1200 and nothing else can be evicted
    status = manager.status()["engines"]
    assert status["clip"]["device"] == "cpu" and status["seg"]["device"] == "cpu"
    assert log.count("load clip cuda") == 1 and log.count("load clip cpu") == 1


def test_a_dependency_in_use_elsewhere_stays_where_it_is() -> None:
    manager = make_manager(
        Gpu(8000), [], budget=1200, engines={"clip": 500, "seg": 1000}, requires={"seg": ("clip",)}
    )
    manager.get("clip")
    manager._busy["clip"] = 1  # another call is running on it
    assert manager.get("seg").device == "cpu"
    assert manager.status()["engines"]["clip"]["device"] == "cuda"


def test_an_engine_is_not_placed_on_cuda_while_a_dependency_sits_on_the_cpu() -> None:
    """Review finding: a CPU-pinned CLIP was handed to a later CUDA recogniser."""
    log: list[str] = []
    manager = make_manager(Gpu(8000), log, engines={"clip": 500, "rec": 100}, requires={"rec": ("clip",)})
    manager._forced_cpu.add("clip")
    assert manager.get("rec").device == "cpu"
    assert manager.status()["engines"]["clip"]["device"] == "cpu"


def test_a_cpu_only_engine_never_evicts_a_gpu_engine_to_make_room() -> None:
    log: list[str] = []
    gpu = Gpu(8000)
    manager = make_manager(gpu, log, budget=2000, engines={"a": 1000})
    assert manager.get("a").device == "cuda"
    gpu.free_mb = 100  # below the headroom: an ordinary engine would evict "a" before loading, even at 0 MB
    manager.register(EngineSpec("ordinary", lambda device: FakeEngine("ordinary", device, 0, log), 0))
    manager.register(EngineSpec("small", lambda device: FakeEngine("small", device, 0, log), 0, cpu_only=True))
    assert manager.get("small").device == "cpu" and "unload a" not in log
    manager.get("ordinary")
    assert "unload a" in log  # the control: without `cpu_only` the same card state does evict
