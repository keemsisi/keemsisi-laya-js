#!/usr/bin/env bash
# Test the tetris demo.
#
# Every demo exposes this same entry point - demos/<name>/test.sh - printing a
# final line stating a count, so tools/test-all.mjs can run it without knowing
# what it is built with. This one delegates to the demo's own runner, which
# covers six suites of its own.
set -uo pipefail
cd "$(dirname "$0")"
exec node tests/all.js
