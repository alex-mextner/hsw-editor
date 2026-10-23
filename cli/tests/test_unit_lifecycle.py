"""start/stop/restart/status route through the systemd user unit once autostart owns the daemon."""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hswlib.unit_lifecycle import UnitControl, run_verb, unit_port  # noqa: E402

UNIT = "agenttools-hsw-editor-hsw-editor.service"
SYSTEMCTL_VERB = 2  # ["systemctl", "--user", <verb>, ...]


class FakeSystemctl:
    """Records every systemctl call; `state` is the unit's ActiveState, `fail` makes a verb exit 1."""

    def __init__(self, state: str = "active", pid: int = 4242, fail: frozenset[str] = frozenset()) -> None:
        self.state = state
        self.pid = pid
        self.fail = fail
        self.calls: list[list[str]] = []

    def __call__(self, cmd: list[str]) -> subprocess.CompletedProcess[str]:
        self.calls.append(cmd)
        verb = cmd[SYSTEMCTL_VERB]
        if verb == "show":
            if "show" in self.fail:
                return subprocess.CompletedProcess(cmd, 1, "", "Failed to connect to bus")
            return subprocess.CompletedProcess(cmd, 0, f"ActiveState={self.state}\nMainPID={self.pid}\n", "")
        if verb in self.fail:
            return subprocess.CompletedProcess(cmd, 1, "", "boom")
        self.state = "active" if verb in ("start", "restart") else "inactive"
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def mutations(self) -> list[str]:
        return [c[SYSTEMCTL_VERB] for c in self.calls if c[SYSTEMCTL_VERB] in ("start", "stop", "restart")]


class UnitLifecycleTest(unittest.TestCase):
    def run_it(self, verb: str, sysctl: FakeSystemctl, ready_code: int = 0, pidfile_daemon: bool = False) -> tuple[int, str, str, list[str]]:
        events: list[str] = []

        def release_pidfile_daemon() -> bool:
            events.append("release")
            return pidfile_daemon

        def ready() -> int:
            events.append("ready")
            return ready_code

        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = run_verb(verb, UnitControl(UNIT, sysctl), name="hsw-editor", url="http://127.0.0.1:1/",
                            release_pidfile_daemon=release_pidfile_daemon, wait_ready=ready)
        return code, out.getvalue(), err.getvalue(), events

    def test_restart_asks_systemd_once_and_spawns_nothing_else(self) -> None:
        sysctl = FakeSystemctl(state="active")
        code, out, _, events = self.run_it("restart", sysctl)
        self.assertEqual(code, 0)
        self.assertEqual(sysctl.mutations(), ["restart"])
        self.assertIn(["systemctl", "--user", "restart", UNIT], sysctl.calls)
        self.assertEqual(events, ["release", "ready"])  # a stray pidfile daemon is stopped first, then the port is awaited
        self.assertIn("restarted", out)

    def test_start_when_stopped_starts_the_unit(self) -> None:
        sysctl = FakeSystemctl(state="inactive")
        code, _, _, events = self.run_it("start", sysctl)
        self.assertEqual(code, 0)
        self.assertEqual(sysctl.mutations(), ["start"])
        self.assertEqual(events, ["release", "ready"])

    def test_start_failure_is_exit_4_and_skips_readiness(self) -> None:
        sysctl = FakeSystemctl(state="inactive", fail=frozenset({"start"}))
        code, _, err, events = self.run_it("start", sysctl)
        self.assertEqual(code, 4)
        self.assertIn(UNIT, err)
        self.assertNotIn("ready", events)

    def test_readiness_failure_code_is_returned(self) -> None:
        code, *_ = self.run_it("restart", FakeSystemctl(state="active"), ready_code=4)
        self.assertEqual(code, 4)

    def test_stop_active_unit_stops_via_systemd(self) -> None:
        sysctl = FakeSystemctl(state="active")
        code, out, _, _ = self.run_it("stop", sysctl)
        self.assertEqual(code, 0)
        self.assertEqual(sysctl.mutations(), ["stop"])
        self.assertIn("stopped", out)

    def test_stop_of_a_crash_looping_unit_still_stops_it(self) -> None:
        sysctl = FakeSystemctl(state="activating")
        code, _, _, _ = self.run_it("stop", sysctl)
        self.assertEqual(code, 0)
        self.assertEqual(sysctl.mutations(), ["stop"])

    def test_stop_with_only_a_pidfile_daemon_stops_it_and_the_unit(self) -> None:
        sysctl = FakeSystemctl(state="failed")
        code, _, _, events = self.run_it("stop", sysctl, pidfile_daemon=True)
        self.assertEqual(code, 0)
        self.assertEqual(events, ["release"])
        self.assertEqual(sysctl.mutations(), ["stop"])

    def test_unreachable_systemd_is_exit_4_for_every_verb(self) -> None:
        for verb in ("start", "stop", "restart", "status"):
            sysctl = FakeSystemctl(fail=frozenset({"show"}))
            code, _, err, events = self.run_it(verb, sysctl)
            self.assertEqual(code, 4, verb)
            self.assertIn("cannot query", err)
            self.assertEqual((sysctl.mutations(), events), ([], []), verb)

    def test_status_of_a_starting_unit_is_running(self) -> None:
        code, out, _, _ = self.run_it("status", FakeSystemctl(state="activating", pid=55))
        self.assertEqual(code, 0)
        self.assertIn("[starting]", out)

    def test_status_of_a_crash_looping_unit_is_not_running(self) -> None:
        # activating (auto-restart) between crashes: MainPID is 0, nothing serves
        code, out, _, _ = self.run_it("status", FakeSystemctl(state="activating", pid=0))
        self.assertEqual(code, 3)
        self.assertIn("no process", out)

    def test_stop_of_a_deactivating_unit_waits_on_systemd(self) -> None:
        sysctl = FakeSystemctl(state="deactivating")
        code, *_ = self.run_it("stop", sysctl)
        self.assertEqual(code, 0)
        self.assertEqual(sysctl.mutations(), ["stop"])

    def test_stop_inactive_unit_is_exit_3(self) -> None:
        sysctl = FakeSystemctl(state="inactive")
        code, _, err, _ = self.run_it("stop", sysctl)
        self.assertEqual(code, 3)
        self.assertEqual(sysctl.mutations(), [])
        self.assertIn("not running", err)

    def test_stop_failure_is_exit_4(self) -> None:
        code, *_ = self.run_it("stop", FakeSystemctl(state="active", fail=frozenset({"stop"})))
        self.assertEqual(code, 4)

    def test_status_reports_the_systemd_main_pid(self) -> None:
        code, out, _, _ = self.run_it("status", FakeSystemctl(state="active", pid=777))
        self.assertEqual(code, 0)
        self.assertIn("pid 777", out)
        self.assertIn("[autostart on]", out)

    def test_status_of_an_inactive_unit_is_exit_3_not_running(self) -> None:
        # the library alone would say "running" for any installed unit
        code, out, _, _ = self.run_it("status", FakeSystemctl(state="inactive"))
        self.assertEqual(code, 3)
        self.assertIn("stopped", out)
        self.assertNotIn("running", out)


class UnitPortTest(unittest.TestCase):
    def write(self, text: str) -> Path:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "unit.service"
        path.write_text(text)
        return path

    def test_reads_the_exec_start_port(self) -> None:
        unit = self.write("[Service]\nExecStart=/usr/bin/python3 /x/hsw_editor.py _serve --port 8794\nRestart=on-failure\n")
        self.assertEqual(unit_port(unit), 8794)

    def test_other_port(self) -> None:
        self.assertEqual(unit_port(self.write("ExecStart=/usr/bin/python3 /x/h.py _serve --port 9100\n")), 9100)

    def test_reads_what_the_service_library_renders(self) -> None:
        for candidate in (os.environ.get("AGENT_TOOLS_LIB", ""), str(Path.home() / "dev/agent-tools/lib")):
            if candidate and (Path(candidate) / "agenttools_service").is_dir():
                sys.path.insert(0, candidate)
                break
        try:
            import agenttools_service
        except ImportError:
            self.skipTest("agenttools_service not importable")
        service = agenttools_service.Service(name="hsw-editor", argv=["/usr/bin/python3", "/x/hsw_editor.py", "_serve", "--port", "9123"], port=9123)
        self.assertEqual(unit_port(self.write(agenttools_service.render_systemd_unit(service))), 9123)

    def test_missing_file_or_port_is_none(self) -> None:
        self.assertIsNone(unit_port(Path("/nonexistent/unit.service")))
        self.assertIsNone(unit_port(self.write("ExecStart=/bin/true\n")))


if __name__ == "__main__":
    unittest.main()
