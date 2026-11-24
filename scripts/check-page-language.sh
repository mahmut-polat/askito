#!/bin/bash
# Opens a throwaway inbox in headless Chrome (no window) and prints the tab
# labels the page shows, so the default interface language can be checked.
# Usage: scripts/check-page-language.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d -t askito-lang)"
port=45995
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export ASKITO_HOME="$work/home" ASKITO_PORT="$port" ASKITO_NO_NOTIFY=1

cleanup() {
  node "$root/bin/askito.js" stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

node "$root/bin/askito.js" start >/dev/null
url="$(node "$root/bin/askito.js" open --url)"
# A fresh profile, so neither the owner's Chrome nor an earlier language pick is involved.
"$chrome" --headless=new --disable-gpu --no-first-run --user-data-dir="$work/chrome" \
  --lang=tr-TR --timeout=6000 --dump-dom "$url" 2>/dev/null |
  grep -o 'role="tab"[^>]*>[^<]*' | sed 's/.*>//'
