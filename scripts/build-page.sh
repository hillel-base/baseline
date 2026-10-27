#!/usr/bin/env bash
# Builds the local page (web/dist, as `npm run build` does) and writes baseline-page.zip: dist/ and COMMIT (the short hash).
# The release workflow attaches the zip to the release; setup downloads it when Node is missing. Needs Node 22.12 or newer.
#   scripts/build-page.sh [out.zip]     (default: baseline-page.zip in the repository folder)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/baseline-page.zip}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
(cd "$ROOT/web" && npm ci && npm run build)  # npm_config_registry, if set, is passed through
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
cp -R "$ROOT/web/dist" "$STAGE/dist"
git -C "$ROOT" rev-parse --short HEAD > "$STAGE/COMMIT"
rm -f "$OUT"
(cd "$STAGE" && zip -qr "$OUT" dist COMMIT)
echo "Wrote $OUT (commit $(cat "$STAGE/COMMIT"), $(wc -c < "$OUT" | tr -d ' ') bytes)"
