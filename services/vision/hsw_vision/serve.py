"""Run the sidecar: loopback TCP (default 127.0.0.1:8795, a free port if taken) or an optional unix socket.

The chosen endpoint is written to the state file (`config.state_path`) so the Bun VisionClient and `hsw-editor doctor`
can find it; the file is removed on shutdown.
"""

from __future__ import annotations

import json
import os
import socket
import time
from pathlib import Path

from hsw_vision.config import VisionConfig


def port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def pick_port(host: str, preferred: int) -> int:
    """`preferred` when free, else an OS-assigned free port (recorded in the state file)."""
    if port_is_free(host, preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return int(sock.getsockname()[1])


def write_state(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)


def serve(config: VisionConfig) -> None:
    import uvicorn

    from hsw_vision.app import create_app

    config.apply_to_environment()

    def cleanup() -> None:
        config.state_path.unlink(missing_ok=True)
        if config.socket_path is not None:
            config.socket_path.unlink(missing_ok=True)

    app = create_app(config=config, on_shutdown=cleanup)
    started = time.time()
    if config.socket_path is not None:
        config.socket_path.parent.mkdir(parents=True, exist_ok=True)
        config.socket_path.unlink(missing_ok=True)
        endpoint: dict[str, object] = {"socket": str(config.socket_path)}
        server_kwargs: dict[str, object] = {"uds": str(config.socket_path)}
    else:
        port = pick_port(config.host, config.port)
        endpoint = {"url": f"http://{config.host}:{port}", "host": config.host, "port": port}
        server_kwargs = {"host": config.host, "port": port}
    write_state(config.state_path, {"pid": os.getpid(), "startedAt": started, **endpoint})
    try:
        uvicorn.run(app, log_level="info", **server_kwargs)  # type: ignore[arg-type]
    finally:
        cleanup()
