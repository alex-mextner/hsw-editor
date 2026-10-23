"""start/stop/restart/status through the systemd user unit.

While autostart is enabled systemd owns the daemon. The shared service library would still spawn a
second detached pidfile daemon on ``start``/``restart`` and report "running" for any installed unit,
so these verbs talk to ``systemctl --user`` instead: exactly one daemon, and ``status`` reads the
unit's real state. Exit codes follow the lifecycle contract: 3 not running, 4 control failure.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import Callable

EXIT_NOT_RUNNING = 3
EXIT_FAILED = 4
VERBS = ("start", "stop", "restart", "status")

Runner = Callable[[list[str]], "subprocess.CompletedProcess[str]"]


def _run(cmd: list[str]) -> "subprocess.CompletedProcess[str]":
    try:
        return subprocess.run(cmd, check=False, capture_output=True, text=True)
    except OSError as exc:
        return subprocess.CompletedProcess(cmd, 127, "", str(exc))


def unit_port(unit_file: Path) -> int | None:
    """The ``--port`` the unit's ExecStart serves, so ``--port N`` only reaches the unit of that port."""
    try:
        match = re.search(r"^ExecStart=.*--port[\"']?[\s=]+[\"']?(\d+)", unit_file.read_text(encoding="utf-8"), re.MULTILINE)
    except OSError:
        return None
    return int(match.group(1)) if match else None


class UnitState:
    """``systemctl show`` answer: ``active_state`` is None when systemctl itself could not answer."""

    def __init__(self, active_state: str | None, main_pid: int | None, error: str = "") -> None:
        self.active_state = active_state
        self.main_pid = main_pid
        self.error = error

    @property
    def up(self) -> bool:
        """Something of the unit exists (also while it starts, restarts after a crash or shuts down): `stop` acts."""
        return self.active_state in ("active", "activating", "reloading", "deactivating")

    @property
    def serving(self) -> bool:
        """A process is running: a crash loop waiting in `auto-restart` has `activating` but MainPID 0."""
        return self.active_state in ("active", "reloading") or (self.active_state == "activating" and self.main_pid is not None)


class UnitControl:
    def __init__(self, unit: str, runner: Runner = _run) -> None:
        self.unit = unit
        self._runner = runner

    def state(self) -> UnitState:
        proc = self._runner(["systemctl", "--user", "show", "--property=ActiveState,MainPID", self.unit])
        if proc.returncode != 0:
            return UnitState(None, None, proc.stderr.strip() or f"systemctl exited {proc.returncode}")
        props = dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)
        pid = props.get("MainPID", "")
        return UnitState(props.get("ActiveState", "unknown"), int(pid) if pid.isdigit() and int(pid) > 0 else None)

    def control(self, verb: str) -> "subprocess.CompletedProcess[str]":
        return self._runner(["systemctl", "--user", verb, self.unit])


def _eprint(message: str) -> None:
    print(message, file=sys.stderr)


def run_verb(
    verb: str,
    unit: UnitControl,
    *,
    name: str,
    url: str,
    release_pidfile_daemon: Callable[[], bool],
    wait_ready: Callable[[], int],
) -> int:
    """Run one lifecycle verb against the unit. ``release_pidfile_daemon`` stops a leftover
    manager-spawned daemon (it holds the port the unit needs) and says whether one was running;
    ``wait_ready`` returns the exit code once the API answers."""
    state = unit.state()
    if state.active_state is None:
        _eprint(f"{name}: cannot query {unit.unit} ({state.error}); is the systemd user session reachable?")
        return EXIT_FAILED
    if verb == "status":
        if not state.serving:
            print(f"{name}: stopped ({unit.unit} is {state.active_state}{', no process' if state.up else ''})")
            return EXIT_NOT_RUNNING
        pid = f" (pid {state.main_pid})" if state.main_pid else ""
        starting = " [starting]" if state.active_state != "active" else ""
        print(f"{name}: running{pid} {url} [autostart on]{starting}")
        return 0
    released = release_pidfile_daemon()
    if verb == "stop":
        if not state.up and not released:
            _eprint(f"{name}: not running ({unit.unit} is {state.active_state})")
            return EXIT_NOT_RUNNING
        proc = unit.control("stop")
        if proc.returncode != 0:
            _eprint(f"{name}: systemctl --user stop {unit.unit} failed: {proc.stderr.strip()}")
            return EXIT_FAILED
        print(f"{name}: stopped (autostart stays enabled; 'hsw-editor disable' removes it)")
        return 0
    proc = unit.control(verb)
    if proc.returncode != 0:
        _eprint(f"{name}: systemctl --user {verb} {unit.unit} failed: {proc.stderr.strip()}"
                + ("; the pidfile daemon was stopped first" if released else ""))
        return EXIT_FAILED
    code = wait_ready()
    if code == 0:
        print(f"{name}: {'restarted' if verb == 'restart' else 'started'} via {unit.unit}")
    return code
