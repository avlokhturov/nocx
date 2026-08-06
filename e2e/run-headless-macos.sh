#!/usr/bin/env bash
# Run the e2e suite's headless path natively on macOS.
#
# WHY THIS EXISTS ALONGSIDE THE CONTAINER. The container is Linux, and two of
# the three CI jobs run on macOS VMs — GitHub does not containerise those, and
# macOS cannot be containerised at all. Specs that drive a real shell see a
# different product there: the completion specs run bash, and macOS ships bash
# 3.2 while a Linux image ships 5.x. Those failures are invisible in the
# container by construction. This script is how they become visible.
#
# WHAT IT TOUCHES, precisely, because it runs on a real person's machine:
#
#   $HOME            a fresh mkdtemp, thrown away at exit. This is what moves
#                    ~/.config/nocx-dev, ~/.nocx and the shell rc files out of
#                    reach; the backend resolves all of them from $HOME.
#   ~/.ssh/config    not read — it is under the disposable $HOME.
#   XDG_*            stripped, not overridden: XDG_CONFIG_HOME outranks $HOME.
#   ZDOTDIR/BASH_ENV/ENV
#                    stripped, so a shell a PTY spawns cannot read back out.
#   $TMPDIR          specs create their own mkdtemp fixtures here and remove
#                    them; this script does not redirect it.
#   the repo         read-only in practice: the suite writes only test-results/
#                    and .e2e/, both git-ignored.
#
#   the keychain      NOT TOUCHED, and this is the line that does it:
#                     NOCX_NO_SYSTEM_KEYSTORE=1 below. app.New otherwise probes
#                     the OS keystore at every backend start, and that probe is
#                     a real keychain call. $HOME does not move a keychain to
#                     safety — it moves it to NOTHING, because macOS looks for
#                     the login keychain under ~/Library/Keychains and a
#                     disposable home has none. The result was a "Keychain not
#                     found" dialog on the developer's own screen, once per
#                     start (nocx-o4hg). With the variable set, the backend has
#                     no system provider at all and never calls out.
#
# If a keychain dialog appears anyway, stop the run and report it: something is
# reaching the keystore that this switch does not cover.
#
#   e2e/run-headless-macos.sh                          # whole suite
#   e2e/run-headless-macos.sh e2e/completion.spec.ts   # one spec
#   PW_PROJECTS=chromium e2e/run-headless-macos.sh     # one browser
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

WS_PORT="${NOCX_WS_PORT:-9886}"
WEB_PORT="${NOCX_WEB_PORT:-5186}"
work="$(mktemp -d "${TMPDIR:-/tmp}/nocx-e2e-macos.XXXXXX")"

export NOCX_E2E_HOME_DIR="$work/home"
mkdir -p "$NOCX_E2E_HOME_DIR"

real_home="$HOME"
backend_pid=""
vite_pid=""
cleanup() {
  [ -n "$vite_pid" ] && kill "$vite_pid" 2>/dev/null || true
  [ -n "$backend_pid" ] && kill "$backend_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

echo "=== boundary ==="
echo "    real home : $real_home  (must stay untouched)"
echo "    test home : $NOCX_E2E_HOME_DIR"

# Recorded, not guessed. The paths a leak would land in, with their mtimes, so
# the check at the end compares rather than asks the operator to remember.
watched=("$real_home/.nocx" "$real_home/.bashrc" "$real_home/.zshrc" \
  "$real_home/.ssh/config" "$real_home/Library/Application Support/nocx-dev")
snapshot() {
  for w in "${watched[@]}"; do
    if [ -e "$w" ]; then printf '%s\t%s\n' "$w" "$(stat -f '%m' "$w")"; else printf '%s\tabsent\n' "$w"; fi
  done
}
snapshot > "$work/home-before.tsv"

echo "=== building devharness (once — a stable binary keeps the keychain quiet) ==="
go build -o "$work/devharness" ./cmd/devharness
# The three names the specs that start their own backend look for.
cp "$work/devharness" /tmp/nocx-devharness
cp "$work/devharness" /tmp/nocx-devharness-vault
cp "$work/devharness" /tmp/nocx-devharness-srch

echo "=== backend on 127.0.0.1:$WS_PORT ==="
# The same variables e2e/home-isolation.ts strips, stripped the same way.
env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u ZDOTDIR -u BASH_ENV -u ENV \
  HOME="$NOCX_E2E_HOME_DIR" \
  NOCX_NO_SYSTEM_KEYSTORE=1 \
  NOCX_WS_ADDR="127.0.0.1:$WS_PORT" \
  "$work/devharness" >"$work/backend.log" 2>&1 &
backend_pid=$!

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
for _ in $(seq 1 300); do
  curl -sf "http://127.0.0.1:$WEB_PORT/" >/dev/null 2>&1 && break
  if ! kill -0 "$vite_pid" 2>/dev/null; then
    echo "vite exited before it was ready:" >&2
    cat "$work/vite.log" >&2
    exit 1
  fi
  sleep 0.1
done

echo "=== playwright ==="
set +e
NOCX_WS_PORT="$port" NOCX_WS_TOKEN="$token" NOCX_BASE_URL="http://127.0.0.1:$WEB_PORT" \
  npx playwright test "$@"
status=$?
set -e

# The boundary, checked rather than asserted.
snapshot > "$work/home-after.tsv"
if ! diff -q "$work/home-before.tsv" "$work/home-after.tsv" >/dev/null; then
  echo "" >&2
  echo "BOUNDARY LEAK — the real home changed during this run:" >&2
  diff "$work/home-before.tsv" "$work/home-after.tsv" >&2 || true
  echo "That is a bug worth filing, and worth stopping for." >&2
  exit 1
fi
echo "=== boundary held: the real home is byte-for-byte as it was ==="
exit $status
