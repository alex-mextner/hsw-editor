#!/usr/bin/env bash
# Web build with a success stamp (see scripts/lib/web-build.sh): the stamp is removed first and written only after
# the build command succeeded, so a failed or interrupted build never reads as a finished one.
# HSW_WEB_BUILD_CMD replaces the build command (tests).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/web-build.sh
. "$root/scripts/lib/web-build.sh"
cd "$root/apps/web"
rm -f "dist/$WEB_BUILD_STAMP"
${HSW_WEB_BUILD_CMD:-vite build}
mkdir -p dist
touch "dist/$WEB_BUILD_STAMP"
