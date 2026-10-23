"""Tiny HTTP client for the hsw-editor daemon (JSON in/out, multipart upload, structured errors)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from pathlib import Path
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
UPLOAD_TIMEOUT_S = 120.0  # a 100 MB mesh over loopback plus the server's magic sniffing


class Api:
    def __init__(self, port: int) -> None:
        self.port = port
        self.base = f"http://{HOST}:{port}"

    def request(
        self, method: str, path: str, body: Any = None, timeout: float = TIMEOUT_S
    ) -> Any:
        data = None if body is None else json.dumps(body).encode()
        headers = {"content-type": "application/json", "accept": "application/json"}
        return self._send(method, path, data, headers, TIMEOUT_S)

    def upload(self, path: str, file: Path, fields: dict[str, str] | None = None) -> Any:
        """POST ``file`` as multipart field ``file`` (plus text ``fields``); longer timeout than ``request``."""
        boundary = f"----hsw{uuid.uuid4().hex}"
        parts: list[bytes] = []
        for key, value in (fields or {}).items():
            parts.append(f'--{boundary}\r\ncontent-disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        # the name goes into a quoted header value: strip what could end the quote or the line
        filename = file.name.replace('"', "_").replace("\r", "_").replace("\n", "_")
        parts.append(
            (
                f'--{boundary}\r\ncontent-disposition: form-data; name="file"; filename="{filename}"\r\n'
                "content-type: application/octet-stream\r\n\r\n"
            ).encode()
        )
        parts.append(file.read_bytes())
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        headers = {"content-type": f"multipart/form-data; boundary={boundary}", "accept": "application/json"}
        return self._send("POST", path, b"".join(parts), headers, UPLOAD_TIMEOUT_S)

    def _send(self, method: str, path: str, data: bytes | None, headers: dict[str, str], timeout: float) -> Any:
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
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
                what=f"hsw-editor on {self.base} did not answer within {timeout:.0f}s",
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
        bank_error = _bank_error(code, message, why, details)
        if bank_error is not None:
            return bank_error
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


def _bank_error(code: str, message: str, why: str, details: Any) -> AgentToolError | None:
    """Errors of the user-element routes (docs/api.md): specific fix hints, and 422 mesh_unreadable is a usage error."""
    if code == "unsupported_media_type":
        return UsageError(what=message, why=why or code, fix="supported formats: .stl .glb .3mf")
    if code == "payload_too_large":
        return UsageError(what=message, why=why or code, fix="the limit is 100 MB: simplify or decimate the mesh")
    if code == "mesh_unreadable":
        return UsageError(
            what=message,
            why=why or code,
            fix="re-export the mesh (a binary or ASCII STL, a GLB with triangle meshes, or a 3MF) and try again",
        )
    if code == "converter_unavailable":
        return AgentToolError(
            what=message,
            why=why or code,
            fix="run: hsw-editor doctor   (the mesh converter needs `uv`; install it and restart the daemon)",
        )
    if code == "element_not_found":
        return MissingTargetError(what=message, why=why, fix="list the user elements: hsw-editor bank list")
    if code == "element_in_use":
        return ConflictError(what=message, why=_format_walls(details) or code, fix="remove the element from those walls, or pass --force")
    return None


def _format_walls(details: Any) -> str:
    """`{walls: [{wallId, items}]}` of an element_in_use conflict as `wall a (3 items); wall b (1 item)`."""
    if not isinstance(details, dict) or not isinstance(details.get("walls"), list):
        return ""
    parts: list[str] = []
    for entry in details["walls"]:
        if not isinstance(entry, dict):
            continue
        items = entry.get("items")
        count = len(items) if isinstance(items, list) else items
        parts.append(f"wall {entry.get('wallId')} ({count} items)")
    return "used by " + "; ".join(parts) if parts else ""


def _format_details(details: Any) -> str:
    if details is None:
        return ""
    if isinstance(details, list):
        return "; ".join(str(item) for item in details)
    if isinstance(details, dict):
        return ", ".join(f"{key}={value}" for key, value in details.items())
    return str(details)
