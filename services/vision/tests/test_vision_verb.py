"""`hsw-editor vision setup`: light locked deps + heavy pins, idempotent, with the repo's heavy-run wrapper."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

VERB_PATH = Path(__file__).resolve().parents[3] / "cli" / "vision_verb.py"


@pytest.fixture
def verb(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("vision_verb_under_test", VERB_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", str(tmp_path / "venv"))
    monkeypatch.delenv("HSW_VISION_NO_WRAP", raising=False)
    return module


def test_dry_run_prints_the_light_sync_then_the_wrapped_heavy_install(verb: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    assert verb.run(["setup", "--dry-run"]) == 0
    lines = capsys.readouterr().out.splitlines()
    sync, install = lines[1], lines[2]
    assert "uv sync --frozen --inexact --no-dev" in sync  # --inexact: a re-sync never removes the heavy stack
    assert "uv pip install" in install and "download.pytorch.org/whl/cu128" in install
    for pin in ("torch==2.11.0", "torchvision==0.26.0", "onnxruntime-gpu==1.23.2", "sam2>=1.1", "cma>=3.3", "trimesh>=4.0"):
        assert pin in install
    assert "unsafe-best-match" in install and "pypi.org/simple" in install


def test_cpu_backend_swaps_the_wheel_index_and_onnxruntime(verb: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    verb.run(["setup", "--dry-run", "--cpu"])
    install = capsys.readouterr().out.splitlines()[2]
    assert "whl/cpu" in install and "onnxruntime-gpu" not in install and "onnxruntime>=1.17,<1.24" in install.replace("'", "")


def test_requirements_already_satisfied_are_not_reinstalled(verb: ModuleType) -> None:
    installed = {
        "torch": "2.11.0+cu128", "torchvision": "0.26.0+cu128", "onnxruntime-gpu": "1.23.2", "sam2": "1.1.0",
        "transformers": "5.20.2", "tokenizers": "0.23.3", "cma": "4.5.0", "trimesh": "5.1.1",
    }  # fmt: skip
    assert verb.unsatisfied(verb.heavy_requirements("cu128"), installed) == []
    assert verb.unsatisfied(verb.heavy_requirements("cu128"), {**installed, "torch": "2.12.0"}) == ["torch==2.11.0"]
    assert verb.unsatisfied(verb.heavy_requirements("cu128"), {**installed, "cma": None}) == ["cma>=3.3"]


def test_cpu_onnxruntime_must_stay_below_the_cuda_13_build(verb: ModuleType) -> None:
    installed = {"torch": "2.11.0", "torchvision": "0.26.0", "sam2": "1.1", "transformers": "4.45", "tokenizers": "0.15", "cma": "3.3", "trimesh": "4.0", "onnxruntime": "1.25.0"}
    assert verb.unsatisfied(verb.heavy_requirements("cpu"), installed) == ["onnxruntime>=1.17,<1.24"]


def test_a_missing_venv_means_everything_is_missing(verb: ModuleType) -> None:
    assert verb.missing_heavy("cu128") == verb.heavy_requirements("cu128")


def test_the_verb_table_lists_setup_and_photo_to_objects(verb: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    assert "setup" in verb.VERBS and "photo-to-objects" in verb.VERBS
    assert verb.run([]) == 2 and "setup" in capsys.readouterr().out
