"""The CLI only DESCRIBES the service to agenttools_service; the lifecycle itself is the library's."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

CLI_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CLI_DIR))

import hsw_editor  # noqa: E402


def service_lib():
    try:
        return hsw_editor.load_service_lib()
    except SystemExit as exc:
        raise unittest.SkipTest(str(exc)) from exc


class ServiceWiringTest(unittest.TestCase):
    def test_default_port_keeps_the_installed_unit_and_pid_names(self) -> None:
        service_lib()
        svc = hsw_editor.build_service(hsw_editor.DEFAULT_PORT)
        self.assertEqual(svc.systemd_unit_name, "agenttools-hsw-editor-hsw-editor")
        self.assertEqual(svc.pidfile.name, "hsw-editor.pid")
        self.assertEqual(svc.pidfile.parent.name, "hsw-editor")
        self.assertEqual(svc.cli, "hsw-editor")

    def test_another_port_is_its_own_service(self) -> None:
        service_lib()
        throwaway = hsw_editor.build_service(18794)
        default = hsw_editor.build_service(hsw_editor.DEFAULT_PORT)
        self.assertEqual(throwaway.systemd_unit_name, "agenttools-hsw-editor-hsw-editor-18794")
        self.assertNotEqual(throwaway.pidfile, default.pidfile)
        self.assertNotEqual(throwaway.logfile, default.logfile)
        self.assertEqual(throwaway.cli, "hsw-editor --port 18794")

    def test_argv_pins_port_and_data_dir_so_a_unit_keeps_its_home(self) -> None:
        service_lib()
        with mock.patch.dict("os.environ", {"HSW_EDITOR_HOME": "/tmp/hsw-wiring-home"}):
            svc = hsw_editor.build_service(18794)
        self.assertEqual(svc.argv[2:], ("_serve", "--port", "18794", "--home", "/tmp/hsw-wiring-home"))

    def test_start_waits_for_hsw_editor_to_answer(self) -> None:
        service_lib()
        svc = hsw_editor.build_service(18794)
        self.assertEqual(svc.ready_timeout, hsw_editor.READY_TIMEOUT_S)
        with mock.patch.object(hsw_editor, "health", return_value={"ok": True, "name": "hsw-editor"}):
            self.assertTrue(svc.health_check())
        with mock.patch.object(hsw_editor, "health", return_value={"ok": True, "name": "something-else"}):
            self.assertFalse(svc.health_check())
        with mock.patch.object(hsw_editor, "health", return_value=None):
            self.assertFalse(svc.health_check())

    def test_lifecycle_verbs_are_all_the_librarys(self) -> None:
        lib = service_lib()
        parser = hsw_editor.build_parser()
        for verb in hsw_editor.LIFECYCLE_VERBS:
            args = parser.parse_args([verb])
            self.assertEqual(args._service_action, verb)
        self.assertEqual(set(hsw_editor.LIFECYCLE_VERBS), set(lib.SUBCOMMANDS))


if __name__ == "__main__":
    unittest.main()
