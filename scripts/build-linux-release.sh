#!/usr/bin/env bash
# Build the LocalForge Linux companion release artifacts — authentic 0.4.4
# layout (recovered from the original release uploads):
#   1. localforge-companion-<ver>-linux-x64.tar.gz — portable package:
#      localforge-companion-<ver>-linux-x64/{localforge-companion,README.txt,LICENSE.txt}
#   2. localforge-companion_<ver>_amd64.deb — plain /usr/bin package, NO
#      service, NO maintainer scripts:
#      /usr/bin/localforge-companion
#      /usr/share/doc/localforge-companion/{README,copyright}
# LICENSE text is reused verbatim from installer/windows/LICENSE.txt (the
# original release shipped the same text in all packages, "Windows installer"
# heading included).
# Outputs land in download/linux/ and are copied to public/downloads/.
# Expects the compiled binary (bun build --compile --target=bun-linux-x64)
# at $BIN (default: /tmp/stage-linux/localforge-companion-<ver>-linux-x64/localforge-companion).
set -euo pipefail
cd "$(dirname "$0")/.."   # project root

VER=$(node -e "console.log(require('./companion/package.json').version)")
BIN=${BIN:-/tmp/stage-linux/localforge-companion-$VER-linux-x64/localforge-companion}
OUT=download/linux
PUB=public/downloads
ARCH=amd64

[ -s "$BIN" ] || { echo "ERROR: companion binary missing at $BIN"; exit 1; }
[ -s installer/windows/LICENSE.txt ] || { echo "ERROR: installer/windows/LICENSE.txt missing"; exit 1; }
mkdir -p "$OUT" "$PUB"

# ---- shared docs (authentic 0.4.4 text) ----
cat > /tmp/lf-release-README.txt <<EOF
LocalForge Companion $VER (Linux x64, portable)

Run:  ./localforge-companion --port 7337 --show-code
      (add --lan to accept connections from other machines on your LAN)

Then open the LocalForge IDE and pair using the shown code.
Model servers (Ollama :11434, Lemonade :13305/:8000, LM Studio :1234, llama-server)
are discovered automatically on this machine; a Lemonade key from
/etc/lemonade/lemond.env is used automatically for protected lemond instances.
EOF
cp installer/windows/LICENSE.txt /tmp/lf-release-LICENSE.txt

# ---- 1/2 portable tar.gz ----
TARDIR="$OUT/localforge-companion-$VER-linux-x64"
rm -rf "$TARDIR" && mkdir -p "$TARDIR"
install -m 0755 "$BIN" "$TARDIR/localforge-companion"
install -m 0644 /tmp/lf-release-README.txt "$TARDIR/README.txt"
install -m 0755 /tmp/lf-release-LICENSE.txt "$TARDIR/LICENSE.txt"   # 0755: matches the original release
tar -czf "$OUT/localforge-companion-$VER-linux-x64.tar.gz" -C "$OUT" "localforge-companion-$VER-linux-x64"

# ---- 2/2 deb (plain /usr/bin package, no service, no maintainer scripts) ----
DEBROOT="$OUT/deb-root"
rm -rf "$DEBROOT"
mkdir -p "$DEBROOT/DEBIAN" "$DEBROOT/usr/bin" "$DEBROOT/usr/share/doc/localforge-companion"
install -m 0755 "$BIN" "$DEBROOT/usr/bin/localforge-companion"
install -m 0644 /tmp/lf-release-README.txt "$DEBROOT/usr/share/doc/localforge-companion/README"
install -m 0644 /tmp/lf-release-LICENSE.txt "$DEBROOT/usr/share/doc/localforge-companion/copyright"

cat > "$DEBROOT/DEBIAN/control" <<EOF
Package: localforge-companion
Version: $VER
Architecture: $ARCH
Maintainer: LocalForge <support@localforge.local>
Depends:
Section: utils
Priority: optional
Description: Local machine bridge for the LocalForge IDE
 Connects the LocalForge browser IDE to local AI model servers
 (Ollama, Lemonade, LM Studio, llama.cpp), authorized project
 directories, command execution and app previewing. Runs as your
 user; no service is installed.
EOF

dpkg-deb --build --root-owner-group "$DEBROOT" "$OUT/localforge-companion_${VER}_${ARCH}.deb"

# ---- publish + checksums ----
cp "$OUT/localforge-companion-$VER-linux-x64.tar.gz" "$PUB/"
cp "$OUT/localforge-companion_${VER}_${ARCH}.deb" "$PUB/"
( cd "$OUT" && sha256sum \
    "localforge-companion_${VER}_${ARCH}.deb" \
    "localforge-companion-$VER-linux-x64.tar.gz" > SHA256SUMS.txt )
sha256sum "$OUT/localforge-companion_${VER}_${ARCH}.deb" | awk '{print $1}' > "$PUB/localforge-companion_${VER}_${ARCH}.deb.sha256"
sha256sum "$OUT/localforge-companion-$VER-linux-x64.tar.gz" | awk '{print $1}' > "$PUB/localforge-companion-$VER-linux-x64.tar.gz.sha256"
ls -la "$OUT" "$PUB"
echo "DONE — linux artifacts in $OUT"
