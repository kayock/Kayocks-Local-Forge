#!/usr/bin/env bash
# Build sanitized, independently usable source archives for the web IDE and
# standalone Companion. Run from any working directory.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p download

VERSION=$(node -p "require('./companion/package.json').version")
OUT=download/localforge-ide-source.zip
COMP=download/localforge-companion-source-${VERSION}.zip
rm -f "$OUT" "$COMP"

# Explicit source manifest: do not recurse into root, db, download, .next,
# node_modules, local logs, credentials or generated runtime state.
zip -q -r "$OUT" \
  src public/robots.txt public/logo.svg prisma/schema.prisma \
  companion/src companion/test companion/package.json companion/package-lock.json \
  companion/README.md companion/.env.example \
  docs e2e tests scripts installer .zscripts \
  README.md Caddyfile components.json eslint.config.mjs next-env.d.ts \
  next.config.ts postcss.config.mjs tsconfig.json .gitignore .env.example \
  package.json bun.lock package-lock.json

( cd companion && zip -q -r "../$COMP" \
    src test package.json package-lock.json README.md .env.example )

# Both manifests are deliberately explicit, but verify all names anyway.
check_archive() {
  local archive="$1"
  test -s "$archive"
  unzip -tqq "$archive"
  if unzip -Z -1 "$archive" | grep -E '(^|/)(\.env($|\.)|node_modules(/|$)|\.next(/|$)|[^/]*\.(db|sqlite[0-9]?|pem|key|exe)$|dev\.log$|server\.log$)' | grep -Ev '(^|/)\.env\.example$' >/dev/null; then
    echo "ERROR: forbidden file in $archive" >&2
    exit 1
  fi
}
check_archive "$OUT"
check_archive "$COMP"
echo "Source archives prepared: $OUT and $COMP (Companion $VERSION)"
