"""Result-file helpers: atomic writes (a reader never sees a half-written file) and plain copies."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np


def write_png(path: Path, image: np.ndarray) -> None:
    """RGB or RGBA array -> PNG."""
    import cv2

    path.parent.mkdir(parents=True, exist_ok=True)
    code = cv2.COLOR_RGBA2BGRA if image.shape[2] == 4 else cv2.COLOR_RGB2BGR
    cv2.imwrite(str(path), cv2.cvtColor(np.ascontiguousarray(image), code))


def _atomic(path: Path, suffix: str, write: Any, mode: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=suffix)
    try:
        with os.fdopen(fd, mode) as handle:
            write(handle)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def save_npy(path: Path, array: np.ndarray) -> None:
    """`np.save` as float32 without pickle, atomically."""
    _atomic(path, ".npy", lambda handle: np.save(handle, array.astype(np.float32), allow_pickle=False), "wb")


def write_json(path: Path, value: Any) -> None:
    def dump(handle: Any) -> None:
        json.dump(value, handle, indent=2, default=str)
        handle.write("\n")

    _atomic(path, ".json", dump, "w")


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
