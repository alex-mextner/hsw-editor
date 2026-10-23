"""doctor's bank checks against a fake repo root, a fake ``bun`` shim on PATH and a local health server."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hswlib import doctor  # noqa: E402

# The shim answers `bun scripts/bank/verify.ts [--seed] --json` from files in $FAKE_DIR:
# <kind>.out is stdout and <kind>.code the exit status, where kind is "seed" or "main".
SHIM = """#!/bin/sh
kind=main
for a in "$@"; do [ "$a" = "--seed" ] && kind=seed; done
printf '%s\\n' "$HSW_EDITOR_DATA_DIR" > "$FAKE_DIR/data-dir"
cat "$FAKE_DIR/$kind.out"
exit "$(cat "$FAKE_DIR/$kind.code")"
"""


def report(*roots: dict) -> str:
    return json.dumps({"ok": all(not r["problems"] for r in roots), "roots": list(roots)})


def root(path: str, checked: int, problems: list[str] | None = None) -> dict:
    return {"root": path, "checked": checked, "contentHash": "h", "problems": problems or []}


class BankVerifyTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name)
        self.repo = base / "repo"
        (self.repo / "scripts/bank").mkdir(parents=True)
        (self.repo / "scripts/bank/verify.ts").write_text("// fake\n")
        self.fake = base / "fake"
        self.fake.mkdir()
        bin_dir = base / "bin"
        bin_dir.mkdir()
        shim = bin_dir / "bun"
        shim.write_text(SHIM)
        shim.chmod(shim.stat().st_mode | stat.S_IXUSR)
        env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "FAKE_DIR": str(self.fake)}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop("HSW_BANK_DIR", None)
        os.environ.pop("HSW_EDITOR_DATA_DIR", None)
        self.ctx = doctor.Context(port=1, repo_root=self.repo, data_dir=base / "data", lib_error=None, lib_path="")

    def answer(self, kind: str, code: int, out: str) -> None:
        (self.fake / f"{kind}.out").write_text(out)
        (self.fake / f"{kind}.code").write_text(str(code))

    def rows(self) -> dict[str, doctor.Check]:
        return {c.name: c for c in doctor.check_bank(self.ctx)}

    def test_consistent_bank_is_ok(self) -> None:
        self.answer("main", 0, report(root("/d/bank/gen-2", 42)))
        self.answer("seed", 0, report(root("seed", 3)))
        rows = self.rows()
        self.assertEqual(rows["bank integrity"].level, "ok")
        self.assertEqual(rows["bank integrity"].detail, "42 elements verified in /d/bank/gen-2")
        self.assertEqual(rows["bank seed"].level, "ok")
        self.assertNotIn("bank (served)", rows)

    def test_data_dir_is_passed_only_when_env_has_no_bank_location(self) -> None:
        self.answer("main", 0, report(root("r", 1)))
        self.answer("seed", 0, report(root("s", 1)))
        self.rows()
        self.assertEqual((self.fake / "data-dir").read_text().strip(), str(self.ctx.data_dir))
        with mock.patch.dict(os.environ, {"HSW_BANK_DIR": "/custom"}):
            self.rows()
        self.assertEqual((self.fake / "data-dir").read_text().strip(), "")

    def test_problems_fail_with_first_three(self) -> None:
        problems = ["p1", "p2", "p3", "p4"]
        self.answer("main", 1, report(root("/d/bank/gen-2", 5, problems)))
        self.answer("seed", 0, report(root("seed", 3)))
        row = self.rows()["bank integrity"]
        self.assertEqual(row.level, "fail")
        self.assertIn("4 problem(s)", row.detail)
        self.assertIn("p3", row.detail)
        self.assertNotIn("p4", row.detail)
        self.assertIn("bank:ingest", row.fix)
        self.assertIn("bank:adopt", row.fix)

    def test_seed_exit_3_is_not_ok(self) -> None:
        self.answer("main", 0, report(root("r", 1)))
        self.answer("seed", 3, "")
        row = self.rows()["bank seed"]
        self.assertEqual(row.level, "fail")
        self.assertIn("exited 3", row.detail)

    def test_nothing_built_warns(self) -> None:
        self.answer("main", 3, "")
        self.answer("seed", 0, report(root("seed", 3)))
        row = self.rows()["bank integrity"]
        self.assertEqual(row.level, "warn")
        self.assertIn("seed is served", row.detail)
        self.assertEqual(row.fix, "bun run bank:ingest")

    def test_corrupt_seed_fails(self) -> None:
        self.answer("main", 0, report(root("r", 1)))
        self.answer("seed", 1, report(root("seed", 3, ["missing glb"])))
        row = self.rows()["bank seed"]
        self.assertEqual(row.level, "fail")
        self.assertIn("missing glb", row.detail)
        self.assertEqual(row.fix, "git checkout packages/bank/seed")

    def test_missing_script_warns_and_skips_seed(self) -> None:
        (self.repo / "scripts/bank/verify.ts").unlink()
        rows = self.rows()
        self.assertEqual(list(rows), ["bank integrity"])
        self.assertEqual(rows["bank integrity"].level, "warn")
        self.assertEqual(rows["bank integrity"].fix, "git pull")

    def test_garbage_output_warns(self) -> None:
        self.answer("main", 0, "not json at all\n")
        self.answer("seed", 0, "{}\n")
        rows = self.rows()
        self.assertEqual(rows["bank integrity"].level, "warn")
        self.assertIn("unparsable", rows["bank integrity"].detail)
        self.assertEqual(rows["bank seed"].level, "warn")

    def test_timeout_warns(self) -> None:
        with mock.patch.object(doctor.subprocess, "run", side_effect=subprocess.TimeoutExpired("bun", 120)):
            rows = self.rows()
        self.assertEqual(rows["bank integrity"].level, "warn")
        self.assertIn("timed out", rows["bank integrity"].detail)

    def test_bun_missing_warns(self) -> None:
        with mock.patch.object(doctor, "_which", return_value=None):
            rows = self.rows()
        self.assertEqual(rows["bank integrity"].level, "warn")
        self.assertIn("bun not found", rows["bank integrity"].detail)


class BankServedTest(unittest.TestCase):
    def serve(self, bank_status: int, bank_body: dict | None) -> int:
        routes = {"/api/health": (200, {"name": "hsw-editor", "version": "1"})}
        if bank_body is not None:
            routes["/api/bank/health"] = (bank_status, bank_body)

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                status, body = routes.get(self.path, (404, {"error": "not found"}))
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: object) -> None:
                pass

        server = HTTPServer((doctor.HOST, 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def check(self, port: int) -> doctor.Check | None:
        ctx = doctor.Context(port=port, repo_root=Path("."), data_dir=Path("."), lib_error=None, lib_path="")
        return doctor._bank_served(ctx)

    def test_healthy(self) -> None:
        port = self.serve(200, {"ok": True, "served": {"root": "/d/bank/gen-7", "contentHash": "h"}, "elements": 12,
                                "unavailable": 2, "generations": ["gen-7"], "rejected": []})
        row = self.check(port)
        assert row is not None
        self.assertEqual(row.level, "ok")
        self.assertEqual(row.detail, "serving 12 elements (generation gen-7), 2 unavailable")

    def test_rejected_generation_fails(self) -> None:
        port = self.serve(200, {"ok": True, "served": {"root": "/d/bank/gen-6", "contentHash": "h"}, "elements": 12,
                                "unavailable": 0, "generations": [], "rejected": [{"root": "/d/bank/gen-7", "problems": ["glb missing", "x"]}]})
        row = self.check(port)
        assert row is not None
        self.assertEqual(row.level, "fail")
        self.assertEqual(row.detail, "/d/bank/gen-7: glb missing")
        self.assertIn("hsw-editor restart", row.fix)

    def test_503_with_body_fails(self) -> None:
        port = self.serve(503, {"ok": False, "served": None, "elements": 0, "unavailable": 0, "generations": [], "rejected": []})
        row = self.check(port)
        assert row is not None
        self.assertEqual(row.level, "fail")

    def test_404_gives_no_row(self) -> None:
        self.assertIsNone(self.check(self.serve(404, None)))

    def test_unreachable_gives_no_row(self) -> None:
        self.assertIsNone(self.check(1))


if __name__ == "__main__":
    unittest.main()
