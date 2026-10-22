"""`hsw-editor draw ...` and `hsw-editor doctor draw`: thin exec of the Bun draw CLI.

Kept separate from hsw_editor.py so the verb table only needs two additive lines:
register `draw` -> `draw_verb.run`, and `doctor draw` -> `draw_verb.doctor`.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DRAW_CLI = REPO_ROOT / "apps" / "server" / "src" / "draw" / "cli.ts"
VERBS = ("status", "doctor", "login", "stop", "settings", "run")


def _bun() -> str:
    bun = shutil.which("bun") or str(Path.home() / ".local/bin/bun")
    if not Path(bun).exists():
        raise SystemExit("hsw-editor: bun not found (expected on PATH or ~/.local/bin/bun)")
    return bun


def run(args: list[str]) -> int:
    """Run `draw <args...>`; stdin/stdout/stderr pass through (the `run` verb is a JSON pipe)."""
    if not args or args[0] not in VERBS:
        print(f"usage: hsw-editor draw {'|'.join(VERBS)} ...")
        return 64
    return subprocess.call([_bun(), str(DRAW_CLI), *args], cwd=REPO_ROOT, env=os.environ.copy())


def doctor() -> int:
    """Print backend status with live probes and the exact one-time steps for anything missing."""
    return run(["doctor"])
