#!/bin/sh
# Negative fixture gate — assert ALL required eslint-plugin-solid rules fire,
# that the nocx/no-raw-controls and nocx/no-color-literals rules fire,
# that the AST kit-identity scanner matches fixture expectations,
# that the CSS colour grammar checker catches violation patterns,
# and that the CSS integrity checker catches all four of its violation classes.
# Run from the frontend/ directory (e.g. via `npm run lint:fixture-check`).
# Exits 0 if all rules fire, 1 otherwise.
set -eu

fixture_dir="lint-fixtures"
expected_rules="solid/no-destructure solid/reactivity solid/no-react-deps solid/no-react-specific-props solid/prefer-for solid/prefer-show solid/components-return-once nocx/no-raw-controls nocx/no-color-literals nocx/no-inline-markup"

# ── CSS fixture check ─────────────────────────────────────────────────────────
# Run the colour grammar checker on the fixture directory (NOCX_BASELINE_UPDATE
# bypasses baseline filtering so intentional violations are always reported).
css_check=$(NOCX_BASELINE_UPDATE=1 node "${fixture_dir}/check-css-colors.mjs" --dir="${fixture_dir}" 2>/dev/null)
css_violations=$(echo "$css_check" | grep -c '^{' || true)

if [ "$css_violations" -lt 1 ]; then
  echo "CSS COLOUR GATE FAILED — no violations produced by CSS fixture"
  exit 1
fi

# color-mix with red literal (laundering case)
if ! echo "$css_check" | grep -q '"red"'; then
  echo "CSS COLOUR GATE FAILED — color-mix with red literal was not detected (laundering regression)"
  exit 1
fi

# standalone white outside color-mix
if ! echo "$css_check" | grep -q '"white"'; then
  echo "CSS COLOUR GATE FAILED — standalone white was not detected"
  exit 1
fi

# standalone black outside color-mix
if ! echo "$css_check" | grep -q '"black"'; then
  echo "CSS COLOUR GATE FAILED — standalone black was not detected"
  exit 1
fi

# ── CSS integrity fixture check ──────────────────────────────────────────────
# Every rule in check-css-integrity.mjs must fire against the fixture tree.
# These four defects are all valid CSS that the browser accepts silently, so a
# checker that quietly stopped firing would look exactly like a clean codebase.
integrity_check=$(node "${fixture_dir}/check-css-integrity.mjs" \
  --entry="${fixture_dir}/css-integrity-fixture/entry.css" \
  --styles="${fixture_dir}/css-integrity-fixture/styles" 2>/dev/null || true)

for rule in unreachable escaped-dot undefined-var theme-scope bare-type-selector control-css-outside-kit; do
  if ! echo "$integrity_check" | grep -q "\"rule\":\"${rule}\""; then
    echo "CSS INTEGRITY GATE FAILED — rule '${rule}' did not fire on the fixture"
    exit 1
  fi
done

# The narrowed form must NOT be reported: `button.ui-fixture` addresses the component,
# and a rule that forbade it would forbid the correct spelling along with the wrong one.
if [ "$(echo "$integrity_check" | grep -c '"rule":"bare-type-selector"')" -ne 1 ]; then
  echo "CSS INTEGRITY GATE FAILED — expected exactly 1 bare-type-selector hit (the narrowed selector must not be reported)"
  exit 1
fi

# A var() with a fallback is legitimate; reporting it would make the rule noise.
if echo "$integrity_check" | grep -q 'fixture-also-never-declared'; then
  echo "CSS INTEGRITY GATE FAILED — var() with a fallback was reported as undefined"
  exit 1
fi

# A correctly scoped theme rule must not be reported alongside the bare :root.
integrity_theme_hits=$(echo "$integrity_check" | grep -c '"rule":"theme-scope"' || true)
if [ "$integrity_theme_hits" -ne 1 ]; then
  echo "CSS INTEGRITY GATE FAILED — expected exactly 1 theme-scope hit, got ${integrity_theme_hits}"
  exit 1
fi

# ── Kit identity fixture check ──────────────────────────────────────────────
# The AST scanner must find the expected classes and not pick up comment-only
# or querySelector patterns. See check-kit-identities.mjs.
if ! node "${fixture_dir}/check-kit-identities.mjs" 2>&1; then
  echo "FAIL — kit identity scanner did not match fixture expectations"
  exit 1
fi

# ── Role-impersonation fixture check ─────────────────────────────────────────
# nocx/no-role-impersonation must fire on every control hand-rolled from a neutral
# element, and must NOT fire on role=option / role=listbox, which are composite
# domain semantics no kit primitive replaces. Both directions are asserted: a rule
# that over-reaches gets disabled, which is the same outcome as not having it.
# No --format compact: it was dropped from core ESLint, and with `|| true`
# swallowing the error the gate silently measured zero and reported a pass.
role_check=$(npx eslint --no-ignore \
  "${fixture_dir}/nocx-no-role-impersonation.tsx" 2>&1 || true)

role_hits=$(echo "$role_check" | grep -c 'no-role-impersonation' || true)
if [ "$role_hits" -lt 7 ]; then
  echo "ROLE GATE FAILED — expected 7 impersonation reports, got ${role_hits}"
  exit 1
fi

if echo "$role_check" | grep -qE 'role="(option|listbox)"'; then
  echo "ROLE GATE FAILED — the rule reported role=option or role=listbox; it has over-reached"
  exit 1
fi

# ── ESLint fixture check ─────────────────────────────────────────────────────
# Run eslint on .tsx and .ts files (not .css — espree cannot parse CSS).
# The .ts glob is needed for the solid/reactivity .ts fixture.
eslint_json=$(npx eslint --no-ignore "${fixture_dir}/"*.tsx "${fixture_dir}/"*.ts --quiet --format json 2>/dev/null) || true

# Collect every rule ID that fired
fired_rules=$(echo "$eslint_json" | node -e "
let d='';
process.stdin.resume();
process.stdin.on('data',function(c){d+=c;});
process.stdin.on('end',function(){
  try {
    var r=JSON.parse(d);
    var rules=[...new Set(r.flatMap(function(f){return f.messages.map(function(m){return m.ruleId;}).filter(Boolean);}))];
    rules.sort().forEach(function(r){console.log(r);});
  } catch(e) {
    process.exit(2);
  }
});
")

missing=""
for rule in $expected_rules; do
  if ! echo "$fired_rules" | grep -qF "$rule"; then
    missing="$missing $rule"
  fi
done

if [ -n "$missing" ]; then
  echo "LINT FIXTURE GATE FAILED — the following rule(s) did not fire:$missing"
  exit 1
fi

# solid/reactivity must fire from a .ts file specifically
ts_reactivity=$(echo "$eslint_json" | node -e "
let d='';
process.stdin.resume();
process.stdin.on('data',function(c){d+=c;});
process.stdin.on('end',function(){
  try {
    var r=JSON.parse(d);
    var ts=r.filter(function(f){return f.filePath.endsWith('.ts');});
    var rules=[...new Set(ts.flatMap(function(f){return f.messages.map(function(m){return m.ruleId;}).filter(function(id){return id==='solid/reactivity';});}))];
    rules.forEach(function(r){console.log(r);});
  } catch(e) {
    process.exit(2);
  }
});
")

if [ -z "$ts_reactivity" ]; then
  echo "SOLID LINT FIXTURE GATE FAILED — solid/reactivity did not fire from a .ts file"
  exit 1
fi

echo "OK — all 10 lint rules fired; kit identities verified; CSS colour + integrity verified"
exit 0
