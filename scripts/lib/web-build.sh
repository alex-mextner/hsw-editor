#!/usr/bin/env bash
# Shared by scripts/install.sh and its test. The stamp name must match WEB_BUILD_STAMP in cli/hswlib/doctor.py
# and the "build" script of apps/web/package.json.
WEB_BUILD_STAMP=".build-ok"

# A build counts only when it finished: the stamp is written after `vite build` succeeds, so an index.html
# left behind by a failed or interrupted build is not enough.
web_build_present() {
  [ -f "$1/index.html" ] && [ -f "$1/$WEB_BUILD_STAMP" ]
}
