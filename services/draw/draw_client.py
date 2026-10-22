"""Python caller for the `draw` JSON CLI (contract: packages/draw/src/contract.ts). Stdlib only.

    from draw_client import draw
    res = draw(backend="chatgpt-browser", prompt="...", refs=["/abs/a.png"], out_dir="/abs/out")
    if res["ok"]: paths = [i["path"] for i in res["images"]]
    else: code = res["error"]["code"]   # invalid_request|login_required|quota_exhausted|challenge|timeout|backend_unavailable|refused|manual_pending
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

DRAW_CLI = Path(__file__).resolve().parents[2] / "apps" / "server" / "src" / "draw" / "cli.ts"
# Mirrors DRAW_ERROR_EXIT_CODES in packages/draw/src/contract.ts (the source of truth).
EXIT_CODES = {2: "invalid_request", 3: "login_required", 4: "quota_exhausted", 5: "challenge",
              6: "timeout", 7: "backend_unavailable", 8: "refused", 10: "manual_pending"}
EXIT_CODE_OF = {name: code for code, name in EXIT_CODES.items()}


def draw(*, backend: str = "auto", prompt: str, out_dir: str, refs: list[str] | None = None, n: int = 1,
         size: str = "1024x1024", tag: str | None = None, timeout_ms: int | None = None,
         bun: str = "bun", env: dict[str, str] | None = None) -> dict:
    request = {"version": 1, "prompt": prompt, "refs": [{"path": os.path.abspath(r)} for r in refs or []],
               "n": n, "size": size, "outDir": os.path.abspath(out_dir)}
    if tag:
        request["tag"] = tag
    if timeout_ms:
        request["timeoutMs"] = timeout_ms
    proc = subprocess.run([bun, str(DRAW_CLI), "run", "--backend", backend], input=json.dumps(request), text=True,
                          capture_output=True, env={**os.environ, **(env or {})},
                          timeout=(timeout_ms or 300_000) / 1000 + 120)
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    expected = 0 if result["ok"] else EXIT_CODE_OF[result["error"]["code"]]
    if proc.returncode != expected:
        raise RuntimeError(f"draw exit {proc.returncode} does not match result ({expected}): {proc.stderr[-300:]}")
    return result


if __name__ == "__main__":
    print(json.dumps(draw(backend=sys.argv[1], prompt=sys.argv[2], out_dir=sys.argv[3], refs=sys.argv[4:]), indent=1))
