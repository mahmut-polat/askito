#!/bin/sh
# Commits the named files with a message from a file and pushes main, the way
# the owner's rules ask: fetch and rebase onto origin/main right before the
# commit and again right before the push. Never forces anything.
#
# Usage: bash scripts/ship.sh MESSAGE_FILE FILE [FILE...]
set -eu

if [ "$#" -lt 2 ]; then
  echo "usage: bash scripts/ship.sh MESSAGE_FILE FILE [FILE...]" >&2
  exit 2
fi
message=$1
shift
[ -s "$message" ] || { echo "ship: message file is empty or missing: $message" >&2; exit 2; }

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || { echo "ship: on $branch, not main" >&2; exit 2; }

git fetch origin
git rebase --autostash origin/main
git add -- "$@"
if git diff --cached --quiet; then
  echo "ship: nothing staged" >&2
  exit 1
fi
git commit --quiet -F "$message"
git fetch origin
git rebase --autostash origin/main
git push origin main
git log --oneline -1
