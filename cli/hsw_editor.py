#!/usr/bin/env python3
"""hsw-editor: lifecycle and wall CLI for the local HSW wall editor service.

Thin wrapper over the shared ``agenttools_service`` lib (agent-tools). The service argv is this very
file with the hidden ``_serve`` verb, which exec()s the Bun server in the foreground, so the pid the
lib tracks IS the server. Installed as ``~/.local/bin/hsw-editor`` (symlink to this file).

Verbs: run|start|stop|restart|status|enable|disable (service lib), open, doctor, wall ... and bank ... (HTTP API).
Other modules add verbs with ``register_verb`` (see the ``draw`` verb of the draw backends).
Exit codes are a stable contract, see ``cli/hswlib/errors.py`` and ``docs/cli.md``.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Callable

CLI_DIR = Path(__file__).resolve().parent
REPO_ROOT = CLI_DIR.parent
DEFAULT_PORT = 8794
HOST = "127.0.0.1"
SERVICE_NAME = "hsw-editor"
SERVICE_TOOL = None  # name alone namespaces pidfile/unit; hints then read "hsw-editor enable"
READY_TIMEOUT_S = 10.0
CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "hsw-editor" / "config.json"
LIB_CANDIDATES = (
    os.environ.get("AGENT_TOOLS_LIB", ""),
    str(Path.home() / "dev/agent-tools/lib"),
)
INSTALL_HINT = (
    "agenttools_service not importable. It is an agent-tools nested lib (not on PyPI). Either set "
    "AGENT_TOOLS_LIB=<agent-tools>/lib or: pip install -e <agent-tools>/lib/agenttools_daemon "
    "-e <agent-tools>/lib/agenttools_service"
)


def data_dir() -> Path:
    """Wall store root; same resolution as the server (`HSW_EDITOR_HOME`, else XDG data home)."""
    explicit = os.environ.get("HSW_EDITOR_HOME")
    if explicit:
        return Path(explicit).expanduser()
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "hsw-editor"


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


def ensure_lib_path() -> str | None:
    """Make the agent-tools libs importable (installed packages first, then a checkout). Returns the lib dir."""
    try:
        import agenttools_service  # noqa: PLC0415

        return str(Path(agenttools_service.__file__).resolve().parent)
    except ImportError:
        pass
    for candidate in LIB_CANDIDATES:
        if candidate and (Path(candidate) / "agenttools_service").is_dir():
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
            return str(Path(candidate) / "agenttools_service")
    return None


sys.path.insert(0, str(CLI_DIR))
LIB_DIR = ensure_lib_path()

from hswlib.unit_lifecycle import VERBS as UNIT_VERBS, UnitControl, run_verb as run_unit_verb, unit_port  # noqa: E402 - stdlib only

try:
    from hswlib import doctor as doctor_checks  # noqa: E402
    from hswlib.client import Api  # noqa: E402
    from hswlib.errors import (  # noqa: E402
        EXIT_EPILOG,
        EXIT_FAILED_CHECK,
        AutostartError,
        guard,
    )
    from hswlib.bank import add_bank_parser, run_bank  # noqa: E402
    from hswlib.wall import add_wall_parser, run_wall  # noqa: E402

    LIBS_OK = True
except ImportError:  # agenttools_errors missing: lifecycle help still renders, everything else explains
    LIBS_OK = False


def load_service_lib() -> Any:
    if LIB_DIR is None:
        raise SystemExit(f"hsw-editor: {INSTALL_HINT}")
    import agenttools_service  # noqa: PLC0415

    return agenttools_service


def find_bun() -> str:
    import shutil  # noqa: PLC0415

    bun = shutil.which("bun") or str(Path.home() / ".local/bin/bun")
    if not Path(bun).exists():
        raise SystemExit("hsw-editor: bun not found (expected on PATH or ~/.local/bin/bun)")
    return str(Path(bun).absolute())


def version() -> str:
    """Release version, read from the root package.json (`bun run release` is the only writer)."""
    try:
        return str(json.loads((REPO_ROOT / "package.json").read_text())["version"])
    except (OSError, ValueError, KeyError):
        return "unknown"


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
    home = data_dir()
    home.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, HSW_EDITOR_PORT=str(args.port), HSW_EDITOR_HOST=HOST, HSW_EDITOR_HOME=str(home))
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


def wait_ready(port: int, timeout: float = READY_TIMEOUT_S) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        served = health(port, timeout=1.0)
        if served is not None and str(served.get("name", "")).startswith("hsw-editor"):
            return True
        time.sleep(0.25)
    return False


def ensure_serving(port: int) -> int:
    """After a start/enable the pid exists before the port answers; a dead server must not look like success."""
    if wait_ready(port):
        return 0
    log = build_service(port).logfile
    with socket.socket() as sock:
        sock.settimeout(0.5)
        taken = sock.connect_ex((HOST, port)) == 0
    raise AutostartError(
        what=f"hsw-editor did not come up on {HOST}:{port} within {READY_TIMEOUT_S:.0f}s",
        why=f"port {port} is held by another process" if taken else f"the server exited; see {log}",
        fix=f"hsw-editor --port <free port> start   (log: {log})" if taken else f"tail {log}; hsw-editor doctor",
    )


def run_doctor(args: argparse.Namespace) -> int:
    ctx = doctor_checks.Context(
        port=args.port,
        repo_root=REPO_ROOT,
        data_dir=data_dir(),
        lib_error=None if LIB_DIR else INSTALL_HINT,
        lib_path=LIB_DIR or "",
    )
    results = doctor_checks.run_checks(ctx)
    print(doctor_checks.render(results, args.json))
    return EXIT_FAILED_CHECK if any(check.level == "fail" for check in results) else 0


def open_browser(args: argparse.Namespace) -> int:
    url = f"http://{HOST}:{args.port}/"
    if health(args.port) is None:
        print(f"hsw-editor is not running on {url} (run: hsw-editor start)", file=sys.stderr)
        return 3
    print(url)
    webbrowser.open(url)
    return 0


def unit_control(mgr: Any, port: int) -> Any | None:
    """The systemd unit controller when autostart owns the daemon on this port, else None (the pidfile daemon path)."""
    backend = mgr.backend
    if not (backend.manages_process and backend.is_installed(mgr.service)):
        return None
    if unit_port(backend.unit_path(mgr.service)) != port:
        return None  # `--port N` addresses another daemon than the unit's
    return UnitControl(f"{mgr.service.systemd_unit_name}.service")


def run_unit_lifecycle(verb: str, unit: Any, mgr: Any, port: int) -> int:
    return run_unit_verb(
        verb,
        unit,
        name=SERVICE_NAME,
        url=f"http://{HOST}:{port}/",
        release_pidfile_daemon=mgr.stop,
        wait_ready=lambda: ensure_serving(port),
    )


def restart(args: argparse.Namespace) -> int:
    lib = load_service_lib()
    mgr = manager(args.port)
    unit = unit_control(mgr, args.port)
    if unit is not None:
        return run_unit_lifecycle("restart", unit, mgr, args.port)
    mgr.stop()
    code = lib.run_action(mgr, "start")
    return code if code != 0 else ensure_serving(args.port)


def run_wall_verb(args: argparse.Namespace) -> int:
    return run_wall(args, Api(args.port))


def run_bank_verb(args: argparse.Namespace) -> int:
    return run_bank(args, Api(args.port))


ACTIVE_PORT = [DEFAULT_PORT]  # resolved port for the lazy manager factory
LIFECYCLE_VERBS = ("run", "start", "stop", "status", "enable", "disable")
# start/enable return before the port answers; these verbs wait for the health endpoint afterwards
WAIT_AFTER = ("start", "enable")

Handler = Callable[[argparse.Namespace], int]
ParserHook = Callable[[Any], None]
VERBS: dict[str, Handler] = {}
PARSER_HOOKS: list[ParserHook] = []


def register_verb(name: str, handler: Handler, configure: ParserHook) -> None:
    """Add a top-level verb: ``configure(subparsers)`` registers its parser, ``handler(args) -> exit code``."""
    VERBS[name] = handler
    PARSER_HOOKS.append(configure)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hsw-editor",
        description="Local 3D HSW wall editor service.",
        epilog=EXIT_EPILOG if LIBS_OK else None,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--port", type=int, default=None, help=f"override port (default from config, {DEFAULT_PORT})")
    parser.add_argument("--version", action="version", version=f"hsw-editor {version()}")
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
                            ("open", "open the editor in the default browser")):
        subs.add_parser(name, help=help_text)
    doctor = subs.add_parser(
        "doctor",
        help="check the environment (lib, bun, build, offline assets, port, GPU, omp, vision, draw); exit 1 on a failure",
    )
    doctor.add_argument("--json", action="store_true", help="machine-readable result")
    subs.add_parser("_serve")
    if LIBS_OK:
        add_wall_parser(subs)
        add_bank_parser(subs)
    for hook in PARSER_HOOKS:  # the stdlib-only verbs (vision, draw) exist without the agent-tools libs too
        hook(subs)
    for sub in subs.choices.values():
        sub.add_argument("--port", type=int, default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    return parser


def port_of(args: argparse.Namespace) -> int:
    return args.port if getattr(args, "port", None) else configured_port()


def dispatch(args: argparse.Namespace) -> int:
    if getattr(args, "_service_action", None):
        if args.verb in UNIT_VERBS:
            mgr = manager(args.port)
            unit = unit_control(mgr, args.port)
            if unit is not None:
                return run_unit_lifecycle(args.verb, unit, mgr, args.port)
        code = int(load_service_lib().dispatch(args, on_no_subcommand=lambda: 0))
        if code == 0 and args.verb in WAIT_AFTER:
            return ensure_serving(args.port)
        return code
    if args.verb == "wall":
        return run_wall_verb(args)
    if args.verb == "bank":
        return run_bank_verb(args)
    handlers: dict[str, Handler] = {
        "_serve": serve,
        "doctor": run_doctor,
        "open": open_browser,
        "restart": restart,
        **VERBS,
    }
    return handlers[args.verb](args)


if LIBS_OK:
    import tools_verb  # noqa: E402

    register_verb("tools", tools_verb.run, tools_verb.configure)

import vision_verb  # noqa: E402 - sibling module (cli/ is the script directory); stdlib only

register_verb("vision", vision_verb.handle, vision_verb.configure)

import draw_verb  # noqa: E402 - sibling module; stdlib only

register_verb("draw", draw_verb.handle, draw_verb.configure)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if getattr(args, "_missing_lib", False):
        raise SystemExit(f"hsw-editor: {INSTALL_HINT}")
    if args.verb is None:
        parser.print_help()
        return 0
    if not LIBS_OK and args.verb in ("wall", "bank", "doctor"):
        raise SystemExit(f"hsw-editor: agenttools_errors not importable. {INSTALL_HINT}")
    args.port = port_of(args)
    ACTIVE_PORT[0] = args.port
    return guard(lambda: dispatch(args)) if LIBS_OK else dispatch(args)


if __name__ == "__main__":
    raise SystemExit(main())
