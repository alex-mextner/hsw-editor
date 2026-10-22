"""Camera/plane/cell helpers shared by the stages and the proposal builder.

World frame = the wall frame of `packages/core` (mm, x right, y up, z out of the wall / towards the camera).
Cameras follow the library convention: `X_cam = R @ X_world + t`, OpenCV axes (x right, y down, z forward), pixels.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np

# Source of the pitches: HSW panel calibration (`packages/core/src/grid.ts`: HSW_COL_PITCH_MM / HSW_ROW_PITCH_MM).
HSW_COL_PITCH_MM = 20.4382
HSW_ROW_PITCH_MM = 23.6


@dataclass(frozen=True)
class Board:
    cols: int = 48
    rows: int = 32
    col_pitch_mm: float = HSW_COL_PITCH_MM
    row_pitch_mm: float = HSW_ROW_PITCH_MM

    @classmethod
    def from_json(cls, raw: dict[str, Any] | None) -> Board:
        if not raw:
            return cls()
        return cls(
            cols=int(raw.get("cols", 48)),
            rows=int(raw.get("rows", 32)),
            col_pitch_mm=float(raw.get("colPitchMm", HSW_COL_PITCH_MM)),
            row_pitch_mm=float(raw.get("rowPitchMm", HSW_ROW_PITCH_MM)),
        )


def cell_center(board: Board, col: int, row: int) -> tuple[float, float]:
    stagger = 0.5 if (col & 1) == 1 else 0.0
    return (col + 0.5) * board.col_pitch_mm, (row + 0.5 + stagger) * board.row_pitch_mm


def nearest_cell(board: Board, x: float, y: float) -> tuple[int, int]:
    """Nearest cell to a wall point, clamped to the board (same rule as `nearestCell` in `grid.ts`)."""
    guess = round(x / board.col_pitch_mm - 0.5)
    best = (0, 0)
    best_d = math.inf
    for col in range(guess - 1, guess + 2):
        c = min(max(col, 0), board.cols - 1)
        stagger = 0.5 if (c & 1) == 1 else 0.0
        r = min(max(round(y / board.row_pitch_mm - 0.5 - stagger), 0), board.rows - 1)
        cx, cy = cell_center(board, c, r)
        d = (cx - x) ** 2 + (cy - y) ** 2
        if d < best_d:
            best_d = d
            best = (c, r)
    return best


@dataclass(frozen=True)
class Camera:
    """A calibrated view of the wall (or table) plane z = 0 of the world frame."""

    K: np.ndarray
    R: np.ndarray
    t: np.ndarray
    #: 3x3 homography photo px -> plane mm (grid calibrations); None for a pure scale.
    h_px_to_plane: np.ndarray | None
    mm_per_px: float
    plane_depth_mm: float
    source: str

    def view(self, mask: np.ndarray) -> dict[str, Any]:
        """The `views[]` entry the library's fitters take."""
        return {"mask": mask, "K": self.K, "R": self.R, "t": self.t}

    def px_to_plane_mm(self, pts_px: np.ndarray) -> np.ndarray:
        """Photo pixels (N x 2) -> plane mm (N x 2), y up."""
        pts = np.asarray(pts_px, dtype=float).reshape(-1, 2)
        if self.h_px_to_plane is not None:
            h = self.h_px_to_plane
            homog = np.c_[pts, np.ones(len(pts))] @ h.T
            return homog[:, :2] / homog[:, 2:3]
        cx, cy = float(self.K[0, 2]), float(self.K[1, 2])
        return np.c_[(pts[:, 0] - cx) * self.mm_per_px, -(pts[:, 1] - cy) * self.mm_per_px]

    def depth_at(self, pt_px: np.ndarray) -> float:
        """Camera-axis depth (mm) of the plane point seen at `pt_px`."""
        x, y = self.px_to_plane_mm(np.asarray(pt_px, dtype=float).reshape(1, 2))[0]
        return float(self.R[2, 0] * x + self.R[2, 1] * y + self.t[2])


def camera_from_calibration(calibration: dict[str, Any]) -> Camera:
    """Build the camera from a calibrate-stage result (`stages.calibrate.calibrate`)."""
    cam = calibration["camera"]
    h = calibration.get("homography_px_to_plane_mm")
    return Camera(
        K=np.asarray(cam["K"], dtype=float),
        R=np.asarray(cam["R"], dtype=float),
        t=np.asarray(cam["t_mm"], dtype=float),
        h_px_to_plane=np.asarray(h, dtype=float).reshape(3, 3) if h else None,
        mm_per_px=float(calibration["mm_per_px"]),
        plane_depth_mm=float(calibration["plane_depth_mm"]),
        source=str(calibration.get("method", "")),
    )


def fronto_parallel_extrinsics(plane_depth_mm: float) -> tuple[np.ndarray, np.ndarray]:
    """Camera looking straight down at the plane z = 0 from `plane_depth_mm`; world origin = principal-point ray."""
    return np.diag([1.0, -1.0, -1.0]), np.array([0.0, 0.0, float(plane_depth_mm)])


def rotation_z_deg(r: np.ndarray) -> float:
    """Heading (deg, about the wall normal) of an object->world rotation's x axis."""
    return math.degrees(math.atan2(r[1, 0], r[0, 0]))


def rz(deg: float) -> np.ndarray:
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
