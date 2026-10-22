"""Service configuration: every path and knob comes from the environment, nothing is read at import time."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_LOOPBACK_PORT = 8795  # also the `HSW_VISION_URL` default of `hsw-editor doctor`
FETCH_MODELS_HINT = "hsw-editor vision fetch-models"


def _cache_home(env: Mapping[str, str]) -> Path:
    return Path(env.get("HSW_EDITOR_CACHE", str(Path.home() / ".cache" / "hsw-editor")))


def _opt_float(raw: str | None) -> float | None:
    if raw is None or raw.strip() == "" or raw.strip().lower() in ("none", "null", "never"):
        return None
    return float(raw)


@dataclass(frozen=True)
class VisionConfig:
    """Resolved service settings. Build with `VisionConfig.from_env()`; tests construct it directly."""

    models_dir: Path
    cache_dir: Path
    #: Where the running sidecar records its pid and endpoint (the Bun VisionClient and `doctor` read it).
    state_path: Path
    #: Optional unix socket instead of loopback TCP (`HSW_VISION_SOCKET`); None = loopback `host:port`.
    socket_path: Path | None = None
    host: str = "127.0.0.1"
    port: int = DEFAULT_LOOPBACK_PORT
    #: "auto" picks the GPU when enough VRAM is free, "cpu" never touches it, "cuda" insists on it.
    device: str = "auto"
    #: VRAM the service itself may hold across all resident engines (the shared 8 GB card has ~3 GB used by others).
    vram_budget_mb: int = 3000
    #: Free VRAM that must remain on the card after a load (other processes keep running).
    vram_headroom_mb: int = 400
    #: Resident engines idle for longer than this are unloaded (frees VRAM for other processes).
    idle_unload_s: float = 300.0
    #: Items whose confidence is at least this are flagged `autoApply`; None = every item stays a proposal.
    auto_apply_confidence: float | None = None
    #: Below this confidence an item needs the user's confirmation (UI shows it as uncertain).
    min_confidence: float = 0.5
    #: Held-out/synthetic view IoU below this asks for another view (`needs_views`).
    view_flag_iou: float = 0.75
    #: Cap for fits seen from one view only: silhouette-consistent but 3-D-unreliable (RESULT.md 4c).
    single_view_confidence_cap: float = 0.6
    ai_assist: bool = False
    ai_assist_confidence: float = 0.5
    #: omp CLI used by the optional AI-assist adapter.
    omp_command: str = "omp"
    extra_env: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> VisionConfig:
        e: Mapping[str, str] = os.environ if env is None else env
        cache_home = _cache_home(e)
        models = Path(e.get("THREED_VISION_MODELS_DIR", str(cache_home / "models")))
        defaults = cls(models_dir=models, cache_dir=Path(), state_path=Path())
        auto = _opt_float(e["HSW_VISION_AUTO_APPLY"]) if "HSW_VISION_AUTO_APPLY" in e else None
        return cls(
            models_dir=models,
            cache_dir=Path(e.get("HSW_VISION_CACHE", str(cache_home / "vision"))),
            state_path=Path(e.get("HSW_VISION_STATE", str(cache_home / "vision" / "state.json"))),
            socket_path=Path(e["HSW_VISION_SOCKET"]) if e.get("HSW_VISION_SOCKET") else None,
            port=int(e.get("HSW_VISION_PORT", defaults.port)),
            device=e.get("HSW_VISION_DEVICE", defaults.device),
            vram_budget_mb=int(e.get("HSW_VISION_VRAM_BUDGET_MB", defaults.vram_budget_mb)),
            vram_headroom_mb=int(e.get("HSW_VISION_VRAM_HEADROOM_MB", defaults.vram_headroom_mb)),
            idle_unload_s=float(e.get("HSW_VISION_IDLE_UNLOAD_S", defaults.idle_unload_s)),
            auto_apply_confidence=auto,
            min_confidence=float(e.get("HSW_VISION_MIN_CONFIDENCE", defaults.min_confidence)),
            view_flag_iou=float(e.get("HSW_VISION_VIEW_FLAG_IOU", defaults.view_flag_iou)),
            ai_assist=e.get("HSW_VISION_AI_ASSIST", "0").lower() in ("1", "true", "yes", "on"),
            ai_assist_confidence=float(e.get("HSW_VISION_AI_ASSIST_CONFIDENCE", defaults.ai_assist_confidence)),
            omp_command=e.get("HSW_VISION_OMP", defaults.omp_command),
        )

    def apply_to_environment(self) -> None:
        """The library reads `THREED_VISION_MODELS_DIR`; make the resolved value visible to it."""
        os.environ["THREED_VISION_MODELS_DIR"] = str(self.models_dir)
