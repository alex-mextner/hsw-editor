"""`hsw-editor vision`: setup (light locked deps + heavy pins, idempotent, wrapped), argv mapping, status/probe parsing."""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

VERB_PATH = Path(__file__).resolve().parents[3] / "cli" / "vision_verb.py"
GPU_INSTALLED = {
    "torch": "2.11.0+cu128", "torchvision": "0.26.0+cu128", "onnxruntime-gpu": "1.23.2", "sam2": "1.1.0",
    "transformers": "5.20.2", "tokenizers": "0.23.3", "cma": "4.5.0", "trimesh": "5.1.1",
}  # fmt: skip


@pytest.fixture
def verb(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("vision_verb_under_test", VERB_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    monkeypatch.setenv("UV_PROJECT_ENVIRONMENT", str(tmp_path / "venv"))
    monkeypatch.setenv("HSW_VISION_STATE", str(tmp_path / "state.json"))
    monkeypatch.delenv("HSW_VISION_NO_WRAP", raising=False)
    monkeypatch.delenv("HSW_VISION_URL", raising=False)
    monkeypatch.setattr(module, "find_uv", lambda: "/usr/bin/uv")  # the dry-run tests must not need a real uv
    monkeypatch.setattr(module.shutil, "which", lambda name: f"/usr/bin/{name}")  # so the heavy wrapper is always on
    return module


# ---- setup -------------------------------------------------------------------------------------------


def test_dry_run_prints_the_light_sync_then_the_wrapped_heavy_install(verb: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    assert verb.run(["setup", "--dry-run"]) == 0
    lines = capsys.readouterr().out.splitlines()
    sync, uninstall, install = lines[1], lines[2], lines[3]
    assert "uv sync --frozen --inexact --no-dev" in sync  # --inexact: a re-sync never removes the heavy stack
    assert "uv pip uninstall" in uninstall and uninstall.endswith("onnxruntime")  # the CPU ORT shares the import package
    assert install.startswith("flock /tmp/3d-cli-heavy.lock systemd-run --user --scope")  # AGENTS.md heavy-run wrapper
    assert "uv pip install" in install and "download.pytorch.org/whl/cu128" in install and "--reinstall" not in install
    for pin in ("torch==2.11.0+cu128", "torchvision==0.26.0+cu128", "onnxruntime-gpu==1.23.2", "sam2>=1.1", "cma>=3.3", "trimesh>=4.0"):
        assert pin in install
    assert "unsafe-best-match" in install and "pypi.org/simple" in install


def test_cpu_backend_swaps_the_wheel_index_the_torch_build_and_onnxruntime(verb: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    verb.run(["setup", "--dry-run", "--cpu"])
    lines = capsys.readouterr().out.splitlines()
    assert lines[2].endswith("onnxruntime-gpu")
    install = lines[3]
    assert "whl/cpu" in install and "torch==2.11.0+cpu" in install and "onnxruntime-gpu" not in install
    assert "'onnxruntime>=1.17,<1.24'" in install


def test_force_really_reinstalls(verb: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    """Review finding: `--force` ran the same `uv pip install`, which skips satisfied pins."""
    verb.run(["setup", "--dry-run", "--force"])
    assert "--reinstall" in capsys.readouterr().out.splitlines()[3]


def test_satisfied_pins_are_not_reinstalled_and_the_build_tag_counts(verb: ModuleType) -> None:
    gpu = verb.heavy_requirements("cu128")
    assert verb.unsatisfied(gpu, GPU_INSTALLED) == []
    assert verb.unsatisfied(gpu, {**GPU_INSTALLED, "torch": "2.12.0+cu128"}) == ["torch==2.11.0+cu128"]
    assert verb.unsatisfied(gpu, {**GPU_INSTALLED, "cma": None}) == ["cma>=3.3"]
    # switching backend: a CPU torch does not satisfy the GPU pin (and the reverse)
    assert verb.unsatisfied(gpu, {**GPU_INSTALLED, "torch": "2.11.0+cpu", "torchvision": "0.26.0+cpu"}) == [
        "torch==2.11.0+cu128", "torchvision==0.26.0+cu128",
    ]  # fmt: skip
    cpu = verb.heavy_requirements("cpu")
    on_cpu = {**GPU_INSTALLED, "torch": "2.11.0+cpu", "torchvision": "0.26.0+cpu", "onnxruntime": "1.23.2"}
    assert verb.unsatisfied(cpu, on_cpu) == []
    assert verb.unsatisfied(cpu, {**on_cpu, "torch": "2.11.0+cu128"}) == ["torch==2.11.0+cpu"]


def test_prereleases_and_the_cuda_13_onnxruntime_are_not_accepted(verb: ModuleType) -> None:
    assert verb.unsatisfied(["transformers>=4.45"], {"transformers": "4.45.0rc1"}) == ["transformers>=4.45"]
    assert verb.unsatisfied(["transformers>=4.45"], {"transformers": "4.45.1"}) == []
    assert verb.unsatisfied(["transformers>=4.45"], {"transformers": "5.20.2"}) == []
    cpu = verb.heavy_requirements("cpu")
    installed = {**GPU_INSTALLED, "torch": "2.11.0+cpu", "torchvision": "0.26.0+cpu", "onnxruntime": "1.25.0"}
    assert verb.unsatisfied(cpu, installed) == ["onnxruntime>=1.17,<1.24"]


def test_a_missing_venv_means_everything_is_missing(verb: ModuleType) -> None:
    assert verb.missing_heavy("cu128") == verb.heavy_requirements("cu128")


def test_the_other_backends_onnxruntime_is_reported_for_removal(verb: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verb, "installed_versions", lambda names: {**GPU_INSTALLED, "onnxruntime": "1.23.2"})
    assert verb.missing_heavy("cu128") == ["uninstall onnxruntime"]


def test_a_failed_heavy_install_is_exit_1_and_resumable(verb: ModuleType, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    calls: list[list[str]] = []

    def call(command: list[str], **_: Any) -> int:
        calls.append(command)
        return 1 if "pip" in command and "install" in command else 0

    monkeypatch.setattr(verb.subprocess, "call", call)
    monkeypatch.setattr(verb, "missing_heavy", lambda backend: ["torch==2.11.0+cu128"])
    assert verb.run(["setup"]) == verb.EXIT_FAILED
    assert "re-run" in capsys.readouterr().out and len(calls) == 2


def test_a_satisfied_venv_skips_the_heavy_install(verb: ModuleType, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(verb.subprocess, "call", lambda command, **_: calls.append(command) or 0)
    monkeypatch.setattr(verb, "missing_heavy", lambda backend: [])
    assert verb.run(["setup"]) == 0
    assert len(calls) == 1 and "already installed" in capsys.readouterr().out  # only the light sync


# ---- argv mapping ------------------------------------------------------------------------------------


def test_verbs_map_to_the_sidecar_cli_and_the_torch_ones_are_wrapped(verb: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / "venv" / "bin").mkdir(parents=True)
    (tmp_path / "venv" / "bin" / "python").write_text("")
    seen: list[list[str]] = []
    monkeypatch.setattr(verb.subprocess, "call", lambda command, **_: seen.append(command) or 0)
    for args in (["photo-to-objects", "a.jpg", "--out", "o"], ["fetch-models", "sam2-tiny"], ["embed", "a.jpg", "--out", "e"], ["doctor"], ["serve"]):
        assert verb.run(args) == 0
    tails = [command[command.index("hsw_vision") + 1 :] for command in seen]
    assert tails == [["photo-to-objects", "a.jpg", "--out", "o"], ["models", "fetch", "sam2-tiny"], ["embed", "a.jpg", "--out", "e"], ["doctor"], ["serve"]]
    wrapped = [command[0] == "flock" for command in seen]
    assert wrapped == [True, True, True, False, False]  # the idle daemon and the cheap doctor must not hold the heavy lock


def test_help_of_a_heavy_verb_does_not_take_the_heavy_lock(verb: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """`vision photo-to-wall --help` hung while another heavy job held /tmp/3d-cli-heavy.lock."""
    (tmp_path / "venv" / "bin").mkdir(parents=True)
    (tmp_path / "venv" / "bin" / "python").write_text("")
    seen: list[list[str]] = []
    monkeypatch.setattr(verb.subprocess, "call", lambda command, **_: seen.append(command) or 0)
    for args in (["photo-to-wall", "--help"], ["photo-to-objects", "-h"], ["embed", "--help"], ["fetch-models", "--help"]):
        assert verb.run(args) == 0
    assert all(command[0] != "flock" for command in seen)
    assert [command[command.index("hsw_vision") + 1] for command in seen] == ["photo-to-wall", "photo-to-objects", "embed", "models"]


def test_no_wrap_switch_and_usage(verb: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "venv" / "bin").mkdir(parents=True)
    (tmp_path / "venv" / "bin" / "python").write_text("")
    seen: list[list[str]] = []
    monkeypatch.setattr(verb.subprocess, "call", lambda command, **_: seen.append(command) or 0)
    monkeypatch.setenv("HSW_VISION_NO_WRAP", "1")
    verb.run(["photo-to-wall", "a.jpg", "--out", "o"])
    assert seen[0][0] != "flock"
    assert verb.run([]) == verb.EXIT_USAGE and verb.run(["--help"]) == 0
    assert "setup" in capsys.readouterr().out
    assert "embed" in verb.VERBS and "photo-to-objects" in verb.VERBS


def test_a_missing_venv_names_the_setup_command(verb: ModuleType, capsys: pytest.CaptureFixture[str]) -> None:
    assert verb.run(["photo-to-wall", "a.jpg", "--out", "o"]) == verb.EXIT_MISSING
    assert "hsw-editor vision setup" in capsys.readouterr().out


# ---- endpoint / probe / status -------------------------------------------------------------------------


def write_state(verb: ModuleType, state: Any) -> None:
    verb.state_file().write_text(state if isinstance(state, str) else json.dumps(state))


def test_endpoint_prefers_the_env_url_then_a_live_state_file_then_the_default_port(verb: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    assert verb.endpoint() == {"url": "http://127.0.0.1:8795", "source": "default port"}
    write_state(verb, {"pid": os.getpid(), "url": "http://127.0.0.1:9000"})
    assert verb.endpoint()["url"] == "http://127.0.0.1:9000"
    monkeypatch.setenv("HSW_VISION_URL", "http://127.0.0.1:9100/")
    assert verb.endpoint() == {"url": "http://127.0.0.1:9100", "source": "HSW_VISION_URL"}


@pytest.mark.parametrize("state", ["[]", '{"pid": null}', "not json", '{"url": "x"}', '"text"', '{"pid": "abc"}'])
def test_a_malformed_state_file_never_crashes_the_probe(verb: ModuleType, state: str) -> None:
    """Review finding: a JSON array or a null pid raised TypeError out of `vision status`."""
    write_state(verb, state)
    assert verb.endpoint() == {"url": "http://127.0.0.1:8795", "source": "default port"}


def test_a_dead_pid_or_a_missing_socket_is_not_a_running_sidecar(verb: ModuleType, tmp_path: Path) -> None:
    """Review finding: after a SIGKILL the state file stays; a reused pid made `status` claim a socket nobody owns."""
    write_state(verb, {"pid": os.getpid(), "socket": str(tmp_path / "gone.sock")})
    assert verb.endpoint()["source"] == "default port"
    (tmp_path / "live.sock").write_text("")
    write_state(verb, {"pid": os.getpid(), "socket": str(tmp_path / "live.sock")})
    assert verb.endpoint() == {"socket": str(tmp_path / "live.sock"), "pid": os.getpid(), "source": str(verb.state_file())}
    write_state(verb, {"pid": 2**22 + 12345, "url": "http://127.0.0.1:9000"})
    assert verb.endpoint()["source"] == "default port"


def test_probe_and_status_report_installed_running_and_models(
    verb: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert verb.status(as_json=False) == verb.EXIT_NOT_READY and "hsw-editor vision setup" in capsys.readouterr().out
    (tmp_path / "venv" / "bin").mkdir(parents=True)
    (tmp_path / "venv" / "bin" / "python").write_text("")
    monkeypatch.setattr(verb, "_get_json", lambda url, timeout=2.0: None)
    assert verb.status(as_json=False) == verb.EXIT_NOT_READY and "installed, not running" in capsys.readouterr().out
    answers = {
        "/health": {"ok": True, "name": "hsw-vision", "version": "0.1.0"},
        "/models/status": {"models": {"models": {"sam2-tiny": {"installed": True}, "owlv2-base": {"installed": False}}}, "manager": {"engines": {"clip": {"loaded": True}}, "free_vram_mb": 3000, "vram_budget_mb": 3000}},
    }
    monkeypatch.setattr(verb, "_get_json", lambda url, timeout=2.0: answers.get(url.removeprefix("http://127.0.0.1:8795")))
    assert verb.status(as_json=False) == 0
    out = capsys.readouterr().out
    assert "running at http://127.0.0.1:8795" in out and "models missing: owlv2-base" in out and "resident engines: clip" in out
    assert verb.status(as_json=True) == 0 and json.loads(capsys.readouterr().out)["running"] is True


def test_removing_the_other_onnxruntime_is_followed_by_a_reinstall_of_the_chosen_one(verb: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    """Review finding: uninstalling one onnxruntime deletes the files both wheels share; the pin then looked satisfied."""
    calls: list[list[str]] = []
    monkeypatch.setattr(verb.subprocess, "call", lambda command, **_: calls.append(command) or 0)
    monkeypatch.setattr(verb, "missing_heavy", lambda backend: ["uninstall onnxruntime"])
    assert verb.run(["setup"]) == 0
    assert [c for c in calls if "uninstall" in c], "the other backend is uninstalled"
    install = calls[-1]
    assert "--reinstall-package" in install and install[install.index("--reinstall-package") + 1] == "onnxruntime-gpu"


def test_a_failed_uninstall_stops_setup(verb: ModuleType, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verb.subprocess, "call", lambda command, **_: 1 if "uninstall" in command else 0)
    monkeypatch.setattr(verb, "missing_heavy", lambda backend: ["uninstall onnxruntime"])
    assert verb.run(["setup"]) == verb.EXIT_FAILED
