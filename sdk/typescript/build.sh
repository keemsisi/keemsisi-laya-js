#!/usr/bin/env bash
# Build and test the TypeScript SDK.
#
# Every SDK exposes this same entry point - sdk/<language>/build.sh - printing a
# final "N passed, M failed" line. tools/test-all.mjs discovers them; it does not
# know what tsc is, which packages exist, or where this one's suites live.
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"

fail=0
step() {  # step <label> <command...>
  local label="$1"; shift
  if "$@" >/tmp/laya-ts-step.log 2>&1; then
    echo "  ok    $label"
  else
    fail=1
    echo "  FAIL  $label"
    tail -20 /tmp/laya-ts-step.log | sed 's/^/        /'
  fi
}

echo "building packages"
for p in core server react; do step "@laya-js/$p" npx tsc -p "$p"; done

# The packages compile themselves, but only a consumer proves the emitted .d.ts
# files are usable - and esbuild strips types without checking them.
echo "typechecking consumers"
step "type surface (@ts-expect-error assertions)" npx tsc -p conformance

echo "running suites"
passed=0
for suite in core/test/core.test.mjs core/test/client.test.mjs \
             server/test/server.test.mjs react/test/react.test.mjs \
             server/test/real-model.test.mjs; do
  out=$(node "$suite" 2>&1)
  line=$(echo "$out" | grep -E '[0-9]+ (passed|SKIPPED)' | tail -1)
  if echo "$out" | grep -q "SKIPPED"; then
    echo "  skip  $(basename "$suite")  ${line:-skipped}"
  elif echo "$line" | grep -q "0 failed"; then
    echo "  ok    $(basename "$suite")  $line"
    passed=$(( passed + $(echo "$line" | grep -oE '^[0-9]+') ))
  else
    fail=1
    echo "  FAIL  $(basename "$suite")  ${line:-no summary}"
    echo "$out" | tail -20 | sed 's/^/        /'
  fi
done

echo
if [ "$fail" -eq 0 ]; then echo "$passed passed, 0 failed"; else echo "$passed passed, 1 or more failed"; exit 1; fi
