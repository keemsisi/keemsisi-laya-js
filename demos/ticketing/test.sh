#!/usr/bin/env bash
# Build and test the ticketing demo.
#
# Every demo exposes this same entry point - demos/<name>/test.sh - printing a
# final "N passed, M failed" line, so tools/test-all.mjs can run it without
# knowing what it is built with.
set -uo pipefail
cd "$(dirname "$0")"

fail=0
# esbuild strips types without checking them, so the app is typechecked separately.
if npx tsc -p . >/tmp/laya-ticketing.log 2>&1; then echo "  ok    typecheck (strict)"
else fail=1; echo "  FAIL  typecheck"; tail -20 /tmp/laya-ticketing.log | sed 's/^/        /'; fi

if node build.mjs >/tmp/laya-ticketing.log 2>&1; then echo "  ok    bundle"
else fail=1; echo "  FAIL  bundle"; tail -20 /tmp/laya-ticketing.log | sed 's/^/        /'; fi

out=$(node test/app.test.mjs 2>&1)
line=$(echo "$out" | grep -E '[0-9]+ passed' | tail -1)
if echo "$line" | grep -q "0 failed"; then
  echo "  ok    app (jsdom)  $line"
else
  fail=1; echo "  FAIL  app (jsdom)  ${line:-no summary}"; echo "$out" | tail -20 | sed 's/^/        /'
fi

echo
if [ "$fail" -eq 0 ]; then echo "${line:-0 passed, 0 failed}"; else echo "${line:-0 passed}, 1 or more failed"; exit 1; fi
