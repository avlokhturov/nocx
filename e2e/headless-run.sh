#!/usr/bin/env bash
# Bring up the headless stack and run playwright against it.
#
# The stack is the one AGENTS.md documents — cmd/devharness (real backend, real
# PTY, no wails/GTK/display) plus vite serving the frontend. playwright.config.ts
# switches to it on NOCX_WS_PORT alone.
#
# One owner, three callers. e2e/container-entry.sh runs this after its own
# `npm ci`; ci.yml's e2e-headless job runs it after setup-go/setup-node; a
# developer can run it directly on a machine that already has the toolchain.
# It was inlined in container-entry.sh until ci.yml needed the same recipe, and
# a second copy of "how to start the stand" is exactly the kind of pair that
# agrees until the day one of them is edited (AGENTS.md § the existing answer).
#
# Dependencies are the caller's problem on purpose: this script does not install
# anything, because the container installs into mounted volumes and CI installs
# through actions/setup-*, and a script that did both would be wrong in both.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

WS_PORT="${NOCX_WS_PORT:-9876}"
WEB_PORT="${NOCX_WEB_PORT:-5173}"
work="$(mktemp -d)"

# The home boundary e2e/preflight.ts refuses to start without. It is what stops
# a run rewriting the real settings, SSH profiles, vault documents and shell rc
# files (nocx-ti8w) — and on this path Playwright cannot apply it, because the
# backend is started here rather than by the config.
export NOCX_E2E_HOME_DIR="$work/home"
mkdir -p "$NOCX_E2E_HOME_DIR"

backend_pid=""
vite_pid=""
cleanup() {
  [ -n "$vite_pid" ] && kill "$vite_pid" 2>/dev/null || true
  [ -n "$backend_pid" ] && kill "$backend_pid" 2>/dev/null || true
  # Wait for them to actually go before removing the directory they are writing
  # into. Without this the rm races the backend's last writes and reports
  # "Directory not empty" — observed on macOS, where the shell integration is
  # still flushing into $HOME as the process dies. `wait` on a killed child
  # returns non-zero, hence the guard.
  [ -n "$vite_pid" ] && wait "$vite_pid" 2>/dev/null || true
  [ -n "$backend_pid" ] && wait "$backend_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

echo "=== building devharness ==="
# Built, not `go run`: go run wraps the binary in a child that survives a kill
# of the parent, and an orphaned backend holds the WS port against the next run.
go build -o "$work/devharness" ./cmd/devharness
# The specs that start their own backend look for these three names — distinct
# so parallel suites do not rebuild the file another is executing.
cp "$work/devharness" /tmp/nocx-devharness
cp "$work/devharness" /tmp/nocx-devharness-vault
cp "$work/devharness" /tmp/nocx-devharness-srch

echo "=== backend on 127.0.0.1:$WS_PORT ==="
# The same variables e2e/home-isolation.ts strips: XDG_CONFIG_HOME outranks
# $HOME, and the shell entry points let the login shell a PTY spawns read back
# out of the boundary.
env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u ZDOTDIR -u BASH_ENV -u ENV \
  HOME="$NOCX_E2E_HOME_DIR" \
  NOCX_NO_SYSTEM_KEYSTORE=1 \
  NOCX_WS_ADDR="127.0.0.1:$WS_PORT" \
  "$work/devharness" >"$work/backend.log" 2>&1 &
backend_pid=$!

# WSTOKEN is printed after WSPORT, so waiting on it means both are readable.
for _ in $(seq 1 200); do
  grep -q '^WSTOKEN=' "$work/backend.log" 2>/dev/null && break
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    echo "backend exited before it was ready:" >&2
    cat "$work/backend.log" >&2
    exit 1
  fi
  sleep 0.1
done
token="$(sed -n 's/^WSTOKEN=//p' "$work/backend.log" | head -1)"
port="$(sed -n 's/^WSPORT=//p' "$work/backend.log" | head -1)"
if [ -z "$token" ] || [ -z "$port" ]; then
  echo "backend never reported WSPORT/WSTOKEN:" >&2
  cat "$work/backend.log" >&2
  exit 1
fi

echo "=== frontend on 127.0.0.1:$WEB_PORT ==="
(cd frontend && npx vite --host 127.0.0.1 --port "$WEB_PORT" --strictPort) >"$work/vite.log" 2>&1 &
vite_pid=$!
for _ in $(seq 1 200); do
  curl -sf "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && break
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    echo "vite exited before it was ready:" >&2
    cat "$work/vite.log" >&2
    exit 1
  fi
  sleep 0.1
done

echo "=== playwright ==="
export NOCX_WS_PORT="$port"
export NOCX_WS_TOKEN="$token"
export NOCX_BASE_URL="http://127.0.0.1:$WEB_PORT"

# The backend log is the only account of what the backend actually did, and it
# lives in a mktemp this script deletes on the way out. Copy it where the CI
# artifact upload can find it, whether the run passes or fails.
save_backend_log() {
  mkdir -p test-results/devharness
  cp "$work/backend.log" test-results/devharness/headless-backend.log 2>/dev/null || true
  cp "$work/vite.log" test-results/devharness/headless-vite.log 2>/dev/null || true
}
trap 'save_backend_log; cleanup' EXIT INT TERM

npx playwright test "$@"
