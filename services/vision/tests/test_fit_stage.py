"""The fit stage runs as the ModelManager's `fit` engine: GPU budget accounting, CPU placement, OOM fallback."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

from helpers import Gpu, fake_calibration, make_manager
from hsw_vision.engines import FIT, FIT_CUDA, FitRunner
from hsw_vision.errors import InsufficientVram
from hsw_vision.geometry import camera_from_calibration
from hsw_vision.manager import EngineSpec
from hsw_vision.stages import fit as stage_fit

MASK = np.zeros((160, 240), bool)
MASK[20:50, 20:200] = True
CAMERA = camera_from_calibration(fake_calibration(1.0))


def fit_manager(gpu: Gpu, **kwargs: Any) -> Any:
    manager = make_manager(gpu, [], engines={"other": 2500}, **kwargs)
    manager.register(EngineSpec(FIT, FitRunner, FitRunner.vram_estimate_mb))
    manager.register(EngineSpec(FIT_CUDA, FitRunner, FitRunner.vram_estimate_mb, cpu_ok=False, strict_cuda=True))
    return manager


def install_library(monkeypatch: pytest.MonkeyPatch, fail_on: str | None = None) -> list[str]:
    devices: list[str] = []

    def fit_auto(views: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
        devices.append(kwargs["device"])
        if kwargs["device"] == fail_on:
            raise RuntimeError("CUDA out of memory")
        return {"dims_mm": {"length_mm": 1.0}, "confidence": {}, "views": []}

    monkeypatch.setattr(stage_fit, "_lib", lambda: SimpleNamespace(fit_auto=fit_auto))
    return devices


def test_fit_runs_on_the_gpu_when_the_budget_has_room_and_is_accounted(monkeypatch: pytest.MonkeyPatch) -> None:
    devices = install_library(monkeypatch)
    manager = fit_manager(Gpu(8000))
    stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="auto")
    assert devices == ["cuda"]
    assert manager.status()["engines"][FIT]["device"] == "cuda"
    assert manager.resident_gpu_mb() == FitRunner.vram_estimate_mb


def test_fit_evicts_the_least_recently_used_engine_to_stay_inside_the_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    """Review finding: `fit_mask` bypassed the manager, so its GPU context was never counted against the budget."""
    devices = install_library(monkeypatch)
    manager = fit_manager(Gpu(8000), budget=2600)
    manager.get("other")  # 2500 of 2600
    stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="auto")
    assert devices == ["cuda"]
    assert manager.status()["engines"]["other"]["loaded"] is False


def test_fit_goes_to_the_cpu_when_the_card_is_full(monkeypatch: pytest.MonkeyPatch) -> None:
    devices = install_library(monkeypatch)
    manager = fit_manager(Gpu(300))  # less free than the fit needs + headroom
    stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="auto")
    assert devices == ["cpu"]


def test_explicit_cpu_never_touches_the_gpu_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    devices = install_library(monkeypatch)
    manager = fit_manager(Gpu(8000))
    stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="cpu")
    assert devices == ["cpu"]
    assert manager.status()["engines"][FIT]["loaded"] is False


def test_an_out_of_memory_error_retries_on_the_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    devices = install_library(monkeypatch, fail_on="cuda")
    manager = fit_manager(Gpu(8000))
    result = stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="auto")
    assert devices == ["cuda", "cpu"] and result["dims_mm"]["length_mm"] == 1.0


def test_device_cuda_is_strict(monkeypatch: pytest.MonkeyPatch) -> None:
    install_library(monkeypatch)
    manager = fit_manager(Gpu(300))
    with pytest.raises(InsufficientVram):
        stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="cuda")


def test_explicit_cuda_overrides_a_service_pinned_to_the_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    """`device="cuda"` in the request used to reach `fit_auto` directly; the manager must not turn it into
    an `insufficient_vram` error because the service default is `cpu`."""
    devices = install_library(monkeypatch)
    manager = fit_manager(Gpu(8000), device="cpu")
    stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="cuda")
    assert devices == ["cuda"]
    assert manager.resident_gpu_mb() == FitRunner.vram_estimate_mb  # accounted against the budget like any GPU engine
    stage_fit.fit_mask(MASK, CAMERA, manager=manager, device="auto")
    assert devices == ["cuda", "cpu"]  # the service default still decides when the request does not say


def test_explicit_cuda_on_a_cpu_service_keeps_the_budget_and_never_falls_back_silently(monkeypatch: pytest.MonkeyPatch) -> None:
    install_library(monkeypatch)
    full = fit_manager(Gpu(300), device="cpu")  # less free than the fit needs + headroom
    with pytest.raises(InsufficientVram):
        stage_fit.fit_mask(MASK, CAMERA, manager=full, device="cuda")
    devices = install_library(monkeypatch, fail_on="cuda")
    out_of_memory = fit_manager(Gpu(8000), device="cpu")
    with pytest.raises(RuntimeError, match="out of memory"):
        stage_fit.fit_mask(MASK, CAMERA, manager=out_of_memory, device="cuda")
    assert devices == ["cuda"]  # no retry on the CPU: the caller asked for the GPU
