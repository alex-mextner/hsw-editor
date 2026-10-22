#!/usr/bin/env python3
"""hsw-editor: lifecycle CLI for the local HSW wall editor service.

Thin wrapper over the shared ``agenttools_service`` lib (agent-tools). The service argv is this very
file with the hidden ``_serve`` verb, which exec()s the Bun server in the foreground, so the pid the
lib tracks IS the server. Installed as ``~/.local/bin/hsw-editor`` (symlink to this file).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sys
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PORT = 8794
HOST = "127.0.0.1"
SERVICE_NAME = "hsw-editor"
SERVICE_TOOL = None  # name alone namespaces pidfile/unit; hints then read "hsw-editor enable"
CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "hsw-editor" / "config.json"
DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "hsw-editor"
LIB_CANDIDATES = (
    os.environ.get("AGENT_TOOLS_LIB", ""),
    str(Path.home() / "dev/agent-tools/lib"),
)
INSTALL_HINT = (
    "agenttools_service not importable. It is an agent-tools nested lib (not on PyPI). Either set "
    "AGENT_TOOLS_LIB=<agent-tools>/lib or: pip install -e <agent-tools>/lib/agenttools_daemon "
    "-e <agent-tools>/lib/agenttools_service"
)


def load_config() -> dict[str, Any]:
    """Config file is created on first use (idempotent) so the default port is recorded."""
    if not CONFIG_PATH.exists():
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(json.dumps({"port": DEFAULT_PORT, "host": HOST}, indent=2) + "\n")
    try:
        return json.loads(CONFIG_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {"port": DEFAULT_PORT, "host": HOST}


def configured_port() -> int:
    return int(load_config().get("port", DEFAULT_PORT))


def load_service_lib() -> Any:
    """Import agenttools_service: installed package first, then a checkout on sys.path (no network)."""
    try:
        import agenttools_service  # noqa: PLC0415
        return agenttools_service
    except ImportError:
        pass
    for candidate in LIB_CANDIDATES:
        if candidate and (Path(candidate) / "agenttools_service").is_dir():
            sys.path.insert(0, candidate)
            import agenttools_service  # noqa: PLC0415
            return agenttools_service
    raise SystemExit(f"hsw-editor: {INSTALL_HINT}")


def find_bun() -> str:
    bun = shutil.which("bun") or str(Path.home() / ".local/bin/bun")
    if not Path(bun).exists():
        raise SystemExit("hsw-editor: bun not found (expected on PATH or ~/.local/bin/bun)")
    return str(Path(bun).absolute())


def build_service(port: int) -> Any:
    lib = load_service_lib()
    argv = [sys.executable, str(Path(__file__).resolve()), "_serve", "--port", str(port)]
    return lib.Service(
        name=SERVICE_NAME,
        argv=argv,
        port=port,
        host=HOST,
        tool=SERVICE_TOOL,
        description="hsw-editor: local 3D HSW wall editor",
    )


def manager(port: int) -> Any:
    lib = load_service_lib()
    return lib.ServiceManager(build_service(port))


def serve(args: argparse.Namespace) -> int:
    """Hidden verb: replace this process with the Bun server (foreground, same pid)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HSW_EDITOR_PORT=str(args.port), HSW_EDITOR_HOST=HOST,
               HSW_EDITOR_DATA_DIR=str(DATA_DIR))
    bun = find_bun()
    os.chdir(REPO_ROOT)
    os.execve(bun, [bun, str(REPO_ROOT / "apps/server/src/index.ts")], env)
    return 1  # unreachable


def health(port: int, timeout: float = 2.0) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/health", timeout=timeout) as resp:
            return json.load(resp)
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return None


def doctor(args: argparse.Namespace) -> int:
    port = args.port
    checks: list[tuple[str, bool, str]] = []
    try:
        lib = load_service_lib()
        checks.append(("agenttools_service", True, str(Path(lib.__file__).parent)))
    except SystemExit as exc:
        checks.append(("agenttools_service", False, str(exc)))
    bun = shutil.which("bun") or str(Path.home() / ".local/bin/bun")
    checks.append(("bun", Path(bun).exists(), bun))
    dist = REPO_ROOT / "apps/web/dist/index.html"
    checks.append(("web build", dist.exists(), str(dist) if dist.exists() else "run: bun run build"))
    state_lib = REPO_ROOT / "vendor/state-lib/dist/index.js"
    checks.append(("state-lib (optional)", state_lib.exists(),
                   "vendored" if state_lib.exists() else "absent: baseline store backend; run: bun run setup:state-lib"))
    with socket.socket() as sock:
        sock.settimeout(0.5)
        in_use = sock.connect_ex((HOST, port)) == 0
    served = health(port)
    checks.append((f"port {port}", (not in_use) or served is not None,
                   "free" if not in_use else ("hsw-editor is serving" if served else "occupied by another process")))
    checks.append(("data dir", True, str(DATA_DIR)))
    for name, ok, detail in checks:
        print(f"{'ok  ' if ok else 'FAIL'} {name}: {detail}")
    required_failed = any(not ok for name, ok, _ in checks if "optional" not in name)
    return 1 if required_failed else 0


def open_browser(args: argparse.Namespace) -> int:
    url = f"http://{HOST}:{args.port}/"
    if health(args.port) is None:
        print(f"hsw-editor is not running on {url} (run: hsw-editor start)", file=sys.stderr)
        return 3
    print(url)
    webbrowser.open(url)
    return 0


def restart(args: argparse.Namespace) -> int:
    lib = load_service_lib()
    mgr = manager(args.port)
    mgr.stop()
    return lib.run_action(mgr, "start")


ACTIVE_PORT = [DEFAULT_PORT]  # resolved port for the lazy manager factory
LIFECYCLE_VERBS = ("run", "start", "stop", "status", "enable", "disable")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="hsw-editor", description="Local 3D HSW wall editor service.")
    parser.add_argument("--port", type=int, default=None, help=f"override port (default from config, {DEFAULT_PORT})")
    subs = parser.add_subparsers(dest="verb", metavar="VERB")
    # run/start/stop/status/enable/disable come from the shared agent-tools service manager. The lib is
    # stdlib-only and imported only when one of them actually runs (see port_of/manager factory).
    try:
        lib = load_service_lib()
        lib.add_service_subcommands(subs, manager_factory=lambda: manager(ACTIVE_PORT[0]), service_name=SERVICE_NAME)
    except SystemExit:
        for name in LIFECYCLE_VERBS:
            placeholder = subs.add_parser(name, help=f"{name} the service (needs agenttools_service)")
            placeholder.set_defaults(_missing_lib=True)
    for name, help_text in (("restart", "stop then start in the background"),
                            ("open", "open the editor in the default browser"),
                            ("doctor", "check the environment (lib, bun, build, port)")):
        subs.add_parser(name, help=help_text)
    subs.add_parser("_serve")
    for sub in subs.choices.values():
        sub.add_argument("--port", type=int, default=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if getattr(args, "_missing_lib", False):
        raise SystemExit(f"hsw-editor: {INSTALL_HINT}")
    if args.verb is None:
        parser.print_help()
        return 0
    args.port = port_of(args)
    ACTIVE_PORT[0] = args.port
    if getattr(args, "_service_action", None):
        return int(load_service_lib().dispatch(args, on_no_subcommand=lambda: 0))
    return {"_serve": serve, "doctor": doctor, "open": open_browser, "restart": restart}[args.verb](args)


def port_of(args: argparse.Namespace) -> int:
    return args.port if getattr(args, "port", None) else configured_port()


if __name__ == "__main__":
    raise SystemExit(main())
