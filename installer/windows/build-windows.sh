#!/usr/bin/env bash
# Build the LocalForge Windows companion installer artifacts on Linux:
#   1. localforge-companion.exe — standalone companion (Bun runtime embedded)
#   2. LocalForgeTray.exe       — native Win32 tray GUI (zig cc, no runtime)
#   3. LocalForge-Companion-Setup-<ver>.exe — NSIS per-user installer
# Outputs land in download/windows/ and are copied to public/downloads/ for
# the published site. Cross-compilation only; Windows-native execution is
# UNVERIFIED in this environment (see docs/WINDOWS_INSTALL.md).
set -euo pipefail
cd "$(dirname "$0")/../.."   # project root

OUT=download/windows
PUB=public/downloads
VER=$(node -e "console.log(require('./companion/package.json').version)")
# Use tools supplied on PATH in CI; retain the original local-build paths
# as fallbacks for developers who built the toolchain manually.
ZIG=${ZIG:-$(command -v zig || echo /tmp/zig/zig)}
MAKENSIS=${MAKENSIS:-$(command -v makensis || echo /tmp/dl-nsis/root/usr/bin/makensis)}
if [[ -z "${NSISDIR:-}" ]]; then
  if [[ -d /usr/share/nsis ]]; then
    export NSISDIR=/usr/share/nsis
  else
    export NSISDIR=/tmp/dl-nsis/root/usr/share/nsis
  fi
fi
for command_path in "$ZIG" "$MAKENSIS"; do
  if [[ ! -x "$command_path" ]]; then
    echo "Missing build tool: $command_path (install Zig and NSIS or set ZIG/MAKENSIS)" >&2
    exit 1
  fi
done
command -v bun >/dev/null || { echo "Missing Bun compiler" >&2; exit 1; }

mkdir -p "$OUT/LocalForgeCompanion" "$PUB"

echo "== 1/3 companion.exe (bun --compile, windows-x64) =="
bun build installer/windows/entry-companion.ts \
  --compile --target=bun-windows-x64 \
  --outfile "$OUT/LocalForgeCompanion/localforge-companion.exe" \
  --define 'process.env.NODE_ENV:"production"'

echo "== 2/3 tray GUI (zig cc, windows-x64) =="
"$ZIG" cc -target x86_64-windows-gnu -O2 -Wno-unused-function \
  -o "$OUT/LocalForgeCompanion/LocalForgeTray.exe" \
  installer/windows/tray_main.c \
  -luser32 -lshell32 -lgdi32 -ladvapi32 -lcomctl32 -lws2_32 -municode
# zig cc cannot set /SUBSYSTEM:WINDOWS — patch the PE optional header so the
# tray never flashes a console window.
python3 scripts/pe-set-gui-subsystem.py "$OUT/LocalForgeCompanion/LocalForgeTray.exe"

echo "== 3/3 NSIS installer =="
cat > "$OUT/version.nsi.inc" <<EOF
!define LF_VERSION "$VER"
EOF
"$MAKENSIS" -V2 -DVERSION="$VER" installer/windows/installer.nsi

echo "== post: copy setup exe to public downloads =="
cp "$OUT/LocalForge-Companion-Setup-$VER.exe" "$PUB/"

ls -la "$OUT" "$OUT/LocalForgeCompanion"
echo "DONE — artifacts in $OUT"
