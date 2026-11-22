#!/usr/bin/env bash
# Package the 7 LocalForge Windows release deliverables into one ZIP.
#
# Contents (matches the task's deliverables list):
#   1. LocalForge-Companion-Setup-0.1.0.exe   — Windows x64 installer (NSIS, per-user)
#   2. LocalForgeCompanion/localforge-companion.exe — standalone companion (Bun embedded)
#   3. LocalForgeCompanion/LocalForgeTray.exe — native Win32 tray GUI
#   4. WINDOWS_INSTALL.md                     — installation & troubleshooting doc
#   5. verify-windows-release.py              — automated verification script
#   6. SHA256SUMS.txt                         — SHA-256 checksums (3 binaries)
#   7. localforge-ide-source.zip              — full exportable source ZIP
# Debug files (.pdb) and build intermediates (version.nsi.inc) are excluded.
set -euo pipefail

ROOT=/home/z/my-project
OUT=$ROOT/download/localforge-companion-release-0.1.0.zip
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

# ---- collect the 7 files into a clean staging tree ----
mkdir -p "$STAGE/pkg/LocalForgeCompanion"
cp "$ROOT/download/windows/LocalForge-Companion-Setup-0.1.0.exe"     "$STAGE/pkg/"
cp "$ROOT/download/windows/LocalForgeCompanion/localforge-companion.exe" "$STAGE/pkg/LocalForgeCompanion/"
cp "$ROOT/download/windows/LocalForgeCompanion/LocalForgeTray.exe"   "$STAGE/pkg/LocalForgeCompanion/"
cp "$ROOT/docs/WINDOWS_INSTALL.md"                                   "$STAGE/pkg/"
cp "$ROOT/scripts/verify-windows-release.py"                         "$STAGE/pkg/"
cp "$ROOT/download/windows/SHA256SUMS.txt"                           "$STAGE/pkg/"
cp "$ROOT/download/localforge-ide-source.zip"                        "$STAGE/pkg/"

# ---- verify every staged file is non-empty before zipping ----
for f in \
  "LocalForge-Companion-Setup-0.1.0.exe" \
  "LocalForgeCompanion/localforge-companion.exe" \
  "LocalForgeCompanion/LocalForgeTray.exe" \
  "WINDOWS_INSTALL.md" \
  "verify-windows-release.py" \
  "SHA256SUMS.txt" \
  "localforge-ide-source.zip"; do
  [ -s "$STAGE/pkg/$f" ] || { echo "ERROR: $f missing/empty"; exit 1; }
done

# ---- build the release zip ----
rm -f "$OUT"
(cd "$STAGE/pkg" && zip -q -r "$OUT" .)

# ---- verify: exactly 7 files inside (dirs excluded), byte-identical to sources ----
MEMBERS=$(unzip -l "$OUT" | awk 'NF>=4 && $1 ~ /^[0-9]+$/ && $NF !~ /\/$/ {n++} END{print n+0}')
if [ "$MEMBERS" -ne 7 ]; then echo "ERROR: expected 7 members, found $MEMBERS"; exit 1; fi

cd "$STAGE/pkg"
for f in LocalForge-Companion-Setup-0.1.0.exe \
         LocalForgeCompanion/localforge-companion.exe \
         LocalForgeCompanion/LocalForgeTray.exe \
         WINDOWS_INSTALL.md verify-windows-release.py SHA256SUMS.txt \
         localforge-ide-source.zip; do
  a=$(sha256sum "$f" | cut -d' ' -f1)
  case "$f" in
    LocalForge-Companion-Setup-0.1.0.exe) src="$ROOT/download/windows/$f" ;;
    LocalForgeCompanion/*)                src="$ROOT/download/windows/$f" ;;
    WINDOWS_INSTALL.md)                   src="$ROOT/docs/$f" ;;
    verify-windows-release.py)            src="$ROOT/scripts/$f" ;;
    SHA256SUMS.txt)                       src="$ROOT/download/windows/$f" ;;
    localforge-ide-source.zip)            src="$ROOT/download/$f" ;;
  esac
  b=$(sha256sum "$src" | cut -d' ' -f1)
  [ "$a" = "$b" ] || { echo "ERROR: $f differs from source"; exit 1; }
  echo "✅ $f  $(echo "$a" | cut -c1-16)…"
done

echo "--- release zip ---"
unzip -l "$OUT" | tail -3
ls -lh "$OUT"
