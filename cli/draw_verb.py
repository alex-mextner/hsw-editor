"""`hsw-editor draw ...`: thin exec of the Bun draw CLI (`apps/server/src/draw/cli.ts`).

Kept separate from hsw_editor.py so the verb table only needs one additive line:
`register_verb("draw", draw_verb.handle, draw_verb.configure)`.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DRAW_CLI = REPO_ROOT / "apps" / "server" / "src" / "draw" / "cli.ts"
EXIT_USAGE = 2  # `hswlib.errors.EXIT_USAGE`: bad arguments
VERBS = ("status", "doctor", "login", "stop", "settings", "run")


def _bun() -> str:
    bun = shutil.which("bun") or str(Path.home() / ".local/bin/bun")
    if not Path(bun).exists():
        raise SystemExit("hsw-editor: bun not found (expected on PATH or ~/.local/bin/bun)")
    return bun


def configure(subs: Any) -> None:
    parser = subs.add_parser(
        "draw",
        help=f"draw missing views of an object: {' | '.join(VERBS)}",
        description="Draw backends for missing views (docs/draw.md). status [--probe] [--json]: which backends are usable "
        "and the one-time steps for the rest. doctor: status with live probes. login chatgpt: one-time login in the dedicated "
        "browser profile. stop: stop that browser. settings [auto|draw-cli|omp|chatgpt-browser|manual]. run [--backend id]: one JSON "
        "request on stdin, one JSON result on stdout.",
    )
    parser.add_argument("draw_args", nargs=argparse.REMAINDER, help="verb and its arguments (see docs/draw.md)")


def handle(args: argparse.Namespace) -> int:
    return run(list(getattr(args, "draw_args", [])))


def run(args: list[str]) -> int:
    """Run `draw <args...>`; stdin/stdout/stderr pass through (the `run` verb is a JSON pipe)."""
    if not args or args[0] not in VERBS:
        print(f"usage: hsw-editor draw {'|'.join(VERBS)} ...", file=sys.stderr)
        return EXIT_USAGE
    return subprocess.call([_bun(), str(DRAW_CLI), *args], cwd=REPO_ROOT, env=os.environ.copy())

