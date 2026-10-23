"""Engine factories: how the manager builds the library's model-backed classes (imported lazily, never at start-up)."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from hsw_vision.config import SETUP_HINT, VisionConfig
from hsw_vision.errors import MissingDependency
from hsw_vision.manager import Engine, EngineSpec, ModelManager

CLIP = "clip"
DINO = "dino"
OWL = "owl"
RECOGNISER = "recogniser"
SEGMENTER_SAM2 = "sam2"
SEGMENTER_U2NET = "u2net"
FIT = "fit"
#: The fit engine for a request that says `device="cuda"` on a service pinned to the CPU (`EngineSpec.strict_cuda`).
FIT_CUDA = "fit-cuda"
# Estimates (MB). The library's `Segmenter.vram_estimate_mb` (2000) already includes the CLIP/OWLv2 it shares, which are
# separate resident engines here, so the SAM2 entry is its OWN share (measured spike peak for AMG + OWLv2 + CLIP: ~1.9 GB).
#: FIT: the soft-silhouette optimiser peaks at ~40 MB of tensors, the CUDA context it opens adds a few hundred MB.
# DINO: a `cpu_only` spec with a zero estimate. DINOv2-small (22 M parameters) runs on the CPU (~0.15 s per crop, a few seconds per
# photo) so that it never asks the GPU budget for room: another 300 MB would push a photo (SAM2 + OWL + CLIP + recogniser + fit =
# 2950 of 3000 MB) over the budget and evict SAM2 on every photo.
VRAM_ESTIMATES = {CLIP: 500, DINO: 0, OWL: 700, RECOGNISER: 100, SEGMENTER_SAM2: 1300, SEGMENTER_U2NET: 300, FIT: 350}


class FitRunner:
    """Residency marker for the fit stage, which has no weights: it lets the ModelManager account the optimiser's GPU
    context against the budget (and evict LRU engines for it), and fall back to the CPU on an out-of-memory error, like
    every model-backed engine. `device` is where `threed_vision.fit.fit_auto` is told to run."""

    vram_estimate_mb = VRAM_ESTIMATES[FIT]

    def __init__(self, device: str) -> None:
        self.device = device
        self.loaded = False

    def load(self) -> None:
        self.loaded = True

    def unload(self) -> None:
        self.loaded = False



def segmenter_name(method: str, fill: str, reject_bg: bool, points_per_side: int) -> str:
    return f"segmenter:{method}:{fill}:{'bg' if reject_bg else 'nobg'}:{points_per_side}"


def default_specs(manager: ModelManager) -> dict[str, EngineSpec]:
    """Specs that share ONE resident CLIP/OWLv2 between the segmenter and the recogniser (resolved through `manager`)."""

    def clip(device: str) -> Engine:
        from threed_vision import clip as tv_clip

        return tv_clip.ClipEncoder(device=device)

    def dino(device: str) -> Engine:
        from threed_vision import clip as tv_clip

        if not hasattr(tv_clip, "DinoEncoder"):  # a library older than the DINOv2 encoder: the same as absent weights
            raise MissingDependency("the installed threed_vision has no DinoEncoder", fix=SETUP_HINT)
        return tv_clip.DinoEncoder(device=device)  # always "cpu": the spec is `cpu_only`

    def owl(device: str) -> Engine:
        from threed_vision import detect as tv_detect

        return tv_detect.OwlDetector(device=device)

    def recogniser(device: str) -> Engine:
        from threed_vision import recognise as tv_recognise

        return tv_recognise.Recogniser(device=device, clip=manager.get(CLIP))

    return {
        CLIP: EngineSpec(CLIP, clip, VRAM_ESTIMATES[CLIP]),
        DINO: EngineSpec(DINO, dino, VRAM_ESTIMATES[DINO], cpu_only=True),
        OWL: EngineSpec(OWL, owl, VRAM_ESTIMATES[OWL]),
        RECOGNISER: EngineSpec(RECOGNISER, recogniser, VRAM_ESTIMATES[RECOGNISER], requires=(CLIP,)),
        FIT: EngineSpec(FIT, FitRunner, VRAM_ESTIMATES[FIT]),
        FIT_CUDA: EngineSpec(FIT_CUDA, FitRunner, VRAM_ESTIMATES[FIT], cpu_ok=False, strict_cuda=True),
    }


def segmenter_spec(
    manager: ModelManager,
    *,
    method: str,
    fill: str,
    reject_bg: bool,
    points_per_side: int,
) -> EngineSpec:
    """A segmenter variant; the SAM2/u2net weights are its own, CLIP and OWLv2 are the shared residents."""
    name = segmenter_name(method, fill, reject_bg, points_per_side)
    requires = tuple(n for n, wanted in ((CLIP, reject_bg), (OWL, fill == "owlv2")) if wanted)

    def factory(device: str) -> Engine:
        from threed_vision import segment as tv_segment

        kwargs: dict[str, Any] = {
            "method": method,
            "fill": fill,
            "reject_bg": reject_bg,
            "device": device,
            "points_per_side": points_per_side,
        }
        if reject_bg:
            kwargs["clip"] = manager.get(CLIP)
        if fill == "owlv2":
            kwargs["detector"] = manager.get(OWL)
        return tv_segment.Segmenter(**kwargs)

    own = VRAM_ESTIMATES[SEGMENTER_U2NET if method == "u2net" else SEGMENTER_SAM2]
    return EngineSpec(name, factory, own, requires=requires)


def build_manager(config: VisionConfig, free_vram_fn: Callable[[], int | None] | None = None) -> ModelManager:
    """The service's ModelManager with the library engines registered (nothing is loaded yet)."""

    def library_free_vram() -> int | None:
        from threed_vision import device as tv_device

        return tv_device.free_vram_mb()

    manager = ModelManager(
        specs={},
        device=config.device,
        vram_budget_mb=config.vram_budget_mb,
        vram_headroom_mb=config.vram_headroom_mb,
        idle_unload_s=config.idle_unload_s,
        free_vram_fn=free_vram_fn or library_free_vram,
    )
    for spec in default_specs(manager).values():
        manager.register(spec)
    return manager


def ensure_segmenter(
    manager: ModelManager,
    *,
    method: str = "sam2",
    fill: str = "owlv2",
    reject_bg: bool = True,
    points_per_side: int = 32,
) -> str:
    """Register (once) and return the engine name of a segmenter variant."""
    name = segmenter_name(method, fill, reject_bg, points_per_side)
    manager.register(
        segmenter_spec(manager, method=method, fill=fill, reject_bg=reject_bg, points_per_side=points_per_side)
    )
    return name
