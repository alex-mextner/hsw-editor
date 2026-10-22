"""AI assist is OFF by default and gated: config enables it, then the request asks or confidence is low."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from helpers import make_service
from hsw_vision import photo_to_wall
from hsw_vision.ai_assist import (
    AiAssistRequest,
    AiAssistResult,
    NullAssist,
    OmpCliAssist,
    build_assist,
    parse_answer,
    should_assist,
)
from hsw_vision.config import VisionConfig
from hsw_vision.schemas import CalibrateParams, PhotoToWallRequest

TWO_POINT = CalibrateParams(points_px=((0, 0), (100, 0)), distance_mm=150)


class SpyAssist:
    def __init__(self) -> None:
        self.calls: list[AiAssistRequest] = []

    def refine(self, request: AiAssistRequest) -> AiAssistResult | None:
        self.calls.append(request)
        return AiAssistResult(tool_class="pliers", label="Long nose pliers", dims_mm={"length": 150.0}, notes="spy")


def request(photo: Path, tmp: Path, **extra: Any) -> PhotoToWallRequest:
    return PhotoToWallRequest(image_path=photo, work_dir=tmp / "w", calibrate=TWO_POINT, **extra)


def test_never_called_by_default_even_for_low_confidence_and_explicit_requests(tmp_path: Path, photo: Path) -> None:
    spy = SpyAssist()
    service, _ = make_service(tmp_path, assist=spy)  # config.ai_assist defaults to False
    assert service.config.ai_assist is False
    photo_to_wall.run(service, request(photo, tmp_path))
    photo_to_wall.run(service, request(photo, tmp_path, ai_assist=True, refresh=True))  # asked, but config is off
    assert spy.calls == []


def test_default_adapter_is_the_null_assist() -> None:
    assert isinstance(build_assist(VisionConfig.from_env({})), NullAssist)
    assert NullAssist().refine(AiAssistRequest("1", Path("x.png"), None, 0.1)) is None


def test_enabled_in_config_it_runs_for_low_confidence_items_only(tmp_path: Path, photo: Path) -> None:
    spy = SpyAssist()
    service, _ = make_service(tmp_path, assist=spy, ai_assist=True, ai_assist_confidence=0.7)
    result = photo_to_wall.run(service, request(photo, tmp_path))
    # single-view confidence is capped at 0.6 < 0.7: every item is "low" and is asked about
    assert len(spy.calls) == 2
    assert spy.calls[0].crop_path.is_file() and spy.calls[0].candidates
    first = result["proposal"]["items"][0]
    assert first["toolClass"] == "pliers" and first["recognition"]["ai"]["label"] == "Long nose pliers"


def test_enabled_but_confident_items_are_skipped_unless_the_request_asks(tmp_path: Path, photo: Path) -> None:
    spy = SpyAssist()
    service, _ = make_service(tmp_path, assist=spy, ai_assist=True, ai_assist_confidence=0.3)
    photo_to_wall.run(service, request(photo, tmp_path))
    assert spy.calls == []
    photo_to_wall.run(service, request(photo, tmp_path, ai_assist=True, refresh=True))
    assert len(spy.calls) == 2


def test_gate_function() -> None:
    off = VisionConfig.from_env({})
    on = VisionConfig.from_env({"HSW_VISION_AI_ASSIST": "1", "HSW_VISION_AI_ASSIST_CONFIDENCE": "0.5"})
    assert should_assist(off, requested=True, confidence=0.0) is False
    assert should_assist(on, requested=False, confidence=0.9) is False
    assert should_assist(on, requested=False, confidence=0.4) is True
    assert should_assist(on, requested=True, confidence=0.9) is True


def test_omp_cli_adapter_builds_a_toolless_non_interactive_call_and_parses_json(tmp_path: Path) -> None:
    seen: list[list[str]] = []

    def runner(argv: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, 'Sure: {"tool_class": "hammer", "label": "Claw hammer", "dims_mm": {"length": 300, "bad": -1}, "notes": "ok"}', "")

    adapter = OmpCliAssist("omp", runner=runner)
    result = adapter.refine(AiAssistRequest("7", tmp_path / "c.png", "pliers", 0.3, ["pliers", "hammer"], {"length": 290.0}))
    argv = seen[0]
    assert argv[:3] == ["omp", "-p", "--no-session"] and "--no-tools" in argv and f"@{tmp_path / 'c.png'}" in argv
    assert result == AiAssistResult("hammer", "Claw hammer", {"length": 300.0}, "ok")


def test_omp_cli_adapter_failure_modes_return_none(tmp_path: Path) -> None:
    req = AiAssistRequest("7", tmp_path / "c.png", None, 0.3)
    bad = OmpCliAssist(runner=lambda argv, **_: subprocess.CompletedProcess(argv, 1, "", "boom"))
    missing = OmpCliAssist(runner=lambda argv, **_: (_ for _ in ()).throw(FileNotFoundError("omp")))
    assert bad.refine(req) is None and missing.refine(req) is None
    assert parse_answer("no json here") is None and parse_answer("{broken") is None


def test_an_invented_tool_class_from_the_assistant_is_ignored(tmp_path: Path, photo: Path) -> None:
    class Inventor(SpyAssist):
        def refine(self, request: AiAssistRequest) -> AiAssistResult | None:
            return AiAssistResult("needle-nose pliers", "Pliers", {}, None)

    service, _ = make_service(tmp_path, assist=Inventor(), ai_assist=True, ai_assist_confidence=0.9)
    item = photo_to_wall.run(service, request(photo, tmp_path))["proposal"]["items"][0]
    assert item["toolClass"] == "screwdriver"  # the classifier's class stands
    assert item["recognition"]["ai"]["rejectedToolClass"] == "needle-nose pliers"
