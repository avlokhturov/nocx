#!/bin/sh
# Negative fixture gate — assert ALL required eslint-plugin-solid rules fire,
# and that at least one rule fires from a .ts file (not only .tsx).
# Run from the frontend/ directory (e.g. via `npm run lint:fixture-check`).
# Exits 0 if all rules fire, 1 otherwise.
set -eu

fixture_dir="lint-fixtures"
expected_rules="solid/no-destructure solid/reactivity solid/no-react-deps solid/no-react-specific-props solid/prefer-for solid/prefer-show solid/components-return-once"

# Run eslint with JSON output so we can check rule IDs reliably.
eslint_json=$(npx eslint --no-ignore "$fixture_dir" --quiet --format json 2>/dev/null) || true

# Collect every rule ID that fired using node to parse JSON.
fired_rules=$(echo "$eslint_json" | node -e "
let d='';
process.stdin.resume();
process.stdin.on('data',function(c){d+=c;});
process.stdin.on('end',function(){
  try {
    var r=JSON.parse(d);
    var rules=[...new Set(r.flatMap(function(f){return f.messages.map(function(m){return m.ruleId;});}))];
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
  echo "SOLID LINT FIXTURE GATE FAILED — the following rule(s) did not fire:$missing"
  exit 1
fi

# Assert that solid/reactivity fires from a .ts file specifically — not merely
# from somewhere in the fixture directory. The brief requires this because the
# next epic deliverable (a Solid store) is .ts and the most dangerous silent
# disable is a .ts-only regression that .tsx fixtures cannot catch.
# As of eslint-plugin-solid 0.14.5, solid/reactivity fires in .ts for signal
# reads in plain callbacks (no tracking scope).
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

echo "OK — all 7 solid lint rules fired (solid/reactivity confirmed from .ts)"
exit 0

