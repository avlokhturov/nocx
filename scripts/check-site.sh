#!/usr/bin/env bash
# Structural gate for site/. Three checks, each bought by a defect with a
# known way of happening; see spec §11 in
# .internal/specs/2026-08-20-github-landing-design.md.
#
# What this cannot do is verify that a claim on the page is true. Check 3 is
# the closest available: it refuses wordings already established as false.
# The claims themselves are read by eye against spec §7.
#
# bash 3.2 compatible on purpose: this runs from the pre-commit hook, and
# macOS still ships bash 3.2, where `mapfile` does not exist. Filenames under
# site/ are ours and contain no newlines, so word-splitting on \n is safe here
# and buys portability that a -print0 pipeline would cost.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
site="$root/site"
phrases="$root/scripts/site-forbidden-phrases.txt"
fail=0

if [ ! -d "$site" ]; then
  echo "FAIL: $site does not exist"
  exit 1
fi

# Newline-separated, iterated with IFS set to newline only. Every loop below
# runs in THIS shell, never behind a pipe: a `while read` on the right of a |
# runs in a subshell, so `fail=1` set inside it is discarded and the script
# exits 0 while printing FAIL. That bug is silent and total.
pages="$(find "$site" -name '*.html' | sort)"

if [ -z "$pages" ]; then
  echo "FAIL: no HTML under $site"
  exit 1
fi

page_count="$(printf '%s\n' "$pages" | wc -l | tr -d ' ')"

IFS='
'

# 1. Root-absolute paths. The site is served from /nocx/, so href="/style.css"
#    resolves against the *user* page and yields an unstyled document. This is
#    the classic Project Pages failure and it is invisible in local preview,
#    where the page usually sits at the server root.
for f in $pages; do
  hits="$(grep -nE '(href|src)="/' "$f" | grep -v '="//' || true)"
  if [ -n "$hits" ]; then
    echo "FAIL: ${f#$root/} has a root-absolute path; the site is served from a subdirectory"
    printf '%s\n' "$hits" | sed 's/^/       /'
    fail=1
  fi
done

# 2. Every referenced local asset exists. A hero that 404s is worse than no
#    hero, and it survives review because the alt text still reads fine.
for f in $pages; do
  refs="$(grep -oE '(src|href)="\./[^"]+"' "$f" |
    sed -E 's/^(src|href)="\.\///; s/"$//' || true)"
  for rel in $refs; do
    [ -n "$rel" ] || continue
    if [ ! -f "$site/$rel" ]; then
      echo "FAIL: ${f#$root/} references a missing asset: $rel"
      fail=1
    fi
  done
done

# 3. Forbidden phrasings (spec §7).
if [ ! -f "$phrases" ]; then
  echo "FAIL: $phrases is missing"
  exit 1
fi

phrase_list="$(grep -vE '^[[:space:]]*(#|$)' "$phrases" || true)"

for phrase in $phrase_list; do
  for f in $pages; do
    hits="$(grep -niF -- "$phrase" "$f" || true)"
    if [ -n "$hits" ]; then
      echo "FAIL: ${f#$root/} contains the forbidden phrase \"$phrase\" (spec §7)"
      printf '%s\n' "$hits" | sed 's/^/       /'
      fail=1
    fi
  done
done

unset IFS

if [ "$fail" -ne 0 ]; then
  echo
  echo "check-site failed. The honesty ledger is spec §7 in"
  echo ".internal/specs/2026-08-20-github-landing-design.md — read the row before"
  echo "editing either the page or the phrase list."
  exit 1
fi

echo "OK:   check-site ($page_count page(s))"
