#!/usr/bin/env bash
# Checks the Claude panel plugin the way Claude Code will load it.
# Usage: bash scripts/check-panel.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
claude plugin validate "$root/plugins/askito-panel"
