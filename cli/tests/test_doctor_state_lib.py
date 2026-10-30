"""The doctor's state-lib row: the dependency is found wherever Bun's linker put it."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hswlib import doctor  # noqa: E402

PACKAGE = "node_modules/@ultrabricks/state-lib/package.json"


class StateLibCheckTest(unittest.TestCase):
    def check(self, installed_under: str | None) -> doctor.Check:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            if installed_under is not None:
                manifest = repo / installed_under / PACKAGE
                manifest.parent.mkdir(parents=True)
                manifest.write_text("{}")
            ctx = doctor.Context(port=1, repo_root=repo, data_dir=repo / "data", lib_error=None, lib_path="")
            (row,) = doctor.check_state_lib(ctx)
            return row

    def test_isolated_linker_layout_is_ok(self) -> None:
        self.assertEqual(self.check("apps/web").level, "ok")

    def test_hoisted_layout_is_ok(self) -> None:
        self.assertEqual(self.check(".").level, "ok")

    def test_missing_dependency_warns(self) -> None:
        self.assertEqual(self.check(None).level, "warn")


if __name__ == "__main__":
    unittest.main()
