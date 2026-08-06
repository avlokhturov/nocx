#!/usr/bin/env bash
# Inside the container: bring up the headless stack, then run playwright.
#
# The stack is the one AGENTS.md documents — cmd/devharness (real backend, real
# PTY, no wails/GTK/display) plus vite serving the frontend with the Wails
# bindings shimmed by e2e/harness.ts. playwright.config.ts switches to it on
# NOCX_WS_PORT alone.
set -euo pipefail

WS_PORT="${NOCX_WS_PORT:-9876}"
WEB_PORT="${NOCX_WEB_PORT:-5173}"
work="$(mktemp -d)"

# The home boundary e2e/preflight.ts refuses to start without. Belt and braces
# inside a container that is already isolated: the variable is what the suite
# checks, and a run that skipped it would be testing the wrong claim.
export NOCX_E2E_HOME_DIR="$work/home"
mkdir -p "$NOCX_E2E_HOME_DIR"

backend_pid=""
vite_pid=""
cleanup() {
  [ -n "$vite_pid" ] && kill "$vite_pid" 2>/dev/null || true
  [ -n "$backend_pid" ] && kill "$backend_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

echo "=== npm ci (root + frontend) ==="
npm ci --silent
(cd frontend && npm ci --silent)

echo "=== building devharness ==="
# Built, not `go run`: go run wraps the binary in a child that survives a kill
# of the parent, and an orphaned backend holds the WS port against the next run.
go build -o "$work/devharness" ./cmd/devharness
# The specs that start their own backend look for these three names — the same
# three ci.yml builds, for the same reason (distinct names so parallel suites do
# not rebuild the file another is executing).
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
npx playwright test "$@"
