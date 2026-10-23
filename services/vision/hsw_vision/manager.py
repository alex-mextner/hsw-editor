"""ModelManager: lazy, budget-aware residency of the library's model-backed engines.

* Engines are created and loaded on first use (never at import or start-up).
* A GPU load first makes room: while the service's own resident GPU estimate plus the new engine would exceed the
  VRAM budget, or the card would be left with less than `vram_headroom_mb` free (other processes share it), the
  least recently used unpinned engine is unloaded. If that is still not enough the engine runs on the CPU
  (`device="auto"`), or the request fails with `insufficient_vram` (`device="cuda"`).
* An out-of-memory error while loading or running on the GPU falls back to the CPU for that engine.
* Idle engines are unloaded after `idle_unload_s` so the GPU is free when nothing is being processed.
* A missing model file is a structured `models_missing` error naming the explicit fetch command; nothing is ever
  downloaded here.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, TypeVar

from hsw_vision.config import SETUP_HINT
from hsw_vision.errors import InsufficientVram, MissingDependency, VisionServiceError, translate_library_error

T = TypeVar("T")


class Engine(Protocol):
    """The lifecycle every `threed_vision` model-backed class provides."""

    loaded: bool
    device: str
    vram_estimate_mb: int

    def load(self) -> Any: ...

    def unload(self) -> Any: ...


@dataclass(frozen=True)
class EngineSpec:
    name: str
    #: `(device) -> engine` (not yet loaded); `device` is "cuda" or "cpu".
    factory: Callable[[str], Engine]
    vram_estimate_mb: int
    #: Other engines this one shares (e.g. one resident CLIP for the segmenter and the recogniser).
    requires: tuple[str, ...] = ()
    cpu_ok: bool = True
    #: Always placed on the GPU whatever the service default is (a request that names `device="cuda"` on a service pinned
    #: to the CPU): the budget, headroom and eviction still apply, but there is no CPU fallback; no room is an error.
    strict_cuda: bool = False


@dataclass
class _Resident:
    engine: Engine
    device: str
    vram_mb: int
    last_used: float
    loaded_at: float
    uses: int = 0


def is_oom(exc: BaseException) -> bool:
    text = f"{type(exc).__name__} {exc}".lower()
    return "outofmemory" in text or "out of memory" in text or "alloc_failed" in text


@dataclass
class ModelManager:
    specs: dict[str, EngineSpec]
    device: str = "auto"
    vram_budget_mb: int = 3000
    vram_headroom_mb: int = 400
    idle_unload_s: float = 300.0
    free_vram_fn: Callable[[], int | None] = lambda: None
    clock: Callable[[], float] = time.monotonic
    _resident: dict[str, _Resident] = field(default_factory=dict, init=False)
    _forced_cpu: set[str] = field(default_factory=set, init=False)
    _lock: threading.RLock = field(default_factory=threading.RLock, init=False)
    _busy: dict[str, int] = field(default_factory=dict, init=False)
    events: list[str] = field(default_factory=list, init=False)

    # ---- acquiring -------------------------------------------------------------------------------------

    def get(self, name: str) -> Engine:
        """The loaded engine `name`, loading it (and what it requires) if needed. Marks it most recently used."""
        with self._lock:
            return self._get(name, pinned=frozenset())

    def register(self, spec: EngineSpec) -> None:
        """Add an engine spec (idempotent), under the manager lock: status and the reaper iterate `specs`."""
        with self._lock:
            self.specs.setdefault(spec.name, spec)

    def closure(self, name: str) -> list[str]:
        """`name` plus everything it (transitively) requires."""
        seen: list[str] = []
        todo = [name]
        while todo:
            current = todo.pop()
            if current in seen or current not in self.specs:
                continue
            seen.append(current)
            todo.extend(self.specs[current].requires)
        return seen

    def _touch(self, name: str) -> None:
        """Most recently used: the engine AND its shared dependencies (CLIP is idle only if nothing above it is used)."""
        now = self.clock()
        for member in self.closure(name):
            resident = self._resident.get(member)
            if resident is not None:
                resident.last_used = now

    def call(self, name: str, fn: Callable[[Any], T]) -> T:
        """Run `fn(engine)`; on a GPU out-of-memory error reload the engine and its dependencies on the CPU and retry once.

        While `fn` runs the engine and its dependencies are *busy*: neither the idle reaper nor an LRU eviction
        may unload them. Library errors (bad input, missing model) are translated on both attempts."""
        with self._lock:
            engine = self._get(name, pinned=frozenset())
            self._mark_busy(name, +1)
        try:
            try:
                return fn(engine)
            except Exception as exc:
                if not (is_oom(exc) and self._device_of(name) == "cuda") or self.specs[name].strict_cuda:
                    raise self._translate(exc) from exc
                with self._lock:
                    self._log(f"{name}: OOM during inference, falling back to cpu")
                    self._mark_busy(name, -1)
                    try:
                        self._demote_to_cpu(name)
                        engine = self._get(name, pinned=frozenset())
                    finally:
                        self._mark_busy(name, +1)
            try:
                return fn(engine)
            except Exception as exc:
                raise self._translate(exc) from exc
        finally:
            with self._lock:
                self._touch(name)
                self._mark_busy(name, -1)

    def _demote_to_cpu(self, name: str) -> None:
        """Unload `name` and the shared engines it requires from the GPU and pin them all to the CPU until the
        service is idle: a CPU retry must not be handed a CUDA CLIP/OWL, and the GPU that just ran out of memory
        must be freed, not merely avoided by `name`."""
        members = self.closure(name)
        self._forced_cpu.update(members)
        self._unload_with_dependents(name)
        for dependency in members[1:]:
            resident = self._resident.get(dependency)
            if resident is not None and resident.device == "cuda" and self._busy.get(dependency, 0) == 0:
                self._unload_with_dependents(dependency)

    def _mark_busy(self, name: str, delta: int) -> None:
        for member in self.closure(name):
            self._busy[member] = max(self._busy.get(member, 0) + delta, 0)

    def _device_of(self, name: str) -> str | None:
        resident = self._resident.get(name)
        return resident.device if resident else None

    def _get(self, name: str, pinned: frozenset[str]) -> Engine:
        spec = self.specs.get(name)
        if spec is None:
            raise VisionServiceError(f"unknown engine {name!r}")
        resident = self._resident.get(name)
        if resident is not None and resident.engine.loaded:
            self._touch(name)
            resident.uses += 1
            return resident.engine
        self._resident.pop(name, None)
        keep = pinned | {name}
        for dependency in spec.requires:
            self._get(dependency, pinned=keep)
            keep = keep | {dependency}
        device = self._choose_device(spec, keep)
        if device == "cpu":
            self._rehome_dependencies_on_cpu(spec, keep)
        engine = self._load(spec, device)
        now = self.clock()
        actual = getattr(engine, "device", device) or device
        self._resident[name] = _Resident(
            engine=engine,
            device=actual,
            vram_mb=spec.vram_estimate_mb if actual == "cuda" else 0,
            last_used=now,
            loaded_at=now,
            uses=1,
        )
        return engine

    def _rehome_dependencies_on_cpu(self, spec: EngineSpec, keep: frozenset[str]) -> None:
        """An engine that runs on the CPU gets its shared dependencies on the CPU too (never a CUDA CLIP/OWL).
        A dependency another call is using right now stays where it is."""
        for dependency in spec.requires:
            resident = self._resident.get(dependency)
            if resident is None or resident.device != "cuda" or self._busy.get(dependency, 0) > 0:
                continue
            self._log(f"{spec.name} runs on cpu: reloading {dependency} on cpu too")
            self._forced_cpu.add(dependency)
            self._unload_with_dependents(dependency)
            self._get(dependency, pinned=keep)

    def _load(self, spec: EngineSpec, device: str) -> Engine:
        engine = spec.factory(device)
        try:
            engine.load()
        except Exception as exc:
            self._safe_unload(engine)
            if is_oom(exc) and device == "cuda" and spec.cpu_ok and self.device != "cuda" and not spec.strict_cuda:
                self._log(f"{spec.name}: OOM while loading on cuda, falling back to cpu")
                self._forced_cpu.add(spec.name)
                engine = spec.factory("cpu")
                try:
                    engine.load()
                except Exception as cpu_exc:
                    self._safe_unload(engine)
                    raise self._translate(cpu_exc) from cpu_exc
                return engine
            raise self._translate(exc) from exc
        return engine

    @staticmethod
    def _translate(exc: Exception) -> Exception:
        translated = translate_library_error(exc)
        if translated is not None:
            return translated
        if isinstance(exc, ImportError):
            return MissingDependency(
                f"missing python dependency: {exc}",
                fix=f"install the heavy runtime: {SETUP_HINT}",
            )
        return exc

    # ---- budget ----------------------------------------------------------------------------------------

    def resident_gpu_mb(self) -> int:
        return sum(r.vram_mb for r in self._resident.values() if r.device == "cuda")

    def _choose_device(self, spec: EngineSpec, pinned: frozenset[str]) -> str:
        if not spec.strict_cuda and (self.device == "cpu" or spec.name in self._forced_cpu):
            return "cpu"
        gpu_only = spec.strict_cuda or self.device == "cuda"
        if any(self._device_of(dependency) == "cpu" for dependency in spec.requires):
            return "cpu"  # a CPU-resident CLIP/OWL must not be handed to a CUDA engine
        need = spec.vram_estimate_mb
        while True:
            free = self.free_vram_fn()
            if free is None:
                if gpu_only:
                    raise MissingDependency("device=cuda requested but no usable CUDA device was found")
                return "cpu"
            within_budget = self.resident_gpu_mb() + need <= self.vram_budget_mb
            if within_budget and free >= need + self.vram_headroom_mb:
                return "cuda"
            victim = self._lru_victim(pinned)
            if victim is None:
                if gpu_only or not spec.cpu_ok:
                    raise InsufficientVram(
                        f"{spec.name} needs ~{need} MB VRAM; {free} MB free, budget {self.vram_budget_mb} MB, "
                        f"{self.resident_gpu_mb()} MB already held by this service",
                        fix="free GPU memory or set HSW_VISION_DEVICE=cpu",
                    )
                self._log(f"{spec.name}: not enough VRAM ({free} MB free, need {need}), using cpu")
                return "cpu"
            self._log(f"evicting {victim} (LRU) to make room for {spec.name}")
            self._unload_with_dependents(victim)

    def _lru_victim(self, pinned: frozenset[str]) -> str | None:
        gpu = [
            (r.last_used, name)
            for name, r in self._resident.items()
            if r.device == "cuda"
            and name not in pinned
            and self._busy.get(name, 0) == 0
            and not self._required_by_pinned(name, pinned)
        ]
        return min(gpu)[1] if gpu else None

    def _required_by_pinned(self, name: str, pinned: frozenset[str]) -> bool:
        return any(name in self.specs[p].requires for p in pinned if p in self.specs)

    # ---- unloading -------------------------------------------------------------------------------------

    def _unload_with_dependents(self, name: str) -> None:
        for other, spec in self.specs.items():
            if name in spec.requires and other in self._resident:
                self._unload_with_dependents(other)
        resident = self._resident.pop(name, None)
        if resident is not None:
            self._safe_unload(resident.engine)

    @staticmethod
    def _safe_unload(engine: Engine) -> None:
        try:
            engine.unload()
        except Exception:  # noqa: BLE001 - unloading must never take the service down
            pass

    def unload(self, name: str) -> bool:
        with self._lock:
            present = name in self._resident
            self._unload_with_dependents(name)
            return present

    def unload_all(self) -> list[str]:
        with self._lock:
            names = list(self._resident)
            for name in names:
                self._unload_with_dependents(name)
            self._forced_cpu.clear()
            return names

    def unload_idle(self) -> list[str]:
        """Unload engines idle for longer than `idle_unload_s` and not in use; returns their names.

        Skipped (returns `[]`) while another thread is loading: the reaper never waits behind a model load."""
        if not self._lock.acquire(blocking=False):
            return []
        try:
            now = self.clock()
            idle = [
                n
                for n, r in self._resident.items()
                if now - r.last_used > self.idle_unload_s and self._busy.get(n, 0) == 0
            ]
            before = list(self._resident)
            for name in idle:
                if name in self._resident and self._busy.get(name, 0) == 0:
                    self._log(f"unloading idle engine {name}")
                    self._unload_with_dependents(name)
            if not self._resident:
                self._forced_cpu.clear()
            return [name for name in before if name not in self._resident]
        finally:
            self._lock.release()

    # ---- introspection ---------------------------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """Lock-free snapshot: a cold start that holds the manager lock for tens of seconds must not stall probes."""
        now = self.clock()
        resident = dict(self._resident)
        forced = set(self._forced_cpu)
        engines = {
            name: {
                "loaded": name in resident,
                "device": resident[name].device if name in resident else None,
                "vram_estimate_mb": spec.vram_estimate_mb,
                "idle_s": round(now - resident[name].last_used, 1) if name in resident else None,
                "uses": resident[name].uses if name in resident else 0,
                "busy": self._busy.get(name, 0) > 0,
                "forced_cpu": name in forced,
            }
            for name, spec in dict(self.specs).items()
        }
        return {
            "device": self.device,
            "free_vram_mb": self.free_vram_fn(),
            "vram_budget_mb": self.vram_budget_mb,
            "resident_gpu_mb": sum(r.vram_mb for r in resident.values() if r.device == "cuda"),
            "idle_unload_s": self.idle_unload_s,
            "engines": engines,
            "events": list(self.events[-20:]),
        }

    def _log(self, message: str) -> None:
        self.events.append(message)
        if len(self.events) > 200:
            del self.events[:100]
