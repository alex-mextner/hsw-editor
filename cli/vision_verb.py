"""`hsw-editor vision ...`: setup, status, fetch-models, doctor, photo-to-wall, photo-to-objects (and the sidecar `serve`).

Kept separate from hsw_editor.py so the verb table only needs additive lines: register `vision` ->
`vision_verb.run`/`vision_verb.configure`, and `check_vision` in hswlib/doctor.py -> `vision_verb.probe`.

Everything runs in the vision venv (`UV_PROJECT_ENVIRONMENT`, default `~/.cache/hsw-editor/vision-venv`) through
`uv run --no-sync` (never an implicit install). `setup` is the ONLY command that installs packages (light locked deps via
`uv sync`, then the heavy torch/ORT stack via `uv pip install`) and `fetch-models` the ONLY one that downloads model files.
Per AGENTS.md every torch/download run (`setup`, `fetch-models`, `photo-to-wall`, `photo-to-objects`, `embed`) goes through
the heavy-run wrapper (flock + systemd-run scope + nice) unless `HSW_VISION_NO_WRAP=1`; the long-lived `serve` (the daemon
spawns it) and the cheap `doctor` are not wrapped: an idle sidecar must not hold the workstation-wide lock.
Exit code 3 (`EXIT_NOT_READY`) of `status` means "not installed / not running", unlike `hsw_vision`'s 3 = low confidence.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import urllib.request
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
PROJECT = REPO_ROOT / "services" / "vision"
VERBS = ("setup", "status", "fetch-models", "doctor", "photo-to-wall", "photo-to-objects", "objects", "embed", "serve")
#: Verbs that run torch or download models: they use the heavy-run wrapper.
HEAVY_VERBS = ("fetch-models", "photo-to-wall", "photo-to-objects", "objects", "embed")
DEFAULT_PORT = 8795  # `hsw_vision.config.DEFAULT_LOOPBACK_PORT`: where `hsw-editor doctor` looks when no state file exists
HEAVY_LOCK = "/tmp/3d-cli-heavy.lock"  # noqa: S108 - the workstation-wide lock path from AGENTS.md
EXIT_USAGE = 2
EXIT_MISSING = 127
EXIT_FAILED = 1
EXIT_NOT_READY = 3
PYPI = "https://pypi.org/simple"
TORCH_INDEX = {"cu128": "https://download.pytorch.org/whl/cu128", "cpu": "https://download.pytorch.org/whl/cpu"}
# The heavy runtime, NOT in uv.lock (a locked torch/CUDA extra is a 460 KB lockfile diff the review gate cannot stamp).
# `name` -> pip requirement; the same pins as the `gpu`/`seg`/`fit` extras of packages/threed-vision (3d-cli README).
# torch MUST be the cu128 build: its nvidia-*-cu12 wheels are what onnxruntime-gpu 1.23 loads (>= 1.24 is a CUDA-13
# build that silently runs on the CPU with this driver stack). The local build tag is part of the pin, so switching
# between `setup` and `setup --cpu` replaces torch instead of keeping the wrong build.
TORCH_BUILD = {"cu128": "+cu128", "cpu": "+cpu"}
HEAVY_COMMON = {
    "sam2": "sam2>=1.1",
    "transformers": "transformers>=4.45",
    "tokenizers": "tokenizers>=0.15",
    "cma": "cma>=3.3",
    "trimesh": "trimesh>=4.0",
}
HEAVY_ORT = {"cu128": "onnxruntime-gpu==1.23.2", "cpu": "onnxruntime>=1.17,<1.24"}
#: `onnxruntime` and `onnxruntime-gpu` install the same import package: only the one of the chosen backend may stay.
ORT_OTHER = {"cu128": "onnxruntime", "cpu": "onnxruntime-gpu"}


def cache_home() -> Path:
    return Path(os.environ.get("HSW_EDITOR_CACHE", Path.home() / ".cache" / "hsw-editor"))


def venv_dir() -> Path:
    return Path(os.environ.get("UV_PROJECT_ENVIRONMENT", cache_home() / "vision-venv"))


def state_file() -> Path:
    return Path(os.environ.get("HSW_VISION_STATE", cache_home() / "vision" / "state.json"))


def configure(subs: Any) -> None:
    parser = subs.add_parser(
        "vision",
        help=f"vision service (photo of tools -> objects, photo of a real wall -> wall): {' | '.join(VERBS)}",
        description="Vision sidecar (services/vision). setup: create the vision venv (light lock + heavy torch/ORT stack). "
        "status: is it running, which models are on disk. fetch-models: explicit model download (heavy). "
        "doctor: models, GPU, onnxruntime CUDA. photo-to-objects IMAGE --out DIR: tools in a photo (carpet, table, any angle) -> objects for the tool collection; photo-to-wall IMAGE --out DIR: a photo of a REAL wall -> wall proposal; both run without "
        "the daemon. embed IMAGE... --out DIR: CLIP embeddings. serve: the sidecar itself (the daemon starts it). "
        "`hsw-editor vision VERB --help` shows the verb's options (docs/vision.md).",
    )
    parser.add_argument("vision_args", nargs=argparse.REMAINDER, help="verb and its arguments (see docs/vision.md)")


def handle(args: argparse.Namespace) -> int:
    return run(list(getattr(args, "vision_args", [])))


def run(args: list[str]) -> int:
    if not args or args[0] in ("-h", "--help") or args[0] not in VERBS:
        print(f"usage: hsw-editor vision {'|'.join(VERBS)} ...  (`vision VERB --help` for a verb's options)")
        return 0 if args and args[0] in ("-h", "--help") else EXIT_USAGE
    verb, rest = args[0], args[1:]
    if verb == "status":
        return status("--json" in rest)
    if verb == "setup":
        return setup(rest)
    argv = ["models", "fetch", *rest] if verb == "fetch-models" else [verb, *rest]
    # `VERB --help` only prints the options: it must not queue behind another heavy job on the workstation-wide lock.
    asks_for_help = any(token in ("-h", "--help") for token in rest)
    return run_in_venv(argv, heavy=verb in HEAVY_VERBS and not asks_for_help)


# ---- setup: the only command that installs packages ------------------------------------------------------


def heavy_requirements(backend: str) -> list[str]:
    """Pins of the heavy runtime for `backend` ("cu128" = GPU build, "cpu"), torch with its local build tag."""
    tag = TORCH_BUILD[backend]
    return [f"torch==2.11.0{tag}", f"torchvision==0.26.0{tag}", *HEAVY_COMMON.values(), HEAVY_ORT[backend]]


def uv_env() -> dict[str, str]:
    return {**os.environ, "UV_PROJECT_ENVIRONMENT": str(venv_dir())}


def find_uv() -> str | None:
    uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
    return uv if Path(uv).exists() else None


def wrap_enabled() -> bool:
    return os.environ.get("HSW_VISION_NO_WRAP") != "1"


def venv_python() -> str:
    return str(venv_dir() / "bin" / "python")


def setup_commands(uv: str, backend: str, *, reinstall: bool = False, reinstall_ort: bool = False) -> list[list[str]]:
    """`[light sync, heavy install]`: light locked deps (`uv sync --frozen --inexact`: never removes the heavy stack), then the
    heavy pins from the torch index with PyPI as the fallback for everything else (`reinstall`: even when satisfied)."""
    return [
        [uv, "sync", "--frozen", "--inexact", "--no-dev", "--project", str(PROJECT)],
        [
            uv, "pip", "install", "--python", venv_python(),
            "--index-url", TORCH_INDEX[backend], "--extra-index-url", PYPI, "--index-strategy", "unsafe-best-match",
            *(["--reinstall"] if reinstall else []),
            # uninstalling the other backend's onnxruntime deletes the files both wheels share: restore the chosen one
            *(["--reinstall-package", _requirement_parts(HEAVY_ORT[backend])[0]] if reinstall_ort and not reinstall else []),
            *heavy_requirements(backend),
        ],
    ]  # fmt: skip


def _requirement_parts(requirement: str) -> tuple[str, str, str, str]:
    """`"torch==2.11.0+cu128"` -> `("torch", "==", "2.11.0+cu128", "")`; `"onnxruntime>=1.17,<1.24"` -> `(..., ">=", "1.17", "1.24")`."""
    spec, _, upper = requirement.partition(",<")
    for operator in ("==", ">="):
        if operator in spec:
            name, wanted = spec.split(operator, 1)
            return name, operator, wanted, upper
    return requirement, "", "", ""


def _release(version: str) -> tuple[int, ...]:
    """Numeric release of `version` (`4.45.0rc1+x` -> (4, 45, 0)): a pre-release is NOT the final release, see `_is_pre`."""
    base = version.split("+")[0]
    parts: list[int] = []
    for piece in base.split("."):
        match = re.match(r"\d+", piece)
        if match is None:
            break
        parts.append(int(match.group()))
        if match.end() != len(piece):  # `0rc1`: the release ends here
            break
    return tuple(parts)


def _is_pre(version: str) -> bool:
    return re.search(r"\d(a|b|rc)\d*$|dev", version.split("+")[0]) is not None


def _padded(a: tuple[int, ...], b: tuple[int, ...]) -> tuple[tuple[int, ...], tuple[int, ...]]:
    size = max(len(a), len(b))
    return a + (0,) * (size - len(a)), b + (0,) * (size - len(b))


def _at_least(have: str, wanted: str) -> bool:
    key, floor = _padded(_release(have), _release(wanted))
    return key > floor or (key == floor and not _is_pre(have))


def unsatisfied(requirements: list[str], installed: dict[str, str | None]) -> list[str]:
    """Requirements the `installed` versions (None = absent) do not meet. `==` compares the whole version including the
    local build tag (`2.11.0+cu128` is not `2.11.0+cpu`); `>=`/`<` compare releases and a pre-release is below its final."""
    bad: list[str] = []
    for requirement in requirements:
        name, operator, wanted, upper = _requirement_parts(requirement)
        have = installed.get(name)
        if have is None:
            bad.append(requirement)
            continue
        if operator == "==":
            key, target = _padded(_release(have), _release(wanted))
            ok = have == wanted if "+" in wanted else key == target and not _is_pre(have)
        else:
            ok = _at_least(have, wanted)
        if ok and upper:
            key, ceiling = _padded(_release(have), _release(upper))
            ok = key < ceiling
        if not ok:
            bad.append(requirement)
    return bad


def installed_versions(names: list[str]) -> dict[str, str | None] | None:
    """Versions the venv's interpreter reports (None = absent); None when there is no venv or it cannot be asked."""
    python = Path(venv_python())
    if not python.exists():
        return None
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
        found = json.loads(out)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return found if isinstance(found, dict) else None


def missing_heavy(backend: str) -> list[str]:
    """Pins the venv does not satisfy yet (empty = nothing to install), including the other backend's onnxruntime still
    being installed (reported as `uninstall <name>`)."""
    requirements = heavy_requirements(backend)
    names = sorted({_requirement_parts(r)[0] for r in requirements} | {ORT_OTHER[backend]})
    installed = installed_versions(names)
    if installed is None:
        return requirements
    missing = unsatisfied(requirements, installed)
    if installed.get(ORT_OTHER[backend]) is not None:
        missing.append(f"uninstall {ORT_OTHER[backend]}")
    return missing


def setup(args: list[str]) -> int:
    """`vision setup [--cpu] [--force] [--dry-run]`: create/refresh the vision venv. Safe to re-run: the light lock is
    re-synced (no-op when current) and the heavy install is skipped when every pin is already satisfied."""
    parser = argparse.ArgumentParser(prog="hsw-editor vision setup", description=setup.__doc__)
    parser.add_argument("--cpu", action="store_true", help="CPU torch + onnxruntime (no CUDA wheels, ~1 GB instead of ~8 GB)")
    parser.add_argument("--force", action="store_true", help="`uv pip install --reinstall` the heavy pins even when they are satisfied")
    parser.add_argument("--dry-run", action="store_true", help="print the commands and exit")
    opts = parser.parse_args(args)
    backend = "cpu" if opts.cpu else "cu128"
    uv = find_uv()
    if uv is None:
        print("hsw-editor: uv not found (expected on PATH or ~/.local/bin/uv)")
        return EXIT_MISSING
    other = ORT_OTHER[backend]
    light, heavy = setup_commands(uv, backend, reinstall=opts.force)
    # a venv that still has the other backend's onnxruntime: after removing it the chosen one must be reinstalled
    _, heavy_after_uninstall = setup_commands(uv, backend, reinstall=opts.force, reinstall_ort=True)
    heavy_run = heavy_wrap(heavy) if wrap_enabled() else heavy
    uninstall = [uv, "pip", "uninstall", "--python", venv_python(), other]
    if opts.dry_run:
        print(f"venv: {venv_dir()}  backend: {backend}")
        for command in (light, uninstall, heavy_run):
            print(shlex.join(command))
        print("# when the other backend's onnxruntime is present the install above runs with `--reinstall-package "
              f"{_requirement_parts(HEAVY_ORT[backend])[0]}` after the uninstall")
        return 0
    print(f"vision setup: venv {venv_dir()} ({backend})", flush=True)
    if subprocess.call(light, cwd=REPO_ROOT, env=uv_env()) != 0:
        print("hsw-editor: `uv sync` failed (see above)")
        return EXIT_FAILED
    missing = missing_heavy(backend)
    if not missing and not opts.force:
        print("vision setup: heavy runtime already installed (use --force to reinstall)")
    else:
        todo = ", ".join(missing) if missing else "all pins (--force)"
        print(f"vision setup: refreshing the heavy runtime ({len(heavy_requirements(backend))} pins; needed: {todo})", flush=True)
        if f"uninstall {other}" in missing:  # same import package as the chosen onnxruntime: only one may stay
            if subprocess.call(uninstall, cwd=REPO_ROOT, env=uv_env()) != 0:
                print(f"hsw-editor: `uv pip uninstall {other}` failed (see above)")
                return EXIT_FAILED
            heavy_run = heavy_wrap(heavy_after_uninstall) if wrap_enabled() else heavy_after_uninstall
        if subprocess.call(heavy_run, cwd=REPO_ROOT, env=uv_env()) != 0:
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
    uv = find_uv()
    if uv is None:
        print("hsw-editor: uv not found (expected on PATH or ~/.local/bin/uv)")
        return EXIT_MISSING
    if not Path(venv_python()).exists():
        print(f"hsw-editor: {venv_missing_message()}")
        return EXIT_MISSING
    command = [uv, "run", "--no-sync", "--project", str(PROJECT), "python", "-m", "hsw_vision", *argv]
    if heavy and wrap_enabled():
        command = heavy_wrap(command)
    return subprocess.call(command, cwd=REPO_ROOT, env=uv_env())


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
    """Where a sidecar may listen: `HSW_VISION_URL`, else the state file of `python -m hsw_vision serve` (a live pid, and for
    a unix socket the socket file), else the default loopback port (`hsw-editor doctor` has always looked there)."""
    url = os.environ.get("HSW_VISION_URL")
    if url:
        return {"url": url.rstrip("/"), "source": "HSW_VISION_URL"}
    try:
        state = json.loads(state_file().read_text())
        os.kill(int(state["pid"]), 0)
        recorded_url, recorded_socket = state.get("url"), state.get("socket")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):  # missing, unreadable or malformed state file
        return {"url": f"http://127.0.0.1:{DEFAULT_PORT}", "source": "default port"}
    if isinstance(recorded_url, str) and recorded_url:
        return {"url": recorded_url, "pid": state["pid"], "source": str(state_file())}
    if isinstance(recorded_socket, str) and Path(recorded_socket).exists():
        return {"socket": recorded_socket, "pid": state["pid"], "source": str(state_file())}
    return {"url": f"http://127.0.0.1:{DEFAULT_PORT}", "source": "default port"}


def probe() -> dict[str, Any]:
    """Facts for `hsw-editor doctor` and `vision status`: installed? running? models? Never starts anything."""
    info: dict[str, Any] = {
        "venv": str(venv_dir()),
        "installed": Path(venv_python()).exists(),
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
        return EXIT_NOT_READY
    if not info["running"]:
        print("vision: installed, not running (the daemon starts it on the first vision job and stops it when idle)")
        print("  models on disk: hsw-editor vision doctor")
        return EXIT_NOT_READY
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
