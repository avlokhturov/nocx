#!/usr/bin/env bash
# Deprecated: `npx playwright test` is the command.
#
# This script used to bring up the stand — build devharness, start it behind a
# home boundary, start vite, export NOCX_WS_PORT — and then run playwright
# against it. That made two arrangements for one suite: the config started
# `wails dev` when nobody had done this, and seven specs could only run on the
# path this script produced. playwright.config.ts owns the stand now
# (e2e/stand.ts), so doing any of it here would start a second backend and
# fight the first for the port.
#
# Kept as a forwarder so a habit, a bookmark or a stale doc reaches the right
# place instead of a "file not found", and so the change is visible to whoever
# still types it.
set -euo pipefail
echo "e2e/headless-run.sh is deprecated — the stand is Playwright's now." >&2
echo "Running: npx playwright test $*" >&2
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec npx playwright test "$@"
