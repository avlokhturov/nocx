#!/bin/sh
# Exercise every branch of the tracker-pull hooks with a stub bd on PATH.
#
# Contract under test (nocx-wj4): these hooks NEVER block git. Exit 0 in every
# case — missing bd, no database, unreachable remote, hung pull — and warn only
# when something genuinely failed. This is the opposite of the push side, which
# blocks on purpose; see .githooks/beads-hook.sh for why.
#
# Run: sh scripts/test-beads-pull-hook.sh
set -u

REPO=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
STUB=$(mktemp -d)
PASS=0
FAIL=0

check() { # check <label> <expected-exit> <actual-exit> <expect-warn:yes|no> <output>
    _label=$1 _want=$2 _got=$3 _warn=$4 _out=$5
    _ok=true
    [ "$_got" = "$_want" ] || { _ok=false; echo "  exit: want $_want got $_got"; }
    case $_warn in
        yes) printf '%s' "$_out" | grep -q WARN || { _ok=false; echo "  expected a WARN, got none"; } ;;
        no)  printf '%s' "$_out" | grep -q WARN && { _ok=false; echo "  unexpected WARN: $_out"; } ;;
    esac
    if $_ok; then echo "OK:   $_label"; PASS=$((PASS + 1)); else echo "FAIL: $_label"; FAIL=$((FAIL + 1)); fi
}

run_hook() { # run_hook <hook> [args...] -> prints output, sets HOOK_EXIT
    _hook=$1; shift
    HOOK_OUT=$(PATH="$STUB:$PATH" BEADS_PULL_TIMEOUT=2 sh "$REPO/.githooks/$_hook" "$@" 2>&1)
    HOOK_EXIT=$?
}

make_bd() { printf '#!/bin/sh\n%s\n' "$1" > "$STUB/bd"; chmod +x "$STUB/bd"; }

echo "=== post-merge ==="

# 1. bd present, pull succeeds
make_bd 'exit 0'
run_hook post-merge
check "success is silent" 0 "$HOOK_EXIT" no "$HOOK_OUT"

# 2. bd exits 3 — no beads database in this clone
make_bd 'exit 3'
run_hook post-merge
check "no database (exit 3) skips silently" 0 "$HOOK_EXIT" no "$HOOK_OUT"

# 3. genuine failure — warn, but never block the merge
make_bd 'echo "remote unreachable" >&2; exit 1'
run_hook post-merge
check "genuine failure warns and returns 0" 0 "$HOOK_EXIT" yes "$HOOK_OUT"

# 4. hang — the timeout must fire and must not block
make_bd 'sleep 30'
run_hook post-merge
check "hang hits BEADS_PULL_TIMEOUT and returns 0" 0 "$HOOK_EXIT" yes "$HOOK_OUT"

# 5. bd absent entirely — a contributor who does not use beads.
# Can't just trim PATH: on NixOS bd and coreutils share /run/current-system/sw/bin,
# so dropping bd's directory also drops dirname and the hook dies for the wrong
# reason. Build a PATH that has the utilities the hook needs and no bd.
NOBD=$(mktemp -d)
for _u in dirname timeout sleep grep sh env; do
    _p=$(command -v "$_u" 2>/dev/null) && ln -sf "$_p" "$NOBD/$_u"
done
[ -e "$NOBD/dirname" ] || { echo "FAIL: test setup — no dirname to link"; FAIL=$((FAIL + 1)); }
rm -f "$STUB/bd"
HOOK_OUT=$(PATH="$NOBD" sh "$REPO/.githooks/post-merge" 2>&1); HOOK_EXIT=$?
check "bd absent skips silently" 0 "$HOOK_EXIT" no "$HOOK_OUT"
rm -rf "$NOBD"

echo "=== post-rewrite ==="

# 6. amend must not pay for a network round trip
make_bd 'echo "bd SHOULD NOT RUN"; exit 0'
run_hook post-rewrite amend
check "amend does not pull" 0 "$HOOK_EXIT" no "$HOOK_OUT"
printf '%s' "$HOOK_OUT" | grep -q "SHOULD NOT RUN" && { echo "FAIL: amend invoked bd"; FAIL=$((FAIL + 1)); } || { echo "OK:   amend left bd alone"; PASS=$((PASS + 1)); }

# 7. rebase does pull
make_bd 'echo "bd ran"; exit 0'
run_hook post-rewrite rebase
check "rebase pulls" 0 "$HOOK_EXIT" no "$HOOK_OUT"

# 8. no argument at all — defensive, must not explode under set -eu
run_hook post-rewrite
check "missing arg is inert" 0 "$HOOK_EXIT" no "$HOOK_OUT"

# 9. rebase + failing bd still must not block
make_bd 'exit 1'
run_hook post-rewrite rebase
check "rebase + failure returns 0" 0 "$HOOK_EXIT" yes "$HOOK_OUT"

rm -rf "$STUB"
echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
