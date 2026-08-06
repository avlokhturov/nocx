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

echo "=== npm ci (root + frontend) ==="
npm ci --silent
(cd frontend && npm ci --silent)

exec /work/e2e/headless-run.sh "$@"
