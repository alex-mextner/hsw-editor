"""A web build counts only when the success stamp exists; index.html alone can be a partial build."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hswlib import doctor  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
WEB_BUILD_SH = REPO_ROOT / "scripts/lib/web-build.sh"
BUILD_SH = REPO_ROOT / "scripts/build-web.sh"


class WebBuildStampTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dist = Path(tmp.name) / "dist"
        self.dist.mkdir()
        patcher = mock.patch.dict(os.environ, {"HSW_EDITOR_WEB_DIST": str(self.dist)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.ctx = doctor.Context(port=1, repo_root=REPO_ROOT, data_dir=Path(tmp.name), lib_error=None, lib_path="")

    def shell_says_present(self, dist: Path | str | None = None) -> bool:
        proc = subprocess.run(["bash", "-c", '. "$1"; web_build_present "$2"', "_", str(WEB_BUILD_SH), str(dist or self.dist)], check=False)
        return proc.returncode == 0

    def test_index_without_stamp_is_a_failed_build(self) -> None:
        (self.dist / "index.html").write_text("<html></html>")
        first = doctor.check_web_build(self.ctx)[0]
        self.assertEqual((first.name, first.level), ("web build", "fail"))
        self.assertIn("bun run build", first.fix)
        self.assertFalse(self.shell_says_present())

    def test_stamped_build_is_ok(self) -> None:
        (self.dist / "index.html").write_text("<html></html>")
        (self.dist / doctor.WEB_BUILD_STAMP).write_text("")
        self.assertEqual(doctor.check_web_build(self.ctx)[0].level, "ok")
        self.assertTrue(self.shell_says_present())

    def test_stamp_without_index_is_not_a_build(self) -> None:
        (self.dist / doctor.WEB_BUILD_STAMP).write_text("")
        self.assertEqual(doctor.check_web_build(self.ctx)[0].level, "fail")
        self.assertFalse(self.shell_says_present())

    def test_missing_dist_is_not_a_build(self) -> None:
        self.assertFalse(self.shell_says_present("/nonexistent/dist"))


class BuildScriptTest(unittest.TestCase):
    """scripts/build-web.sh with a stand-in build command: the stamp exists only after a successful build."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "scripts/lib").mkdir(parents=True)
        (root / "apps/web").mkdir(parents=True)
        shutil.copy(BUILD_SH, root / "scripts/build-web.sh")
        shutil.copy(WEB_BUILD_SH, root / "scripts/lib/web-build.sh")
        self.script = root / "scripts/build-web.sh"
        self.stamp = root / "apps/web/dist" / doctor.WEB_BUILD_STAMP

    def run_build(self, command: str) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, HSW_WEB_BUILD_CMD=command)
        return subprocess.run(["bash", str(self.script)], env=env, capture_output=True, text=True, check=False)

    def test_success_writes_the_stamp(self) -> None:
        self.assertEqual(self.run_build("true").returncode, 0)
        self.assertTrue(self.stamp.exists())

    def test_failure_leaves_no_stamp_even_after_a_good_build(self) -> None:
        self.assertEqual(self.run_build("true").returncode, 0)
        failed = self.run_build("false")
        self.assertNotEqual(failed.returncode, 0)
        self.assertFalse(self.stamp.exists())


if __name__ == "__main__":
    unittest.main()
