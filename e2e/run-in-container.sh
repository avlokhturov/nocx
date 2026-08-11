#!/usr/bin/env bash
# Run the e2e suite's headless path inside a container.
#
# The boundary is the container: a Linux image has no macOS keychain for
# app.New's startup probe to write to, and no real $HOME of yours to reach.
# See e2e/Dockerfile for why that matters.
#
#   e2e/run-in-container.sh                       # whole suite, both browsers
#   e2e/run-in-container.sh e2e/sidebar.spec.ts   # one spec
#   PW_PROJECTS=chromium e2e/run-in-container.sh  # one browser
#   NOCX_E2E_CPUS=0 e2e/run-in-container.sh       # uncapped, while iterating
#   NOCX_LOG_LEVEL=debug e2e/run-in-container.sh  # the backend says more
#
# The backend's log is inside the disposable home, at
# .e2e/home/.local/share/nocx-dev/nocx.log. Read it BEFORE the Playwright
# output when a spec fails on a timeout: it named a fixture defect in one line
# after the trace had spent thirteen minutes describing a hidden editor
# (nocx-cbtc).
#
# Everything after the script name is passed to `playwright test`.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="nocx-e2e:local"

echo "=== building $image (cached after the first run) ==="
docker build -q -f "$repo_root/e2e/Dockerfile" -t "$image" "$repo_root/e2e" >/dev/null

# node_modules and the Go build cache live in named volumes rather than in the
# bind mount: the host's are macOS/arm64 artefacts and the container is Linux,
# so sharing them produces "cannot execute binary file" at best and a silently
# wrong build at worst.
#
# BOTH node_modules trees, not just the root one. The entry script runs `npm ci`
# in frontend/ too, and with that directory bind-mounted the container's Linux
# install landed on the host's — which npm then reported on the Mac as
# "Cannot find module '@rollup/rollup-darwin-arm64'", because it was holding
# @rollup/rollup-linux-arm64-gnu instead. `npm test` on the host broke after
# every container run until this line existed.
docker volume create nocx-e2e-node >/dev/null
docker volume create nocx-e2e-fenode >/dev/null
docker volume create nocx-e2e-gocache >/dev/null

# -t only when there is a terminal to attach: the same script runs from a
# scripted context, where docker refuses "the input device is not a TTY".
tty_flag=()
[ -t 0 ] && [ -t 1 ] && tty_flag=(-t)

# The +"…" guard is not decoration: under `set -u`, bash 3.2 — still /bin/bash
# on macOS — treats an EMPTY array expansion as an unbound variable.
# Who to hand the run's output back to.
#
# The container runs as root on a bind-mounted repo, so everything it writes —
# .e2e/ (the disposable home) and test-results/ — lands root-owned in the
# developer's checkout. That is not merely untidy: `npx eslint .` and
# `npx prettier --check .` walk the filesystem, and both died on EACCES before
# examining a single file, so the local gate was broken by the local test run
# (nocx-z9s9.8). Ignore rules do not help — the walker fails while expanding the
# directory, before any ignore applies.
#
# Passed in rather than guessed inside: only out here is there a host user to
# ask about.
# A CPU cap, because the image is not the whole of "the same conditions".
#
# The container made the two runs identical in software and left them different
# in capacity: this developer box has many cores, and ubuntu-latest gives four.
# Measured 2026-08-07 at the same commit — the suite takes 6.3 minutes here and
# 10.6 on the runner — and every failure that survived the move to the container
# was a timing one that only appeared on the slower side: a bell racing a tab
# open, a command snapshot arriving past its budget, a drag losing focus.
#
# So this exists to reproduce the runner rather than to out-run it, and that is
# why it is the DEFAULT rather than the thing you remember to reach for. It was
# opt-in, on the argument that an uncapped run is faster while iterating on one
# spec — which is true, and is why the escape hatch below still exists. But the
# default is what a developer actually runs before pushing, and a default that
# differs from CI is the divergence this whole file was built to remove: the
# capacity gap is now the ONLY thing left between this command and the runner,
# so leaving it off by default meant nobody was reproducing CI unless they knew
# to. `scripts/ci-linux.sh` already defaults its own cap to 4 for the same
# reason; two sibling scripts answering one question two ways is the defect.
#
# NOCX_E2E_CPUS=0 opts out for a fast single-spec loop. Override the number
# when GitHub changes the runner tier — the same knob `scripts/ci-linux.sh`
# documents.
cpus="${NOCX_E2E_CPUS:-4}"
cpu_flag=()
[ "$cpus" != "0" ] && cpu_flag=(--cpus "$cpus")

# A git worktree keeps no .git DIRECTORY — it keeps a .git FILE pointing at
# `<main-repo>/.git/worktrees/<name>`, which is outside the bind mount. The
# container then answers "fatal: not a git repository", and because
# container-entry.sh builds devharness with `go build` — which stamps VCS
# info, deliberately spelled the same way here as on CI — the run dies before
# a single spec starts.
#
# So mount the common git dir at its own absolute path, which is where the
# .git file's `gitdir:` line says to look. Nothing is written to it: read-only
# says so, and the only reader is `go build` asking what commit this is.
#
# Empty for an ordinary checkout, whose .git is a directory already inside the
# mount. This is what lets the suite run from an Orca-managed worktree, which
# is where the git-manager epic was built.
git_flag=()
if [ -f "$repo_root/.git" ]; then
  git_common="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$git_common" ] && git_flag=(-v "$git_common:$git_common:ro")
fi

exec docker run --rm -i ${tty_flag[@]+"${tty_flag[@]}"} \
  ${cpu_flag[@]+"${cpu_flag[@]}"} \
  ${git_flag[@]+"${git_flag[@]}"} \
  -v "$repo_root:/work" \
  -v nocx-e2e-node:/work/node_modules \
  -v nocx-e2e-fenode:/work/frontend/node_modules \
  -v nocx-e2e-gocache:/root/.cache/go-build \
  -e PW_PROJECTS="${PW_PROJECTS:-}" \
  -e PW_WORKERS="${PW_WORKERS:-}" \
  -e NOCX_LOG_LEVEL="${NOCX_LOG_LEVEL:-}" \
  -e NOCX_E2E_HOST_UID="$(id -u)" \
  -e NOCX_E2E_HOST_GID="$(id -g)" \
  -w /work \
  "$image" \
  bash -euo pipefail /work/e2e/container-entry.sh "$@"
