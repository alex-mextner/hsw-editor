"""Tiny HTTP client for the hsw-editor daemon (JSON in/out, structured errors)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

from .errors import (
    AgentToolError,
    ConflictError,
    MissingTargetError,
    NetworkError,
    NotRunningError,
    OpRefusedError,
    PermissionDeniedError,
    UsageError,
)

HOST = "127.0.0.1"
TIMEOUT_S = 15.0


class Api:
    def __init__(self, port: int) -> None:
        self.port = port
        self.base = f"http://{HOST}:{port}"

    def request(self, method: str, path: str, body: Any = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"content-type": "application/json", "accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raise self._http_error(exc.code, exc.read(), path) from None
        except urllib.error.URLError as exc:
            raise NotRunningError(
                what=f"hsw-editor is not running on {self.base}",
                why=str(exc.reason),
                fix=f"hsw-editor start --port {self.port}   (or: hsw-editor enable for autostart)",
            ) from None
        except TimeoutError:
            raise NetworkError(
                what=f"hsw-editor on {self.base} did not answer within {TIMEOUT_S:.0f}s",
                fix="hsw-editor status; hsw-editor restart",
            ) from None
        return json.loads(raw) if raw else None

    def _http_error(self, status: int, raw: bytes, path: str) -> AgentToolError:
        code, message, details, payload = "http_error", f"HTTP {status} from {path}", None, {}
        try:
            payload = json.loads(raw)
            error = payload["error"]
            code, message, details = error["code"], error["message"], error.get("details")
        except (ValueError, KeyError, TypeError):
            pass
        why = _format_details(details)
        if status == 404:
            return MissingTargetError(
                what=message, why=why, fix="list the walls: hsw-editor wall list"
            )
        if status == 403:
            return PermissionDeniedError(
                what=message, why="the daemon only accepts loopback Host/Origin", fix=f"use {self.base}"
            )
        if status == 409:
            fix = "re-read the wall (hsw-editor wall show <id>) and retry"
            if code == "rev_conflict":
                fix = f"the wall is at rev {payload.get('currentRev')}: re-read it and retry with --base-rev {payload.get('currentRev')}"
            elif code == "wall_exists":
                fix = "pick another id or omit --id"
            elif code in ("nothing_to_undo", "nothing_to_redo"):
                fix = "nothing to do: the history has no step in that direction"
            return ConflictError(what=message, why=code, fix=fix)
        if status == 422:
            return OpRefusedError(
                what=message, why=why or code, fix="fix the op (see why) or unlock/inspect the item; nothing was applied"
            )
        if status in (400, 413, 415):
            return UsageError(what=message, why=why or code, fix="see docs/api.md for the request shape")
        return AgentToolError(what=message, why=why or code, fix="check the daemon log: hsw-editor status")


def _format_details(details: Any) -> str:
    if details is None:
        return ""
    if isinstance(details, list):
        return "; ".join(str(item) for item in details)
    if isinstance(details, dict):
        return ", ".join(f"{key}={value}" for key, value in details.items())
    return str(details)
