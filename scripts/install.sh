#!/usr/bin/env bash
# Idempotent installer: dependencies, web build, and the ~/.local/bin/hsw-editor symlink.
# Safe to re-run. Needs no network when the bun cache is warm and the agent-tools lib is checked out
# (AGENT_TOOLS_LIB or ~/dev/agent-tools/lib). Flags: --rebuild (force the web build), --no-build.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/web-build.sh
. "$root/scripts/lib/web-build.sh"
bin_dir="${HSW_EDITOR_BIN_DIR:-$HOME/.local/bin}"
rebuild=0
build=1
for arg in "$@"; do
  case "$arg" in
    --rebuild) rebuild=1 ;;
    --no-build) build=0 ;;
    *) echo "install: unknown flag $arg (use --rebuild or --no-build)" >&2; exit 2 ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "install: $1 not found. $2" >&2; exit 127; }
}
need bun "Install it: curl -fsSL https://bun.sh/install | bash"
need python3 "Install Python 3.11+ (apt install python3)"

agent_tools_lib=""
for candidate in "${AGENT_TOOLS_LIB:-}" "$HOME/dev/agent-tools/lib"; do
  if [ -n "$candidate" ] && [ -d "$candidate/agenttools_service" ]; then agent_tools_lib="$candidate"; break; fi
done
if [ -z "$agent_tools_lib" ]; then
  echo "install: agent-tools lib not found. Check out agent-tools and set AGENT_TOOLS_LIB=<agent-tools>/lib" >&2
  exit 127
fi
# the lifecycle verbs are the library's: 0.3 added restart, the unit-aware start/stop and the readiness wait
if ! PYTHONPATH="$agent_tools_lib" python3 -c 'import agenttools_service as s, sys; sys.exit(tuple(map(int, s.__version__.split(".")[:2])) < (0, 3))'; then
  echo "install: agenttools_service in $agent_tools_lib is older than 0.3. git pull agent-tools" >&2
  exit 127
fi

cd "$root"
# always run: it is a no-op when nothing changed, works offline with a warm cache, and picks up a pulled lockfile
echo "install: bun install --frozen-lockfile"
bun install --frozen-lockfile

if [ "$build" = 1 ]; then
  if [ "$rebuild" = 1 ] || ! web_build_present apps/web/dist; then
    echo "install: building the web app"
    bun run build
  else
    echo "install: web build present (use --rebuild to redo it)"
  fi
fi

mkdir -p "$bin_dir"
ln -sfn "$root/cli/hsw_editor.py" "$bin_dir/hsw-editor"
chmod +x "$root/cli/hsw_editor.py"
echo "install: linked $bin_dir/hsw-editor -> $root/cli/hsw_editor.py"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) echo "install: note: $bin_dir is not on PATH" >&2 ;;
esac

AGENT_TOOLS_LIB="$agent_tools_lib" "$bin_dir/hsw-editor" --version
echo "install: done. Next: hsw-editor doctor && hsw-editor enable   (autostart at login); a running daemon keeps the old code until: hsw-editor restart"
