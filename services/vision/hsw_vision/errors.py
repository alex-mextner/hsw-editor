"""Structured service errors: a stable `code`, an HTTP status, an exit code (CLI) and a one-line fix."""

from __future__ import annotations

from typing import Any

from hsw_vision.config import FETCH_MODELS_HINT

# CLI exit codes mirror the threed_vision contract (0 ok, 2 bad input, 3 low confidence, 127 missing model/dependency).
EXIT_BAD_INPUT = 2
EXIT_LOW_CONFIDENCE = 3
EXIT_MISSING = 127
EXIT_FAILED = 1

KNOWN_MODELS = ("sam2-tiny", "owlv2-base", "clip-b32", "dinov2-s", "u2net")


class VisionServiceError(Exception):
    code = "vision_error"
    http_status = 500
    exit_code = EXIT_FAILED

    def __init__(self, message: str, fix: str | None = None, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.fix = fix
        self.details = details or {}

    def to_json(self) -> dict[str, Any]:
        body: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.fix:
            body["fix"] = self.fix
        if self.details:
            body["details"] = self.details
        return {"error": body}


class BadRequest(VisionServiceError):
    code = "bad_request"
    http_status = 422
    exit_code = EXIT_BAD_INPUT


class ModelsMissing(VisionServiceError):
    """A model file is absent. The service NEVER downloads at request time (offline-first)."""

    code = "models_missing"
    http_status = 424
    exit_code = EXIT_MISSING

    def __init__(self, message: str, missing: list[str] | None = None) -> None:
        super().__init__(message, fix=FETCH_MODELS_HINT, details={"missing": missing or []})


class MissingDependency(VisionServiceError):
    code = "missing_dependency"
    http_status = 424
    exit_code = EXIT_MISSING


class InsufficientVram(VisionServiceError):
    code = "insufficient_vram"
    http_status = 503
    exit_code = EXIT_FAILED


class LowConfidence(VisionServiceError):
    code = "low_confidence"
    http_status = 422  # never 200: a body that is an error must not look like a result to `response.ok` callers
    exit_code = EXIT_LOW_CONFIDENCE


class CalibrationNeeded(VisionServiceError):
    """No grid found and no manual scale/reference given: the user must supply a scale."""

    code = "calibration_needed"
    http_status = 422
    exit_code = EXIT_BAD_INPUT


def translate_library_error(exc: BaseException) -> VisionServiceError | None:
    """Map `threed_vision.errors` exceptions onto service errors (by class name: the library is imported lazily)."""
    names = {cls.__name__ for cls in type(exc).__mro__}
    message = str(exc)
    if "MissingDependency" in names:
        missing = _model_names(message)
        if missing or "models pull" in message:
            return ModelsMissing(message, missing=missing)
        return MissingDependency(message, fix=getattr(exc, "remediation", None))
    if "BadInput" in names:
        return BadRequest(message)
    if "LowConfidence" in names:
        return LowConfidence(message)
    return None


def error_json_for(exc: BaseException) -> tuple[dict[str, Any], int]:
    """`(body, http status)` of any exception: service errors, translated library errors, else `internal` 500."""
    service_error = exc if isinstance(exc, VisionServiceError) else translate_library_error(exc)
    if service_error is not None:
        return service_error.to_json(), service_error.http_status
    return {"error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}"}}, 500


def _model_names(message: str) -> list[str]:
    found: list[str] = []
    for token in message.replace("`", " ").replace(",", " ").replace("'", " ").split():
        if token in KNOWN_MODELS and token not in found:
            found.append(token)
    return found
