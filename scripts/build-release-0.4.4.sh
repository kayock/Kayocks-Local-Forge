#!/usr/bin/env bash
# Finish the 0.4.4 release: build the NSIS setup exe from the already-built
# companion + tray binaries, generate checksums for ALL three official
# artifacts, and publish them to public/downloads (removing the stale 0.3.2).
# Tray rebuild (zig cc) is skipped when the prebuilt tray is present — the
# tray source did not change in the 0.4.x line.
set -euo pipefail
cd "$(dirname "$0")/.."   # project root

VER=$(node -e "console.log(require('./companion/package.json').version)")
OUT=download/windows
PUB=public/downloads
MAKENSIS=${MAKENSIS:-/tmp/dl-nsis/root/usr/bin/makensis}
export NSISDIR=${NSISDIR:-/tmp/dl-nsis/root/usr/share/nsis}

mkdir -p "$OUT" "$PUB"

echo "== 1/4 tray (reuse prebuilt; source unchanged) =="
[ -s "$OUT/LocalForgeCompanion/LocalForgeTray.exe" ] || { echo "ERROR: prebuilt tray missing"; exit 1; }

echo "== 2/4 NSIS setup exe =="
printf '!define LF_VERSION "%s"\n' "$VER" > "$OUT/version.nsi.inc"
"$MAKENSIS" -V2 -DVERSION="$VER" installer/windows/installer.nsi

echo "== 3/4 checksums =="
SETUP="$OUT/LocalForge-Companion-Setup-$VER.exe"
for f in "$SETUP" "$OUT/LocalForgeCompanion/localforge-companion.exe" "$OUT/LocalForgeCompanion/LocalForgeTray.exe"; do
  [ -s "$f" ] || { echo "ERROR: missing $f"; exit 1; }
done

# Windows checksum file (bare filenames, lives next to the binaries — the
# 0.1.0/0.3.2 pattern) + the gate's .sha256 sidecar for the setup exe.
( cd "$OUT" && sha256sum \
    "LocalForge-Companion-Setup-$VER.exe" \
    LocalForgeCompanion/localforge-companion.exe \
    LocalForgeCompanion/LocalForgeTray.exe > SHA256SUMS.txt )
sha256sum "$SETUP" | awk '{print $1}' > "$OUT/LocalForge-Companion-Setup-$VER.exe.sha256"

echo "== 4/4 publish =="
cp "$SETUP" "$PUB/"
cp "$OUT/LocalForge-Companion-Setup-$VER.exe.sha256" "$PUB/"
rm -f "$PUB/LocalForge-Companion-Setup-0.3.2.exe" "$PUB/LocalForge-Companion-Setup-0.3.2.exe.sha256"

ls -la "$PUB"
echo "DONE — 0.4.4 setup exe published"
