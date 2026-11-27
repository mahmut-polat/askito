#!/usr/bin/env bash
# Checks the Claude Code panel mod: the engine's validator, then its tests if it has any.
# Usage: bash scripts/check-panel.sh
set -euo pipefail
cd "$(dirname "$0")/.."
claude plugin validate plugins/askito-panel
if compgen -G "plugins/askito-panel/hooks/*.test.ts*" > /dev/null; then
  claude plugin test plugins/askito-panel
fi
