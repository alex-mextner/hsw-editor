"""`hsw-editor draw ...` is a registered verb (it was `invalid choice: 'draw'`) and execs the Bun draw CLI with the verb's arguments."""

from __future__ import annotations

import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import draw_verb  # noqa: E402
import hsw_editor  # noqa: E402


class DrawVerbTest(unittest.TestCase):
    def test_draw_is_a_top_level_verb_with_the_passthrough_arguments(self) -> None:
        args = hsw_editor.build_parser().parse_args(["draw", "status", "--probe", "--json"])
        self.assertEqual(args.verb, "draw")
        self.assertEqual(args.draw_args, ["status", "--probe", "--json"])

    def test_dispatch_execs_the_bun_draw_cli(self) -> None:
        args = hsw_editor.build_parser().parse_args(["draw", "settings", "manual"])
        with mock.patch.object(draw_verb, "_bun", return_value="/fake/bun"), mock.patch.object(
            draw_verb.subprocess, "call", return_value=7
        ) as call:
            self.assertEqual(hsw_editor.dispatch(args), 7)
        command = call.call_args.args[0]
        self.assertEqual(command, ["/fake/bun", str(draw_verb.DRAW_CLI), "settings", "manual"])

    def test_unknown_draw_verb_is_a_usage_error_not_an_exec(self) -> None:
        with mock.patch.object(draw_verb.subprocess, "call") as call, contextlib.redirect_stderr(io.StringIO()) as usage:
            self.assertEqual(draw_verb.run(["frobnicate"]), 2)
            self.assertEqual(draw_verb.run([]), 2)
        self.assertIn("usage: hsw-editor draw status|doctor", usage.getvalue())
        call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
