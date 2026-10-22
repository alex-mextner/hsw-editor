"""Idempotent result cache: key = image sha256 + stage + canonical parameter hash (+ library/schema version).

Results live under the wall directory (`<wall>/vision/<image-sha16>/<stage>-<params-hash16>.json`, mask PNGs and
meshes next to it), so deleting a wall deletes its cache and re-running the same request on the same photo returns
the stored result without touching a model. A result that lists files (`_files`, paths relative to the image
directory) is a miss when one of them has disappeared.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1


def params_hash(params: Any, *, version: str = "") -> str:
    """Stable hash of JSON-able params (key order and float repr independent of the caller)."""
    canonical = json.dumps(
        {"v": SCHEMA_VERSION, "lib": version, "p": params}, sort_keys=True, separators=(",", ":"), default=str
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


class ResultCache:
    def __init__(self, root: str | Path, *, version: str = "") -> None:
        self.root = Path(root)
        self.version = version
        self.hits = 0
        self.misses = 0

    def image_dir(self, image_sha: str) -> Path:
        return self.root / image_sha[:16]

    def result_path(self, image_sha: str, stage: str, params: Any) -> Path:
        digest = params_hash(params, version=self.version)[:16]
        return self.image_dir(image_sha) / f"{stage}-{digest}.json"

    def get(self, image_sha: str, stage: str, params: Any) -> dict[str, Any] | None:
        path = self.result_path(image_sha, stage, params)
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(stored, dict):
            return None
        directory = self.image_dir(image_sha)
        for rel in stored.get("_files", []):
            if not (directory / rel).is_file():
                return None
        return stored

    def put(self, image_sha: str, stage: str, params: Any, result: dict[str, Any]) -> Path:
        path = self.result_path(image_sha, stage, params)
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(result, handle, separators=(",", ":"))
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        return path

    def get_or_compute(
        self,
        image_sha: str,
        stage: str,
        params: Any,
        compute: Callable[[], dict[str, Any]],
        *,
        refresh: bool = False,
    ) -> tuple[dict[str, Any], bool]:
        """`(result, cached)`. `compute` runs only on a miss (or `refresh`); its result must be JSON-able."""
        if not refresh:
            stored = self.get(image_sha, stage, params)
            if stored is not None:
                self.hits += 1
                return stored, True
        self.misses += 1
        result = compute()
        self.put(image_sha, stage, params, result)
        return result, False
