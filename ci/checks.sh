#!/usr/bin/env bash
# The checks every pull request must pass: build the vinext package and run
# its unit tests. The Playwright suite is `bash run_tests.sh`.
set -euo pipefail
cd "$(dirname "$0")/../vinext"
npm install --offline --no-audit --no-fund
npm run build
npm test
