"""Request models shared by the HTTP API, the CLI and the orchestrator (pydantic = the single JSON contract)."""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


Point = tuple[float, float]


class CalibrateParams(Strict):
    """How to establish scale. `auto`: grid detector, then two-point, then reference, then `mm_per_px`."""

    mode: Literal["auto", "grid", "two-point", "reference", "manual"] = "auto"
    points_px: tuple[Point, Point] | None = None
    distance_mm: float | None = Field(default=None, gt=0)
    #: Instance id (of the segmentation of this photo) with a known length, e.g. a recognised bank tool.
    reference_instance: int | None = None
    reference_length_mm: float | None = Field(default=None, gt=0)
    mm_per_px: float | None = Field(default=None, gt=0)
    f_px: float | None = Field(default=None, gt=0)
    f_ratio: float | None = Field(default=None, gt=0)
    grid_pitch_mm: tuple[float, float] | None = None


class SegmentParams(Strict):
    method: Literal["sam2", "sam2-dense", "u2net"] = "sam2"
    fill: Literal["owlv2", "none"] = "owlv2"
    reject_bg: bool = True
    points_per_side: int = Field(default=32, ge=8, le=128)


class ImageRef(Strict):
    #: Fields that say where/how a request is served, not what it computes: they never enter a result's identity.
    TRANSPORT_FIELDS: ClassVar[frozenset[str]] = frozenset({"image_path", "work_dir", "refresh"})

    image_path: Path
    #: Result cache root (the wall's `vision/` directory); defaults to the service cache dir.
    work_dir: Path | None = None
    refresh: bool = False


class CalibrateRequest(ImageRef):
    calibrate: CalibrateParams = Field(default_factory=CalibrateParams)
    segment: SegmentParams = Field(default_factory=SegmentParams)


class SegmentRequest(ImageRef):
    segment: SegmentParams = Field(default_factory=SegmentParams)
    include_masks: bool = False


class RecogniseRequest(ImageRef):
    segment: SegmentParams = Field(default_factory=SegmentParams)
    instances: list[int] | None = None
    bank_index: dict[str, Any] | None = None
    #: Categories file / comma list (anything `threed_vision.recognise.load_categories` reads, e.g. a JSON list of ToolClass
    #: objects) instead of the bank index's tool classes.
    categories: str | None = None
    topk: int = Field(default=5, ge=1, le=20)


class FitRequest(ImageRef):
    calibrate: CalibrateParams = Field(default_factory=CalibrateParams)
    segment: SegmentParams = Field(default_factory=SegmentParams)
    instance: int
    #: User dimension overrides in mm (`length`, `width`, `thickness`): hard constraints.
    fixed_dims: dict[str, float] | None = None
    template: Literal["lathe", "flat", "box"] | None = None
    planar: bool = True
    max_tries: int = Field(default=3, ge=1, le=8)
    device: Literal["auto", "cpu", "cuda"] | None = None
    seed: int = 0


class MultiviewRequest(Strict):
    """Check a stored fit against other photos of the same object (mask + calibrated camera each)."""

    fit: dict[str, Any]
    views: list[dict[str, Any]] = Field(default_factory=list)
    flag_below: float = Field(default=0.75, ge=0, le=1)


class PhotoRequest(ImageRef):
    """What `photo_to_wall` and `photo_to_objects` share: calibrate -> segment -> recognise -> fit per object."""

    calibrate: CalibrateParams = Field(default_factory=CalibrateParams)
    segment: SegmentParams = Field(default_factory=SegmentParams)
    #: Per instance id (as string) dimension overrides in mm.
    fixed_dims: dict[str, dict[str, float]] = Field(default_factory=dict)
    #: Only these segmentation instance ids (default: every plausible object).
    instances: list[int] | None = None
    bank_index: dict[str, Any] | None = None
    #: Categories file / comma list (`threed_vision.recognise.load_categories`) instead of the bank index's tool classes.
    categories: str | None = None
    min_confidence: float | None = Field(default=None, ge=0, le=1)
    view_flag_iou: float | None = Field(default=None, ge=0, le=1)
    max_objects: int = Field(default=60, ge=1, le=500)
    min_area_px: int = Field(default=600, ge=1)
    max_tries: int = Field(default=3, ge=1, le=8)
    device: Literal["auto", "cpu", "cuda"] | None = None
    seed: int = 0
    ai_assist: bool = False
    #: Other photos of the same wall/objects (different viewpoint): used as held-out views of every fit.
    extra_photos: list[Path] = Field(default_factory=list, max_length=6)


class PhotoToWallRequest(PhotoRequest):
    photo_id: str | None = None
    board: dict[str, Any] | None = None
    anchor_mm: tuple[float, float] = (0.0, 0.0)
    auto_apply_confidence: float | None = Field(default=None, ge=0, le=1)


class PhotoToObjectsRequest(PhotoRequest):
    """Photo -> per-object results (mask, crop, class top-k, fitted model, colours) with no wall involved.

    `out_dir`: where masks, crops, cut-outs, models, overlays and `objects.json` are written (paths in the result are
    relative to it); default `<work_dir>/<image sha16>/objects/<run id>` (the run id hashes the request parameters)."""

    TRANSPORT_FIELDS: ClassVar[frozenset[str]] = ImageRef.TRANSPORT_FIELDS | {"out_dir"}

    out_dir: Path | None = None
    topk: int = Field(default=5, ge=1, le=20)
    #: Margin (fraction of the larger bbox side) added around each object's crop.
    crop_pad: float = Field(default=0.1, ge=0, le=1)
    #: Per-part colour sampling (`threed_vision.appearance`); off skips it.
    colours: bool = True
    #: Also put each CLIP crop embedding (512 floats) in the object record; they are always written to `embeddings.npy`.
    inline_embeddings: bool = False
