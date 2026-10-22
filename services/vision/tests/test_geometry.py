"""Grid/cell helpers (mirror of packages/core grid.ts) and the fit-mesh -> item-frame transform."""

from __future__ import annotations

import sys
from types import SimpleNamespace

import numpy as np
import pytest

from hsw_vision.confidence import fit_confidence
from hsw_vision.geometry import Board, cell_center, nearest_cell, rz
from hsw_vision.stages import fit as stage_fit


def test_cell_center_matches_the_core_formula() -> None:
    board = Board()
    assert cell_center(board, 0, 0) == (pytest.approx(10.2191), pytest.approx(11.8))
    assert cell_center(board, 1, 0) == (pytest.approx(30.6573), pytest.approx(23.6))  # odd columns are half a row up


def test_nearest_cell_round_trips_every_cell_centre() -> None:
    board = Board(cols=10, rows=8)
    for col in range(board.cols):
        for row in range(board.rows):
            x, y = cell_center(board, col, row)
            assert nearest_cell(board, x + 1.0, y - 1.0) == (col, row)


def test_nearest_cell_clamps_to_the_board() -> None:
    board = Board(cols=4, rows=3)
    assert nearest_cell(board, -500, -500) == (0, 0)
    col, row = nearest_cell(board, 5000, 5000)
    assert (col, row) == (3, 2)


def box() -> tuple[np.ndarray, np.ndarray]:
    xs, ys, zs = (-100, 100), (-10, 10), (-6, 6)
    vertices = np.array([[x, y, z] for x in xs for y in ys for z in zs], dtype=float)
    return vertices, np.array([[0, 1, 2], [1, 2, 3]])


def fit_with_pose(r0: np.ndarray, centre: list[float]) -> dict[str, object]:
    return {"pose": {"R0": r0.tolist(), "t_mm": centre}}


def patch_render(monkeypatch: pytest.MonkeyPatch, r0: np.ndarray, centre: list[float]) -> None:
    local, faces = box()
    world = local @ r0.T + np.array(centre)
    fake = SimpleNamespace(mesh_from_fit=lambda fit: (world, faces))
    monkeypatch.setitem(sys.modules, "threed_vision.render", fake)
    import threed_vision

    monkeypatch.setattr(threed_vision, "render", fake, raising=False)


def test_planar_fit_heading_goes_to_rot_z_and_the_mesh_stays_in_the_object_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    r0 = rz(30.0)
    patch_render(monkeypatch, r0, [120.0, 80.0, 6.0])
    vertices, _, heading, centre = stage_fit.local_mesh(fit_with_pose(r0, [120.0, 80.0, 6.0]))
    assert heading == pytest.approx(30.0)
    assert centre.tolist() == [120.0, 80.0, 6.0]
    np.testing.assert_allclose(vertices, box()[0], atol=1e-9)  # X along the length, centred on the origin


def test_tilt_is_baked_into_the_mesh_and_only_the_heading_is_left_to_the_item(monkeypatch: pytest.MonkeyPatch) -> None:
    c, s = np.cos(np.radians(20)), np.sin(np.radians(20))
    tilt = np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    r0 = rz(-40.0) @ tilt
    patch_render(monkeypatch, r0, [0.0, 0.0, 20.0])
    vertices, _, heading, _ = stage_fit.local_mesh(fit_with_pose(r0, [0.0, 0.0, 20.0]))
    assert heading == pytest.approx(-40.0)
    np.testing.assert_allclose(vertices, box()[0] @ tilt.T, atol=1e-9)
    # item pose (rotZ = heading) applied to those vertices reproduces the world mesh around the centre
    world = vertices @ rz(heading).T + np.array([0.0, 0.0, 20.0])
    np.testing.assert_allclose(world, box()[0] @ r0.T + np.array([0.0, 0.0, 20.0]), atol=1e-9)


def test_glb_is_a_valid_binary_gltf_in_the_wall_frame(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:  # type: ignore[no-untyped-def]
    pytest.importorskip("trimesh")
    r0 = rz(15.0)
    patch_render(monkeypatch, r0, [10.0, 20.0, 6.0])
    pose = stage_fit.write_glb(fit_with_pose(r0, [10.0, 20.0, 6.0]), tmp_path / "m" / "fit.glb")
    data = (tmp_path / "m" / "fit.glb").read_bytes()
    assert data[:4] == b"glTF" and pose["heading_deg"] == pytest.approx(15.0)
    import trimesh

    scene = trimesh.load(tmp_path / "m" / "fit.glb")
    bounds = scene.bounds
    assert bounds[1][0] - bounds[0][0] == pytest.approx(200.0, abs=0.01)  # mm, length along x


def test_confidence_helpers_and_dimension_normalisation() -> None:
    assert stage_fit.normalise_fixed_dims({"length": 160, "width": 7, "thickness_mm": 4}) == {
        "length_mm": 160.0,
        "max_width_mm": 7.0,
        "thickness_mm": 4.0,
    }
    assert stage_fit.normalise_fixed_dims(None) is None
    with pytest.raises(Exception, match="unknown dimension"):
        stage_fit.normalise_fixed_dims({"height": 3})
    with pytest.raises(Exception, match="positive"):
        stage_fit.normalise_fixed_dims({"length": 0})


def test_nan_confidence_is_zero_never_one() -> None:
    nan = float("nan")
    assert fit_confidence({"confidence": {"heldout_iou": nan}}, 0.6) == 0.0
    assert fit_confidence({"confidence": {"train_min_iou": nan, "n_views": 3}}, 0.6) == 0.0
