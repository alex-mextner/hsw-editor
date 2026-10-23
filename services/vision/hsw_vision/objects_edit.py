"""Edit ops on a finished `photo_to_objects` result directory: merge, split, reprofile and add one object.

    from hsw_vision.objects_edit import merge_objects
    merge_objects(service, "out/", [3, 7])   # -> {"object": <record>, "sources": [...], "summary": {...}}

The review grid of the tool import corrects the automatic segmentation with these instead of re-running SAM2 on the whole
photo (15 s GPU, 80 s CPU). An op analyses only the objects it creates or re-fits, with the same functions the run used
(`objects.analyse`: recognise, fit, crops, colours, embedding), takes the scale and the class vocabulary the run stored in
`objects.json`, and rewrites `objects.json` atomically. Records are never deleted: a merged or split source stays with
`status: "merged" | "split"` and `mergedInto` / `splitInto`; new ids are `max(id) + 1`, never reused. `edits` in
`objects.json` is the log of the ops.
"""

from __future__ import annotations

import json
import shutil
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import ValidationError

from hsw_vision.analysis import StageClock, load_extra_photos
from hsw_vision.errors import BadRequest, CalibrationNeeded
from hsw_vision.files import save_npy, write_json
from hsw_vision.mask_split import MIN_PART_PX, split_mask
from hsw_vision.objects import (
    DINO_EMBEDDINGS_FILE,
    EMBEDDINGS_FILE,
    STATUS_MERGED,
    STATUS_OK,
    STATUS_SPLIT,
    SUPERSEDED,
    Analysis,
    write_overlays,
    analyse,
    summarise,
)
from hsw_vision.schemas import CalibrateParams, PhotoToObjectsRequest
from hsw_vision.service import Image, VisionService
from hsw_vision.stages import embed as stage_embed
from hsw_vision.stages import segment as stage_segment

#: Scratch cache of an op (derived segmentations, fit caches); removed when the op ends.
WORK_DIR = ".edit-work"

_LOCKS: dict[Path, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(out_dir: Path) -> threading.Lock:
    """One op at a time per result directory inside this process: every op reads and rewrites `objects.json`."""
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(out_dir, threading.Lock())


@contextmanager
def _directory_lock(out_dir: Path) -> Iterator[None]:
    """The thread lock plus an `flock` on `<out>/.edit.lock`, so the CLI and the daemon's sidecar never edit one directory
    at the same time (both would read the same `objects.json` and hand out the same new ids)."""
    import fcntl

    with _lock_for(out_dir):
        if not out_dir.is_dir():
            raise BadRequest(f"no result directory {out_dir}: run photo-to-objects first")
        with (out_dir / ".edit.lock").open("a") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)


@dataclass
class Session:
    service: VisionService
    out_dir: Path
    result: dict[str, Any]
    req: PhotoToObjectsRequest
    classes: list[dict[str, Any]]
    img: Image
    calibration: dict[str, Any]

    @property
    def records(self) -> list[dict[str, Any]]:
        return self.result["objects"]  # type: ignore[no-any-return]

    def live(self) -> list[dict[str, Any]]:
        return [r for r in self.records if r["status"] not in SUPERSEDED]

    def live_record(self, ident: int) -> dict[str, Any]:
        for r in self.records:
            if r["id"] == ident:
                if r["status"] in SUPERSEDED:
                    raise BadRequest(f"object {ident} was already {r['status']} into {r.get('mergedInto') or r.get('splitInto')}")
                return r
        raise BadRequest(f"no object {ident} in {self.out_dir / 'objects.json'}; ids: {sorted(r['id'] for r in self.records)}")

    def next_id(self) -> int:
        return max((r["id"] for r in self.records), default=0) + 1

    def mask(self, record: dict[str, Any]) -> np.ndarray:
        from threed_vision import io as tv_io

        mask = tv_io.load_mask(self.out_dir / record["mask"])
        if not mask.any():
            raise BadRequest(f"the mask of object {record['id']} ({record['mask']}) is empty or unreadable")
        return mask  # type: ignore[no-any-return]

    def embedding_rows(self) -> np.ndarray:
        path = self.out_dir / EMBEDDINGS_FILE
        return np.load(path, allow_pickle=False) if path.is_file() else np.zeros((0, stage_embed.DIM), np.float32)

    def analyse(
        self,
        instances: list[dict[str, Any]],
        *,
        req: PhotoToObjectsRequest | None = None,
        calibration: dict[str, Any] | None = None,
        reuse: dict[int, dict[str, Any]] | None = None,
    ) -> tuple[Analysis, dict[str, Any]]:
        """Analyse `instances` (library-style dicts with a `mask`) exactly as the run analysed its objects."""
        raw = {"instances": instances, "method": "edit", "device": None, "timing_s": None, "vram_mb": None}
        prefix = f"seg-edit-{uuid.uuid4().hex[:8]}/"
        segmentation = stage_segment.describe(self.img.rgb, raw, self.img.dir / prefix, files_prefix=prefix)
        segmentation["dir"] = prefix.rstrip("/")
        self.img.pinned.add(segmentation["dir"])
        use_req = req or self.req
        extras = load_extra_photos(self.service, use_req)
        analysis = analyse(
            self.service,
            use_req,
            self.img,
            self.out_dir,
            calibration or self.calibration,
            segmentation,
            segmentation["instances"],
            extras,
            StageClock(),
            classes=self.classes,
            row_offset=len(self.embedding_rows()),
            reuse=reuse,
        )
        return analysis, segmentation

    def dino_rows(self) -> np.ndarray:
        path = self.out_dir / DINO_EMBEDDINGS_FILE
        return np.load(path, allow_pickle=False) if path.is_file() else np.zeros((0, stage_embed.DINO_DIM), np.float32)

    def append(self, analysis: Analysis) -> None:
        if len(analysis.embeddings):
            clip_before, dino_before = self.embedding_rows(), self.dino_rows()
            # the two files share their row order: both are extended together or the DINOv2 one is left alone
            files_in_step = len(dino_before) == len(clip_before) and len(clip_before) > 0
            width_ok = not len(dino_before) or not len(analysis.dino_embeddings) or dino_before.shape[1] == analysis.dino_embeddings.shape[1]
            if len(analysis.dino_embeddings) == len(analysis.embeddings) and (files_in_step or not len(clip_before)) and width_ok:
                # no CLIP rows yet: the DINOv2 file starts over too (leftover rows would shift the new row numbers)
                kept = dino_before if len(clip_before) else np.zeros((0, analysis.dino_embeddings.shape[1]), np.float32)
                save_npy(self.out_dir / DINO_EMBEDDINGS_FILE, np.vstack([kept, analysis.dino_embeddings]))
            else:
                if files_in_step:
                    # DINOv2 failed just now: pad zero rows (no record points at them) so later edits stay in step
                    pad = np.zeros((len(analysis.embeddings), dino_before.shape[1]), np.float32)
                    save_npy(self.out_dir / DINO_EMBEDDINGS_FILE, np.vstack([dino_before, pad]))
                for record in analysis.records:
                    if record.get("embedding"):
                        record["embedding"].pop("dino", None)
            save_npy(self.out_dir / EMBEDDINGS_FILE, np.vstack([clip_before, analysis.embeddings]))
        self.records.extend(analysis.records)

    def log(self, op: str, **fields: Any) -> None:
        self.result.setdefault("edits", []).append({"op": op, "at": datetime.now(UTC).isoformat(timespec="seconds"), **fields})

    def save(self) -> None:
        self.result["summary"] = summarise(self.records, self.result["summary"]["found"])
        write_json(self.out_dir / "objects.json", self.result)


@contextmanager
def session(service: VisionService, out_dir: str | Path) -> Iterator[Session]:
    out = Path(out_dir).expanduser().resolve()
    with _directory_lock(out):
        path = out / "objects.json"
        if not path.is_file():
            raise BadRequest(f"no objects.json in {out}: run photo-to-objects first")
        result = json.loads(path.read_text(encoding="utf-8"))
        stored = result.get("request")
        if not isinstance(stored, dict) or "classes" not in stored:
            raise BadRequest(f"{path} predates the edit ops (no stored request): run photo-to-objects again")
        fields = {k: v for k, v in stored.items() if k != "classes"}
        try:
            req = PhotoToObjectsRequest(image_path=Path(result["image"]["path"]), out_dir=out, work_dir=out / WORK_DIR, **fields)
        except ValidationError as exc:
            raise BadRequest(f"the request stored in {path} is not valid any more: {exc.errors()[0]['msg']}") from exc
        img = service.open(req)
        if img.sha256 != result["image"]["sha256"]:
            raise BadRequest(f"the photo {img.path} changed since {path} was written: run photo-to-objects again")
        try:
            yield Session(service, out, result, req, stored["classes"], img, result["calibration"])
        finally:
            shutil.rmtree(out / WORK_DIR, ignore_errors=True)


def _instance(ident: int, mask: np.ndarray, source: str, bg_prob: float | None = 0.0, stability: float = 0.0) -> dict[str, Any]:
    ys, xs = np.nonzero(mask)
    box = [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)]
    return {
        "id": ident,
        "source": source,
        "bbox_xywh": box,
        "area_px": int(mask.sum()),
        "bg_prob": bg_prob or 0.0,
        "stability": stability,
        "mask": mask,
    }


def _min_or_zero(values: list[float | None]) -> float:
    return min((float(v) for v in values if v is not None), default=0.0)


def merge_objects(service: VisionService, out_dir: str | Path, ids: list[int]) -> dict[str, Any]:
    """The union of the masks of `ids` becomes one new object (a hammer head and its handle segmented apart)."""
    ids = list(dict.fromkeys(ids))
    if len(ids) < 2:
        raise BadRequest("merge needs two or more distinct object ids")
    with session(service, out_dir) as s:
        parts = [s.live_record(i) for i in ids]
        union = np.logical_or.reduce([s.mask(p) for p in parts])
        new_id = s.next_id()
        inst = _instance(new_id, union, "merged", _min_or_zero([p["bgProb"] for p in parts]))
        analysis, _ = s.analyse([inst])
        (record,) = analysis.records
        s.append(analysis)
        for p in parts:
            p["status"], p["mergedInto"] = STATUS_MERGED, new_id
        s.log("merge", ids=ids, into=[new_id])
        s.save()
        return {"object": record, "sources": parts, "summary": s.result["summary"]}


def split_object(
    service: VisionService,
    out_dir: str | Path,
    ident: int,
    *,
    line_px: tuple[tuple[float, float], tuple[float, float]] | None = None,
    n: int | None = None,
) -> dict[str, Any]:
    """One mask that covers several tools becomes one object per part (largest first)."""
    with session(service, out_dir) as s:
        source = s.live_record(ident)
        masks = split_mask(s.mask(source), line_px=line_px, n=n, min_area=MIN_PART_PX)
        first = s.next_id()
        instances = [_instance(first + i, m, "split", source["bgProb"]) for i, m in enumerate(masks)]
        analysis, _ = s.analyse(instances)
        s.append(analysis)
        into = [r["id"] for r in analysis.records]
        source["status"], source["splitInto"] = STATUS_SPLIT, into
        s.log("split", id=ident, into=into, **({"linePx": line_px} if line_px else {"n": n}))
        s.save()
        return {"objects": analysis.records, "source": source, "summary": s.result["summary"]}


def _check_prompt_inside(
    size: tuple[int, int], point_px: tuple[float, float] | None, box_xywh: tuple[float, float, float, float] | None
) -> None:
    w, h = size
    if point_px is not None and not (0 <= point_px[0] < w and 0 <= point_px[1] < h):
        raise BadRequest(f"the point {list(point_px)} is outside the {w}x{h} photo")
    if box_xywh is not None:
        x, y, bw, bh = box_xywh
        if bw <= 0 or bh <= 0 or x < 0 or y < 0 or x + bw > w or y + bh > h:
            raise BadRequest(f"the box {list(box_xywh)} must have a positive size and lie inside the {w}x{h} photo")


def add_object(
    service: VisionService,
    out_dir: str | Path,
    *,
    point_px: tuple[float, float] | None = None,
    box_xywh: tuple[float, float, float, float] | None = None,
) -> dict[str, Any]:
    """One more object, segmented by SAM2 from a click or a box the segmentation missed (the blue wrench)."""
    with session(service, out_dir) as s:
        _check_prompt_inside(s.img.size, point_px, box_xywh)
        with service.run_lock:
            found = service.stages.prompt_mask(
                s.img.rgb, manager=service.manager, point_px=point_px, box_xywh=box_xywh, method=s.req.segment.method
            )
        mask = np.asarray(found["mask"], dtype=bool)
        if int(mask.sum()) < MIN_PART_PX:
            raise BadRequest(f"the prompt gave a mask of {int(mask.sum())} px (< {MIN_PART_PX}); click on the object's body or draw a box")
        new_id = s.next_id()
        analysis, _ = s.analyse([_instance(new_id, mask, "click", 0.0, float(found.get("stability") or 0.0))])
        (record,) = analysis.records
        s.append(analysis)
        s.log("add", id=new_id, **({"pointPx": point_px} if point_px else {"boxXywh": box_xywh}))
        s.save()
        return {"object": record, "summary": s.result["summary"]}


def _merge_fixed_dims(
    stored: dict[str, dict[str, float]], update: dict[int, dict[str, float] | None]
) -> dict[str, dict[str, float]]:
    """`stored` with each object's `update` merged in; `None` (or an empty dict) clears that object's constraints."""
    merged = {k: dict(v) for k, v in stored.items()}
    for ident, dims in update.items():
        if dims:
            merged[str(ident)] = {**merged.get(str(ident), {}), **dims}
        else:
            merged.pop(str(ident), None)
    return merged


def reprofile_objects(
    service: VisionService,
    out_dir: str | Path,
    *,
    ids: list[int] | None = None,
    fixed_dims: dict[str, dict[str, float] | None] | None = None,
    calibrate: CalibrateParams | None = None,
) -> dict[str, Any]:
    """Fit again, in place, with other fixed dimensions and/or another scale; class and embedding are kept.

    A new scale (`calibrate`) changes every object's millimetres, so every live object is re-fitted and the result gains
    the scale (a `no_scale` result becomes `ok`). Fixed dimensions apply to the objects named in `fixed_dims`
    (merged into what they had; `null` clears), plus `ids`; with neither every live object is re-fitted."""
    try:
        updates = {int(k): v for k, v in (fixed_dims or {}).items()}
    except ValueError:
        raise BadRequest("fixed_dims keys are object ids (integers)") from None
    new_scale = calibrate if calibrate is not None and calibrate != CalibrateParams() else None
    if new_scale is not None and new_scale.reference_instance is not None:
        raise BadRequest("reprofile takes a manual scale (points_px + distance_mm, or mm_per_px), not a reference instance")
    with session(service, out_dir) as s:
        live = {r["id"]: r for r in s.live()}
        wanted = set(ids or []) | set(updates)
        unknown = sorted(wanted - set(live))
        if unknown:
            raise BadRequest(f"no live object(s) {unknown}; ids: {sorted(live)}")
        calibration = service.calibrate(s.img, new_scale) if new_scale is not None else s.calibration
        if not calibration.get("ok"):
            raise CalibrationNeeded(
                calibration.get("message") or "the result has no scale: send calibrate.points_px + distance_mm or calibrate.mm_per_px",
                fix="send calibrate.points_px + calibrate.distance_mm (two-point) or calibrate.mm_per_px",
            )
        targets = list(live) if new_scale is not None or not wanted else sorted(wanted)
        fixed = _merge_fixed_dims(s.req.fixed_dims, updates)
        req = s.req.model_copy(update={"fixed_dims": fixed, **({"calibrate": new_scale} if new_scale else {})})
        instances = [
            _instance(i, s.mask(live[i]), live[i].get("source") or "edit", live[i]["bgProb"], live[i].get("stability") or 0.0)
            for i in targets
        ]
        analysis, segmentation = s.analyse(instances, req=req, calibration=calibration, reuse={i: live[i] for i in targets})
        fresh = {r["id"]: r for r in analysis.records}
        s.result["objects"] = [fresh.get(r["id"], r) for r in s.records]
        s.result["calibration"] = calibration
        s.result["status"] = STATUS_OK  # the result has a scale now; each record keeps its own status
        s.result.pop("needs", None)
        s.result.pop("message", None)
        stored = {**s.result["request"], "fixed_dims": fixed}
        if new_scale is not None:
            stored["calibrate"] = new_scale.model_dump(mode="json")
        s.result["request"] = stored
        if set(targets) == set(live):  # a partial re-fit leaves fit-overlay.jpg showing the older fits of the others
            s.result["overlay"] = write_overlays(
                service, s.img, segmentation, s.out_dir, segmentation["instances"], analysis.masks, analysis.by_id, calibration
            )
        s.log(
            "reprofile",
            ids=targets,
            fixedDims=fixed_dims or None,
            calibrate=new_scale.model_dump(mode="json", exclude_none=True) if new_scale else None,
        )
        s.save()
        return {
            "objects": [fresh[i] for i in targets],
            "calibration": calibration,
            "status": s.result["status"],
            "summary": s.result["summary"],
        }
