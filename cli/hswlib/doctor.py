"""``hsw-editor doctor``: environment checks, each failure with a concrete fix hint.

Required checks decide the exit code (1 on any failure); optional ones (GPU, vision sidecar, draw backends, ...)
print ``warn`` with what is lost and how to fix it, but never fail the run. Other modules add checks through
``EXTRA_CHECKS`` (the draw backends register theirs there).
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Callable

HOST = "127.0.0.1"
VISION_URL = os.environ.get("HSW_VISION_URL", "http://127.0.0.1:8795")
# Written by `bun run build` only after vite succeeded (apps/web/package.json, scripts/lib/web-build.sh share the name).
WEB_BUILD_STAMP = ".build-ok"


@dataclass(frozen=True)
class Check:
    name: str
    level: str  # ok | warn | fail
    detail: str
    fix: str = ""


@dataclass(frozen=True)
class Context:
    port: int
    repo_root: Path
    data_dir: Path
    lib_error: str | None  # None when agenttools_service imported fine
    lib_path: str


CheckFn = Callable[[Context], list[Check]]
EXTRA_CHECKS: list[CheckFn] = []


def _run(argv: list[str], timeout: float = 5.0) -> str | None:
    try:
        done = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return (done.stdout or done.stderr).strip() if done.returncode == 0 else None


def _get_json(url: str, timeout: float = 2.0) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.load(resp)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _which(name: str) -> str | None:
    return shutil.which(name) or (str(p) if (p := Path.home() / ".local/bin" / name).exists() else None)


def check_agent_tools(ctx: Context) -> list[Check]:
    if ctx.lib_error is None:
        return [Check("agent-tools lib", "ok", ctx.lib_path)]
    return [Check("agent-tools lib", "fail", ctx.lib_error, "export AGENT_TOOLS_LIB=<agent-tools>/lib (default ~/dev/agent-tools/lib)")]


def check_bun(ctx: Context) -> list[Check]:
    bun = _which("bun")
    if bun is None:
        return [Check("bun", "fail", "not found", "install bun: curl -fsSL https://bun.sh/install | bash")]
    version = _run([bun, "--version"]) or "?"
    wanted_file = ctx.repo_root / ".bun-version"
    wanted = wanted_file.read_text().strip() if wanted_file.exists() else ""
    if wanted and version != wanted:
        return [Check("bun", "warn", f"{bun} {version} (repo pins {wanted})", f"bun upgrade --version {wanted}")]
    return [Check("bun", "ok", f"{bun} {version}")]


def check_web_build(ctx: Context) -> list[Check]:
    dist = Path(os.environ.get("HSW_EDITOR_WEB_DIST") or ctx.repo_root / "apps/web/dist")
    index = dist / "index.html"
    if not index.exists():
        return [Check("web build", "fail", f"{index} missing", "bun install && bun run build")]
    if not (dist / WEB_BUILD_STAMP).exists():
        return [Check("web build", "fail", f"{dist} has no {WEB_BUILD_STAMP}: the last build failed or was interrupted",
                      "bun install && bun run build")]
    checks = [Check("web build", "ok", str(dist))]
    missing = [name for name in ("sw.js", "manifest.webmanifest") if not (dist / name).exists()]
    if missing:
        checks.append(Check("offline assets", "warn", f"{', '.join(missing)} missing in dist: the app will not work offline",
                            "rebuild with the PWA plugin enabled: bun run build"))
    else:
        precached = len(list((dist / "assets").glob("*"))) if (dist / "assets").is_dir() else 0
        checks.append(Check("offline assets", "ok", f"service worker + manifest present, {precached} hashed assets"))
    return checks


BANK_VERIFY = "scripts/bank/verify.ts"
BANK_FIX_REBUILD = "bun run bank:ingest (rebuild; the previous good generation keeps serving) or bun run bank:adopt <known-good bank dir>"


def _bank_verify(ctx: Context, *flags: str) -> tuple[int, dict] | str:
    """Run the bank verifier; returns (exit code, parsed --json report) or a reason string when it could not run."""
    bun = _which("bun")
    if bun is None:
        return "bun not found"
    env = dict(os.environ)
    if "HSW_BANK_DIR" not in env and "HSW_EDITOR_DATA_DIR" not in env:
        env["HSW_EDITOR_DATA_DIR"] = str(ctx.data_dir)
    try:
        done = subprocess.run([bun, BANK_VERIFY, *flags, "--json"], cwd=ctx.repo_root, env=env,
                              capture_output=True, text=True, timeout=120, check=False)
    except subprocess.TimeoutExpired:
        return "verify timed out after 120 s"
    except OSError as err:
        return f"cannot run bun: {err}"
    if done.returncode == 3:
        return 3, {}
    try:
        report = json.loads(done.stdout.strip().splitlines()[-1]) if done.stdout.strip() else None
    except ValueError:
        report = None
    if not isinstance(report, dict) or not isinstance(report.get("roots"), list):
        return f"unparsable verify output (exit {done.returncode})"
    return done.returncode, report


def _bank_problems(report: dict) -> list[str]:
    return [f"{r.get('root', '?')}: {p}" for r in report["roots"] for p in r.get("problems", [])]


def _bank_integrity(ctx: Context) -> Check:
    result = _bank_verify(ctx)
    if isinstance(result, str):
        return Check("bank integrity", "warn", result, "bun run bank:verify")
    code, report = result
    if code == 3:
        return Check("bank integrity", "warn", "no built bank: the committed seed is served", "bun run bank:ingest")
    if code == 0:
        checked = sum(int(r.get("checked", 0)) for r in report["roots"])
        root = report["roots"][0].get("root", "?") if report["roots"] else "?"
        return Check("bank integrity", "ok", f"{checked} elements verified in {root}")
    problems = _bank_problems(report)
    detail = f"{len(problems)} problem(s): " + "; ".join(problems[:3])
    return Check("bank integrity", "fail", detail, BANK_FIX_REBUILD)


def _bank_seed(ctx: Context) -> Check:
    result = _bank_verify(ctx, "--seed")
    if isinstance(result, str):
        return Check("bank seed", "warn", result, "bun run bank:verify --seed")
    code, report = result
    if code == 0:
        return Check("bank seed", "ok", "committed seed verified")
    problems = _bank_problems(report) if report else []
    detail = "; ".join(problems[:3]) or f"verify exited {code}"
    return Check("bank seed", "fail", f"committed seed is corrupt or missing: {detail}", "git checkout packages/bank/seed")


def _get_health(url: str, timeout: float = 2.0) -> tuple[int, dict | None] | None:
    """Like _get_json but keeps the JSON body of an HTTP error status (503 carries the health report)."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as err:
        with err:
            try:
                return err.code, json.load(err)
            except ValueError:
                return err.code, None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def _bank_served(ctx: Context) -> Check | None:
    served = _get_json(f"http://{HOST}:{ctx.port}/api/health")
    if served is None or not str(served.get("name", "")).startswith("hsw-editor"):
        return None
    answer = _get_health(f"http://{HOST}:{ctx.port}/api/bank/health")
    if answer is None or answer[0] == 404 or answer[1] is None:
        return None
    health = answer[1]
    rejected = health.get("rejected") or []
    if not health.get("ok") or rejected:
        first = rejected[0] if rejected else {}
        problems = first.get("problems") or []
        detail = f"{first.get('root', 'nothing served')}: {problems[0]}" if problems else "bank not servable"
        return Check("bank (served)", "fail", detail, "hsw-editor restart after bun run bank:ingest")
    root = str((health.get("served") or {}).get("root", "")).rstrip("/").rsplit("/", 1)[-1] or "?"
    return Check("bank (served)", "ok", f"serving {health.get('elements', 0)} elements (generation {root}), {health.get('unavailable', 0)} unavailable")


def check_bank(ctx: Context) -> list[Check]:
    if not (ctx.repo_root / BANK_VERIFY).exists():
        return [Check("bank integrity", "warn", "bank tooling not present in this checkout", "git pull")]
    rows = [_bank_integrity(ctx), _bank_seed(ctx), _bank_served(ctx)]
    return [row for row in rows if row is not None]


def check_state_lib(ctx: Context) -> list[Check]:
    package = "node_modules/@ultrabricks/state-lib/package.json"
    # Bun's isolated linker installs under the workspace; the hoisted one under the repo root.
    if any((ctx.repo_root / base / package).exists() for base in ("apps/web", ".")):
        return [Check("state-lib", "ok", "installed")]
    return [Check("state-lib", "warn", "not installed: the web UI cannot build", "bun install")]


def check_port(ctx: Context) -> list[Check]:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        in_use = sock.connect_ex((HOST, ctx.port)) == 0
    if not in_use:
        return [Check(f"port {ctx.port}", "ok", "free")]
    served = _get_json(f"http://{HOST}:{ctx.port}/api/health")
    if served is not None and str(served.get("name", "")).startswith("hsw-editor"):
        return [Check(f"port {ctx.port}", "ok", f"hsw-editor {served.get('version', '?')} is serving (home {served.get('home', '?')})")]
    return [Check(f"port {ctx.port}", "fail", "occupied by another process",
                  f"find it: ss -ltnp | grep :{ctx.port}; or use another port: hsw-editor --port <free> start")]


def check_data_dir(ctx: Context) -> list[Check]:
    path = ctx.data_dir
    try:
        (path / "walls").mkdir(parents=True, exist_ok=True)
        probe = path / ".doctor-probe"
        probe.write_text("ok")
        probe.unlink()
    except OSError as exc:
        return [Check("data dir", "fail", f"{path}: {exc}", f"fix permissions: chmod u+rwx {path}  (or set HSW_EDITOR_HOME)")]
    mode = path.stat().st_mode & 0o777
    if mode & 0o002:
        return [Check("data dir", "warn", f"{path} is world-writable ({mode:o})", f"chmod o-w {path}")]
    return [Check("data dir", "ok", f"{path} (writable, mode {mode:o})")]


def check_uv(ctx: Context) -> list[Check]:
    uv = _which("uv")
    if uv is None:
        return [Check("uv", "warn", "not found: the vision sidecar cannot be installed", "install uv: curl -LsSf https://astral.sh/uv/install.sh | sh")]
    return [Check("uv", "ok", f"{uv} {_run([uv, '--version']) or ''}".strip())]


def check_omp(ctx: Context) -> list[Check]:
    omp = _which("omp")
    if omp is None:
        return [Check("omp", "warn", "not found: the agent panel is unavailable", "install oh-my-pi: bun add -g @oh-my-pi/pi-coding-agent")]
    return [Check("omp", "ok", f"{omp} {_run([omp, '--version']) or ''}".strip())]


def check_gpu(ctx: Context) -> list[Check]:
    smi = shutil.which("nvidia-smi")
    if smi is None:
        return [Check("GPU", "warn", "nvidia-smi not found: detection/segmentation run on CPU only", "install the NVIDIA driver (optional)")]
    out = _run([smi, "--query-gpu=name,memory.total,memory.used", "--format=csv,noheader"])
    if not out:
        return [Check("GPU", "warn", "nvidia-smi failed (no usable GPU)", "check the driver: nvidia-smi")]
    return [Check("GPU", "ok", out.splitlines()[0])]


def check_vision(ctx: Context) -> list[Check]:
    """The vision sidecar (`services/vision`) lives in a venv outside the repo (`hsw-editor vision setup`) and is started
    by the daemon on the first `vision.*` job, so "installed, not running" is the normal idle state."""
    import vision_verb  # cli/ is the script directory; stdlib only

    info = vision_verb.probe()
    if info["running"]:
        health = info["health"] or {}
        return [Check("vision sidecar", "ok", f"{info['endpoint']} {health.get('name', '')} {health.get('version', '')}".strip())]
    if info["installed"]:
        return [Check("vision sidecar", "warn", f"installed ({info['venv']}), not running: the daemon starts it on the first vision job",
                      "models: hsw-editor vision doctor")]
    return [Check("vision sidecar", "warn", "not installed: vision (tools photos, wall photos) is unavailable", "hsw-editor vision setup")]


def check_draw(ctx: Context) -> list[Check]:
    backends = ["manual-upload"]
    if _which("draw") and _which("codex"):
        backends.append("draw-cli")
    if _which("omp"):
        backends.append("omp-generate-image")
    profile = ctx.data_dir / "chatgpt-profile"
    if profile.is_dir():
        backends.append("chatgpt-browser")
    detail = ", ".join(backends)
    if len(backends) == 1:
        return [Check("draw backends", "warn", f"only {detail}: missing views cannot be drawn automatically",
                      "install draw-cli and `codex login` (ChatGPT), install omp (generate_image), or set up the ChatGPT browser profile")]
    return [Check("draw backends", "ok", detail)]


BASE_CHECKS: list[CheckFn] = [
    check_agent_tools,
    check_bun,
    check_web_build,
    check_bank,
    check_state_lib,
    check_port,
    check_data_dir,
    check_uv,
    check_omp,
    check_gpu,
    check_vision,
    check_draw,
]


def run_checks(ctx: Context) -> list[Check]:
    results: list[Check] = []
    for fn in [*BASE_CHECKS, *EXTRA_CHECKS]:
        results.extend(fn(ctx))
    return results


def render(results: list[Check], as_json: bool) -> str:
    if as_json:
        return json.dumps({"ok": not any(c.level == "fail" for c in results), "checks": [asdict(c) for c in results]}, indent=2)
    lines = []
    for check in results:
        label = {"ok": "ok  ", "warn": "warn", "fail": "FAIL"}[check.level]
        lines.append(f"{label} {check.name}: {check.detail}")
        if check.fix and check.level != "ok":
            lines.append(f"     fix: {check.fix}")
    return "\n".join(lines)
