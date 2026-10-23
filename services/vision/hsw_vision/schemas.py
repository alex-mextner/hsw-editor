"""Request models shared by the HTTP API, the CLI and the orchestrator (pydantic = the single JSON contract)."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

from hsw_vision.errors import BadRequest
from hsw_vision.stages.multiview import GENERATED_FLAG_BELOW, view_direction


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


Point = tuple[float, float]
#: The dimensions a user can fix (millimetres): what the fit stage understands.
FIXED_DIMENSIONS = ("length", "width", "thickness")


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


SegmentQuality = Literal["fast", "accurate"]
DEFAULT_QUALITY: SegmentQuality = "fast"


class SegmentParams(Strict):
    method: Literal["sam2", "sam2-dense", "u2net"] = "sam2"
    #: `fast`: SAM2 grid filtered on the decoder's own low-resolution logits, only where OWLv2 sees objects; `accurate`:
    #: the stock SAM2 automatic mask generator (docs/vision.md has the timings). The user's choice lives in the
    #: `vision.segmentQuality` setting, which the server adds to the stage requests (docs/vision.md).
    quality: SegmentQuality = DEFAULT_QUALITY
    fill: Literal["owlv2", "none"] = "owlv2"
    reject_bg: bool = True
    points_per_side: int = Field(default=32, ge=8, le=128)

    @model_validator(mode="after")
    def _u2net_has_no_quality(self) -> SegmentParams:
        """`u2net` has no quality: requests that differ only in it share one cache entry and one engine."""
        if self.method == "u2net":
            self.quality = DEFAULT_QUALITY
        return self


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


Finite = Annotated[float, Field(allow_inf_nan=False)]
Matrix3 = Annotated[list[Annotated[list[Finite], Field(min_length=3, max_length=3)]], Field(min_length=3, max_length=3)]


class GeneratedView(Strict):
    """A DRAWN view of the object (docs/draw.md): an image on a white background. It is compared at a named direction
    (`view`: front = the photo's own view, side = its end, top = its profile along the length; see
    `stages.multiview.GENERATED_VIEW_ANGLES`) XOR an explicit one in the object frame; a hint, never ground truth."""

    image_path: Path
    view: Literal["front", "side", "top", "back"] | None = None
    azimuth_deg: Finite | None = None
    elevation_deg: Finite | None = None
    name: str | None = None

    @model_validator(mode="after")
    def _has_one_direction(self) -> GeneratedView:
        try:
            view_direction(self.view, self.azimuth_deg, self.elevation_deg)
        except BadRequest as exc:
            raise ValueError(exc.message) from exc
        return self


class PhotoView(Strict):
    """Another photo of the object as seen by its own camera (world -> camera in the fit's world frame): the object's mask
    as pixels (`mask`) or as an image file (`mask_path`: alpha channel of an RGBA PNG when it varies, else grey above half range)."""

    mask: list[list[int]] | None = None
    mask_path: Path | None = None
    K: Matrix3
    R: Matrix3
    t: Annotated[list[Finite], Field(min_length=3, max_length=3)]
    name: str | None = None

    @model_validator(mode="after")
    def _has_one_mask(self) -> PhotoView:
        if (self.mask is None) == (self.mask_path is None):
            raise ValueError("give exactly one of `mask` and `mask_path`")
        if self.mask is not None and (not self.mask or not self.mask[0] or len({len(row) for row in self.mask}) != 1):
            raise ValueError("`mask` must be a non-empty rectangle of pixels (rows of equal length)")
        return self


class MultiviewRequest(Strict):
    """Check a stored fit against other photos of the same object and (as hints only) drawn views."""

    fit: dict[str, Any]
    views: list[PhotoView] = Field(default_factory=list)
    generated_views: list[GeneratedView] = Field(default_factory=list, max_length=8)
    flag_below: float = Field(default=0.75, ge=0, le=1)
    #: Drawn views are flagged below this agreement; they never change the confidence.
    generated_flag_below: float = Field(default=GENERATED_FLAG_BELOW, ge=0, le=1)


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


class ObjectsEditRequest(Strict):
    """An edit of a finished `photo_to_objects` result directory (`objects.json` + files): no photo-wide re-run."""

    out_dir: Path


class MergeObjectsRequest(ObjectsEditRequest):
    ids: list[int] = Field(min_length=2, max_length=20)


class SplitObjectRequest(ObjectsEditRequest):
    """Split one object's mask: by a straight line through two photo pixels, or into `n` parts that follow its necks."""

    id: int
    line_px: tuple[Point, Point] | None = None
    n: int | None = Field(default=None, ge=2, le=8)

    @model_validator(mode="after")
    def _exactly_one_way(self) -> SplitObjectRequest:
        if (self.line_px is None) == (self.n is None):
            raise ValueError("give exactly one of line_px (two photo pixels) and n (number of parts)")
        return self


class ReprofileObjectsRequest(ObjectsEditRequest):
    """Fit again with other fixed dimensions (per object id, mm) and/or another scale. A new `calibrate` changes every
    object's millimetres, so it re-fits all live objects; `fixed_dims[id] = null` clears that object's constraints."""

    ids: list[int] | None = None
    fixed_dims: dict[Annotated[str, StringConstraints(pattern=r"^\d+$")], dict[str, float] | None] = Field(default_factory=dict)
    calibrate: CalibrateParams | None = None

    @field_validator("fixed_dims")
    @classmethod
    def _known_positive_dims(cls, value: dict[str, dict[str, float] | None]) -> dict[str, dict[str, float] | None]:
        for ident, dims in value.items():
            for name, mm in (dims or {}).items():
                if name not in FIXED_DIMENSIONS or not mm > 0:
                    raise ValueError(f"object {ident}: {name}={mm}; use {', '.join(FIXED_DIMENSIONS)} with positive millimetres")
        return value


class AddObjectRequest(ObjectsEditRequest):
    """Segment one more object from a SAM2 prompt: a click or a box, in photo pixels."""

    point_px: Point | None = None
    box_xywh: tuple[float, float, Annotated[float, Field(gt=0)], Annotated[float, Field(gt=0)]] | None = None

    @model_validator(mode="after")
    def _exactly_one_prompt(self) -> AddObjectRequest:
        if (self.point_px is None) == (self.box_xywh is None):
            raise ValueError("give exactly one of point_px and box_xywh")
        return self
