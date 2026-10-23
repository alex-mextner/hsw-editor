"""Optional AI assist for objects the no-AI pipeline is unsure about. FULLY OFF BY DEFAULT.

The orchestrator calls `AiAssist.refine` only when `config.ai_assist` is on AND (the request asked for it OR the
item's confidence is below `config.ai_assist_confidence`). Without those it uses `NullAssist` and nothing here runs.
The adapter shells out to the `omp` CLI (non-interactive, no tools, no session); the answer is advisory: it
relabels/reclassifies an item and may suggest dimensions, it never changes the fitted geometry.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from hsw_vision.config import VisionConfig


@dataclass(frozen=True)
class AiAssistRequest:
    item_id: str
    crop_path: Path
    tool_class: str | None
    confidence: float
    candidates: list[str] = field(default_factory=list)
    dims_mm: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class AiAssistResult:
    tool_class: str | None
    label: str | None
    dims_mm: dict[str, float]
    notes: str | None


class AiAssist(Protocol):
    def refine(self, request: AiAssistRequest) -> AiAssistResult | None: ...


class NullAssist:
    """The default: never asks anything."""

    def refine(self, request: AiAssistRequest) -> AiAssistResult | None:
        return None


Runner = Callable[..., "subprocess.CompletedProcess[str]"]


class OmpCliAssist:
    """Asks a vision-capable model through `omp -p` (the user's own omp configuration decides the model)."""

    def __init__(self, command: str = "omp", *, timeout_s: float = 120.0, runner: Runner = subprocess.run) -> None:
        self.command = command
        self.timeout_s = timeout_s
        self.runner = runner

    def refine(self, request: AiAssistRequest) -> AiAssistResult | None:
        prompt = (
            "You see the crop of ONE workshop tool. Reply with ONLY a JSON object "
            '{"tool_class": <one of the candidates or null>, "label": <short name>, '
            '"dims_mm": {"length": <mm or omitted>}, "notes": <one sentence>}. '
            f"Candidates: {', '.join(request.candidates) or 'any'}. "
            f"The classifier guessed {request.tool_class or 'nothing'} "
            f"with confidence {request.confidence:.2f}; measured dimensions (mm): {json.dumps(request.dims_mm)}."
        )
        argv = [
            self.command, "-p", "--no-session", "--no-tools", "--no-skills", "--no-rules",
            "--no-extensions", "--no-lsp", "--no-title", "--max-time", str(int(self.timeout_s)),
            prompt, f"@{request.crop_path}",
        ]  # fmt: skip
        try:
            done = self.runner(argv, capture_output=True, text=True, timeout=self.timeout_s + 10, check=False)
        except (OSError, subprocess.SubprocessError):
            return None
        if done.returncode != 0:
            return None
        return parse_answer(done.stdout)


def parse_answer(text: str) -> AiAssistResult | None:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        data: Any = json.loads(match.group(0))
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    dims = data.get("dims_mm")
    clean = {k: float(v) for k, v in dims.items() if isinstance(v, (int, float)) and v > 0} if isinstance(dims, dict) else {}
    tool_class = data.get("tool_class")
    return AiAssistResult(
        tool_class=tool_class if isinstance(tool_class, str) else None,
        label=data.get("label") if isinstance(data.get("label"), str) else None,
        dims_mm=clean,
        notes=data.get("notes") if isinstance(data.get("notes"), str) else None,
    )


def should_assist(config: VisionConfig, *, requested: bool, confidence: float) -> bool:
    """The only gate: config must enable it, then either the request asks or the item is low-confidence."""
    return config.ai_assist and (requested or confidence < config.ai_assist_confidence)


def build_assist(config: VisionConfig) -> AiAssist:
    return OmpCliAssist(config.omp_command) if config.ai_assist else NullAssist()
