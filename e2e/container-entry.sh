#!/usr/bin/env bash
# Inside the container: install dependencies, then hand over to the shared
# headless recipe.
#
# Only the install is container-specific — it targets the mounted node_modules
# volumes, which is why it cannot live in e2e/headless-run.sh, where CI's
# actions/setup-* has already done the equivalent. Everything after it (build
# devharness, start the backend behind a home boundary, start vite, run
# playwright) is the same stack ci.yml's e2e-headless job needs, so it lives in
# one place and the two cannot drift.
set -euo pipefail

# The repo is bind-mounted from the host, so its files are owned by the host
# user while this container runs as root. Git calls that "dubious ownership"
# and refuses, and `go build` stamps VCS info by default — so the devharness
# build died on "error obtaining VCS status: exit status 128" before a single
# spec ran. Declaring the mount safe is the fix that leaves `go build` spelled
# the same here as in headless-run.sh, on CI and on a developer's machine;
# -buildvcs=false would have made this one path build something subtly
# different from everywhere else.
git config --global --add safe.directory /work

echo "=== npm ci (root + frontend) ==="
npm ci --silent
(cd frontend && npm ci --silent)

# `npx playwright test` is the whole command — the same one a developer runs
# and the same one CI runs. The stand (backend + vite) is Playwright's, so
# nothing here starts or knows about it.
exec npx playwright test "$@"
