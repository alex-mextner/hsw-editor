"""Exit codes of ``hsw-editor`` (PUBLIC CONTRACT, documented in ``docs/cli.md`` and ``--help``).

Built on ``agenttools_errors``: the class pins the exit code, ``guard`` renders the what/why/fix block.
Codes shared with the agent-tools service lib keep its meaning (3 = not running, 4 = autostart/port).
"""

from __future__ import annotations

from dataclasses import dataclass

from agenttools_errors import (  # noqa: F401 - re-exported for the CLI modules
    AgentToolError,
    MissingDepError,
    MissingTargetError,
    NetworkError,
    PermissionDeniedError,
    UsageError,
    guard,
)

EXIT_OK = 0
EXIT_FAILED_CHECK = 1  # doctor found a failing check (also: unexpected internal error)
EXIT_USAGE = 2  # bad arguments, unreadable/invalid ops file, request rejected as malformed (HTTP 400)
EXIT_NOT_RUNNING = 3  # the daemon is not running (also what `status`/`stop` return)
EXIT_AUTOSTART = 4  # autostart/port failure (enable/disable, port taken)
EXIT_NOT_FOUND = 5  # unknown wall (HTTP 404)
EXIT_FORBIDDEN = 8  # request refused by the loopback guard (HTTP 403)
EXIT_CONFLICT = 9  # stale --base-rev, wall exists, nothing to undo/redo (HTTP 409)
EXIT_OP_REFUSED = 10  # the reducer refused an op: locked item, unknown id, ... (HTTP 422)
EXIT_MISSING_DEP = 127

EXIT_TABLE: tuple[tuple[int, str], ...] = (
    (EXIT_OK, "success"),
    (EXIT_FAILED_CHECK, "a doctor check failed / unexpected internal error"),
    (EXIT_USAGE, "invalid arguments, ops file or request body"),
    (EXIT_NOT_RUNNING, "the daemon is not running (run: hsw-editor start)"),
    (EXIT_AUTOSTART, "autostart or port failure (enable/disable, port taken)"),
    (EXIT_NOT_FOUND, "unknown wall"),
    (EXIT_FORBIDDEN, "request refused by the loopback guard"),
    (EXIT_CONFLICT, "conflict: stale --base-rev, wall exists, nothing to undo/redo"),
    (EXIT_OP_REFUSED, "an op was refused (locked item, unknown id, ...); nothing applied"),
    (EXIT_MISSING_DEP, "a required tool (bun, agent-tools lib) is missing"),
)

EXIT_EPILOG = "exit codes:\n" + "\n".join(f"  {code:<4}{text}" for code, text in EXIT_TABLE)


@dataclass(eq=False)
class NotRunningError(AgentToolError):
    """The daemon is not reachable. Exit 3."""

    exit_code: int = EXIT_NOT_RUNNING


@dataclass(eq=False)
class ConflictError(AgentToolError):
    """HTTP 409. Exit 9."""

    exit_code: int = EXIT_CONFLICT


@dataclass(eq=False)
class OpRefusedError(AgentToolError):
    """HTTP 422: the reducer refused an op. Exit 10."""

    exit_code: int = EXIT_OP_REFUSED


@dataclass(eq=False)
class AutostartError(AgentToolError):
    """Autostart or port failure. Exit 4."""

    exit_code: int = EXIT_AUTOSTART
