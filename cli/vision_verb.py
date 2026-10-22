"""`hsw-editor vision ...`: setup, status, fetch-models, doctor, photo-to-wall, photo-to-objects (and the sidecar `serve`).

Kept separate from hsw_editor.py so the verb table only needs additive lines: register `vision` ->
`vision_verb.run`/`vision_verb.configure`, and `check_vision` in hswlib/doctor.py -> `vision_verb.probe`.

Everything heavy runs in the vision venv (`UV_PROJECT_ENVIRONMENT`, default `~/.cache/hsw-editor/vision-venv`) through
`uv run --no-sync` (never an implicit install). `setup` is the ONLY command that installs packages (light locked deps via
`uv sync`, then the heavy torch/ORT stack via `uv pip install`) and `fetch-models` the ONLY one that downloads model files;
both run inside the repo's heavy-run wrapper (flock + systemd-run scope + nice) unless `HSW_VISION_NO_WRAP=1`.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
PROJECT = REPO_ROOT / "services" / "vision"
VERBS = ("setup", "status", "fetch-models", "doctor", "photo-to-wall", "photo-to-objects", "serve")
DEFAULT_PORT = 8795
HEAVY_LOCK = "/tmp/3d-cli-heavy.lock"  # noqa: S108 - the workstation-wide lock path from AGENTS.md
EXIT_USAGE = 2
EXIT_MISSING = 127
EXIT_FAILED = 1
PYPI = "https://pypi.org/simple"
TORCH_INDEX = {"cu128": "https://download.pytorch.org/whl/cu128", "cpu": "https://download.pytorch.org/whl/cpu"}
# The heavy runtime, NOT in uv.lock (a locked torch/CUDA extra is a 460 KB lockfile diff the review gate cannot stamp).
# `name` -> pip requirement; the same pins as the `gpu`/`seg`/`fit` extras of packages/threed-vision (3d-cli README).
# torch MUST be the cu128 build: its nvidia-*-cu12 wheels are what onnxruntime-gpu 1.23 loads (>= 1.24 is a CUDA-13
# build that silently runs on the CPU with this driver stack).
HEAVY_COMMON = {
    "torch": "torch==2.11.0",
    "torchvision": "torchvision==0.26.0",
    "sam2": "sam2>=1.1",
    "transformers": "transformers>=4.45",
    "tokenizers": "tokenizers>=0.15",
    "cma": "cma>=3.3",
    "trimesh": "trimesh>=4.0",
}
HEAVY_ORT = {"cu128": "onnxruntime-gpu==1.23.2", "cpu": "onnxruntime>=1.17,<1.24"}


def cache_home() -> Path:
    return Path(os.environ.get("HSW_EDITOR_CACHE", Path.home() / ".cache" / "hsw-editor"))


def venv_dir() -> Path:
    return Path(os.environ.get("UV_PROJECT_ENVIRONMENT", cache_home() / "vision-venv"))


def state_file() -> Path:
    return Path(os.environ.get("HSW_VISION_STATE", cache_home() / "vision" / "state.json"))


def configure(subs: Any) -> None:
    parser = subs.add_parser(
        "vision",
        help="photo -> wall/objects vision service: setup | status | fetch-models | doctor | photo-to-wall | photo-to-objects",
        description="Vision sidecar (services/vision). setup: create the vision venv (light lock + heavy torch/ORT stack). "
        "status: is it running, which models are on disk. fetch-models: explicit model download (heavy). "
        "doctor: models, GPU, onnxruntime CUDA. photo-to-wall IMAGE --out DIR / photo-to-objects IMAGE --out DIR: "
        "run the pipeline without the daemon.",
    )
    parser.add_argument("vision_args", nargs=argparse.REMAINDER, help="verb and its arguments (see docs/vision.md)")


def handle(args: argparse.Namespace) -> int:
    return run(list(getattr(args, "vision_args", [])))


def run(args: list[str]) -> int:
    if not args or args[0] not in VERBS:
        print(f"usage: hsw-editor vision {'|'.join(VERBS)} ...")
        return EXIT_USAGE
    verb, rest = args[0], args[1:]
    if verb == "status":
        return status("--json" in rest)
    if verb == "setup":
        return setup(rest)
    argv = {
        "fetch-models": ["models", "fetch", *rest],
        "doctor": ["doctor", *rest],
        "photo-to-wall": ["photo-to-wall", *rest],
        "photo-to-objects": ["photo-to-objects", *rest],
        "serve": ["serve", *rest],
    }[verb]
    return run_in_venv(argv, heavy=verb == "fetch-models")


# ---- setup: the only command that installs packages ------------------------------------------------------


def heavy_requirements(backend: str) -> list[str]:
    """Pins of the heavy runtime for `backend` ("cu128" = GPU build, "cpu")."""
    return [*HEAVY_COMMON.values(), HEAVY_ORT[backend]]


def uv_env() -> dict[str, str]:
    return {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv_dir())}


def setup_commands(uv: str, backend: str) -> list[list[str]]:
    """The two idempotent installs: light locked deps (`uv sync --frozen --inexact`: never removes the heavy stack),
    then the heavy pins from the torch index with PyPI as the fallback for everything else."""
    return [
        [uv, "sync", "--frozen", "--inexact", "--no-dev", "--project", str(PROJECT)],
        [
            uv, "pip", "install", "--python", str(venv_dir() / "bin" / "python"),
            "--index-url", TORCH_INDEX[backend], "--extra-index-url", PYPI, "--index-strategy", "unsafe-best-match",
            *heavy_requirements(backend),
        ],
    ]  # fmt: skip


def _requirement_parts(requirement: str) -> tuple[str, str, str, str]:
    """`"torch==2.11.0"` -> `("torch", "==", "2.11.0", "")`; `"onnxruntime>=1.17,<1.24"` -> `(..., ">=", "1.17", "1.24")`."""
    spec, _, upper = requirement.partition(",<")
    for operator in ("==", ">="):
        if operator in spec:
            name, wanted = spec.split(operator, 1)
            return name, operator, wanted, upper
    return requirement, "", "", ""


def _version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("+")[0].split(".") if part.isdigit())


def unsatisfied(requirements: list[str], installed: dict[str, str | None]) -> list[str]:
    """Requirements the `installed` versions (None = absent) do not meet. Local build tags (`2.11.0+cu128`) are ignored."""
    bad: list[str] = []
    for requirement in requirements:
        name, operator, wanted, upper = _requirement_parts(requirement)
        have = installed.get(name)
        if have is None:
            bad.append(requirement)
            continue
        key = _version_key(have)
        too_old = operator == ">=" and key < _version_key(wanted)
        too_new = bool(upper) and key >= _version_key(upper)
        if (operator == "==" and key != _version_key(wanted)) or too_old or too_new:
            bad.append(requirement)
    return bad


def missing_heavy(backend: str) -> list[str]:
    """Pins the venv does not satisfy yet (empty = nothing to install). Asks the venv's own interpreter."""
    requirements = heavy_requirements(backend)
    python = venv_dir() / "bin" / "python"
    if not python.exists():
        return requirements
    names = sorted({_requirement_parts(r)[0] for r in requirements})
    probe = (
        "import importlib.metadata as m, json, sys\n"
        "out = {}\n"
        "for n in sys.argv[1:]:\n"
        "    try:\n"
        "        out[n] = m.version(n)\n"
        "    except m.PackageNotFoundError:\n"
        "        out[n] = None\n"
        "print(json.dumps(out))\n"
    )
    try:
        out = subprocess.run([str(python), "-c", probe, *names], capture_output=True, text=True, timeout=60, check=True).stdout
        return unsatisfied(requirements, json.loads(out))
    except (OSError, subprocess.SubprocessError, ValueError):
        return requirements


def setup(args: list[str]) -> int:
    """`vision setup [--cpu] [--force] [--dry-run]`: create/refresh the vision venv. Safe to re-run: the light lock is
    re-synced (no-op when current) and the heavy install is skipped when every pin is already satisfied."""
    parser = argparse.ArgumentParser(prog="hsw-editor vision setup", description=setup.__doc__)
    parser.add_argument("--cpu", action="store_true", help="CPU torch + onnxruntime (no CUDA wheels, ~1 GB instead of ~8 GB)")
    parser.add_argument("--force", action="store_true", help="reinstall the heavy pins even when they are satisfied")
    parser.add_argument("--dry-run", action="store_true", help="print the commands and exit")
    opts = parser.parse_args(args)
    backend = "cpu" if opts.cpu else "cu128"
    uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
    if not Path(uv).exists():
        print("hsw-editor: uv not found (expected on PATH or ~/.local/bin/uv)")
        return EXIT_MISSING
    light, heavy = setup_commands(uv, backend)
    wrap = os.environ.get("HSW_VISION_NO_WRAP") != "1"
    if opts.dry_run:
        print(f"venv: {venv_dir()}  backend: {backend}")
        print(shlex.join(light))
        print(shlex.join(heavy_wrap(heavy) if wrap else heavy))
        return 0
    print(f"vision setup: venv {venv_dir()} ({backend})", flush=True)
    if subprocess.call(light, cwd=REPO_ROOT, env=uv_env()) != 0:
        print("hsw-editor: `uv sync` failed (see above)")
        return EXIT_FAILED
    missing = heavy_requirements(backend) if opts.force else missing_heavy(backend)
    if not missing:
        print("vision setup: heavy runtime already installed (use --force to reinstall)")
    else:
        print(f"vision setup: installing {len(missing)} heavy package(s): {', '.join(missing)}", flush=True)
        if subprocess.call(heavy_wrap(heavy) if wrap else heavy, cwd=REPO_ROOT, env=uv_env()) != 0:
            print("hsw-editor: heavy install failed (see above); re-run `hsw-editor vision setup` to resume")
            return EXIT_FAILED
    print("vision setup: done. next: hsw-editor vision fetch-models && hsw-editor vision doctor")
    return 0


# ---- running python in the vision venv -------------------------------------------------------------------


def venv_missing_message() -> str:
    return (
        f"the vision environment {venv_dir()} does not exist.\n"
        "fix: hsw-editor vision setup   (heavy: torch + CUDA wheels, several GB; see docs/vision.md)"
    )


def run_in_venv(argv: list[str], *, heavy: bool) -> int:
    uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
    if not Path(uv).exists():
        print("hsw-editor: uv not found (expected on PATH or ~/.local/bin/uv)")
        return EXIT_MISSING
    if not (venv_dir() / "bin" / "python").exists():
        print(f"hsw-editor: {venv_missing_message()}")
        return EXIT_MISSING
    command = [uv, "run", "--no-sync", "--project", str(PROJECT), "python", "-m", "hsw_vision", *argv]
    if heavy and os.environ.get("HSW_VISION_NO_WRAP") != "1":
        command = heavy_wrap(command)
    env = {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv_dir())}
    return subprocess.call(command, cwd=REPO_ROOT, env=env)


def heavy_wrap(command: list[str]) -> list[str]:
    """flock + systemd-run scope + nice: the repo's rule for model downloads and torch (AGENTS.md)."""
    wrapped = command
    if shutil.which("nice"):
        wrapped = ["nice", "-n", "10", *wrapped]
    if shutil.which("systemd-run"):
        wrapped = ["systemd-run", "--user", "--scope", "-q", "-p", "MemoryMax=6G", "-p", "MemorySwapMax=0", "-p", "CPUQuota=600%", *wrapped]
    if shutil.which("flock"):
        wrapped = ["flock", HEAVY_LOCK, *wrapped]
    return wrapped


# ---- status / doctor probe (stdlib only: works without the venv) ---------------------------------------


def _get_json(url: str, timeout: float = 2.0) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - loopback URL
            data = json.loads(resp.read())
            return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def endpoint() -> dict[str, Any] | None:
    """Where a running sidecar listens: `HSW_VISION_URL`, else the state file of `python -m hsw_vision serve`."""
    url = os.environ.get("HSW_VISION_URL")
    if url:
        return {"url": url.rstrip("/"), "source": "HSW_VISION_URL"}
    try:
        state = json.loads(state_file().read_text())
        os.kill(int(state["pid"]), 0)
    except (OSError, ValueError, KeyError):
        return None
    if state.get("url"):
        return {"url": state["url"], "pid": state["pid"], "source": str(state_file())}
    if state.get("socket"):
        return {"socket": state["socket"], "pid": state["pid"], "source": str(state_file())}
    return None


def probe() -> dict[str, Any]:
    """Facts for `hsw-editor doctor` and `vision status`: installed? running? models? Never starts anything."""
    info: dict[str, Any] = {
        "venv": str(venv_dir()),
        "installed": (venv_dir() / "bin" / "python").exists(),
        "running": False,
        "endpoint": None,
        "health": None,
        "models": None,
    }
    found = endpoint()
    if found is not None and "url" in found:
        info["endpoint"] = found["url"]
        info["health"] = _get_json(f"{found['url']}/health")
        info["running"] = info["health"] is not None
        if info["running"]:
            info["models"] = _get_json(f"{found['url']}/models/status", timeout=15.0)
    elif found is not None:
        info["endpoint"] = f"unix:{found['socket']}"
        info["running"] = True  # a live pid owns the socket; the Bun client talks to it (urllib cannot)
    return info


def status(as_json: bool) -> int:
    info = probe()
    if as_json:
        print(json.dumps(info, indent=2))
        return 0
    if not info["installed"]:
        print(f"vision: not installed ({info['venv']} missing)")
        print("  fix: hsw-editor vision setup")
        return 3
    if not info["running"]:
        print("vision: installed, not running (the daemon starts it on the first vision job and stops it when idle)")
        print("  models on disk: hsw-editor vision doctor")
        return 3
    health = info["health"] or {}
    print(f"vision: running at {info['endpoint']} ({health.get('name', '')} {health.get('version', '')})".strip())
    models = (info["models"] or {}).get("models") or {}
    if isinstance(models, dict) and "models" in models:
        names = models["models"]
        have = sorted(n for n, m in names.items() if m.get("installed"))
        missing = sorted(set(names) - set(have))
        print(f"  models present: {', '.join(have) or 'none'}")
        if missing:
            print(f"  models missing: {', '.join(missing)}  -> hsw-editor vision fetch-models")
    manager = (info["models"] or {}).get("manager") or {}
    if manager:
        loaded = [n for n, e in manager.get("engines", {}).items() if e.get("loaded")]
        print(f"  resident engines: {', '.join(loaded) or 'none'}; free VRAM {manager.get('free_vram_mb')} MB; budget {manager.get('vram_budget_mb')} MB")
    return 0
