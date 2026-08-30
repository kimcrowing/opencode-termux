#!/usr/bin/env bash
# Create distribution packages for OpenCode Android
#
# Usage: ./scripts/make-packages.sh
#
# Creates three package formats:
# 1. ZIP: opencode-${VERSION}-android-aarch64.zip (standalone binary)
# 2. Pacman: opencode-${VERSION}-1-aarch64.pkg.tar.xz (Termux pacman format)
# 3. Deb: opencode_${VERSION}_aarch64.deb (old Termux deb format)
#
# Each package contains:
#   opencode       - wrapper script (preloads the compat libraries)
#   opencode.bin   - the real standalone binary
#   libtagfix.so   - disables bionic heap pointer tagging (SIGABRT on Android 11+)
#   libseccomp_shim.so - turns seccomp SIGSYS kills into ENOSYS (Android 10)
#   libopentui.so  - opentui renderer, shipped as a real file because Bun's
#                    virtual /$bunfs/root/... paths are not intercepted on Android
#   libc++_shared.so   - required by Bun's JIT modules; Android does not provide it
#
# The wrapper is generated from scripts/opencode-wrapper.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OPENCODE_BINARY="$DIST_DIR/opencode"
PKG_DIR="$WORK_DIR/packages"

if [ ! -f "$OPENCODE_BINARY" ]; then
    echo "ERROR: OpenCode binary not found at $OPENCODE_BINARY"
    echo "       Run scripts/build-opencode.sh first."
    exit 1
fi

echo "=== Creating packages for OpenCode v${OPENCODE_VERSION} ==="

# ------------------------------------------
# Build/copy the native libraries
# ------------------------------------------
# libtagfix.so and libseccomp_shim.so are compiled from src/ by this step;
# libc++_shared.so is copied from the NDK. libopentui.so comes from
# scripts/build-opentui.sh and is located below.
echo ">>> Building native libraries..."
"$SCRIPT_DIR/build-native-libs.sh" "$DIST_DIR"

# ------------------------------------------
# Collect the native libraries that ship alongside the binary
# ------------------------------------------
declare -A NATIVE_LIBS=(
    [libseccomp_shim.so]="$DIST_DIR/libseccomp_shim.so"
)

for lib in libtagfix.so libopentui.so libc++_shared.so; do
    found=""
    for candidate in \
        "$DIST_DIR/$lib" \
        "$WORK_DIR/$lib" \
        "$OPENTUI_SRC/packages/core/src/lib/aarch64-linux-android/$lib" \
        "$BUN_BUILD/$lib"
    do
        if [ -f "$candidate" ]; then
            found="$candidate"
            break
        fi
    done
    if [ -n "$found" ]; then
        NATIVE_LIBS[$lib]="$found"
    else
        echo "WARNING: $lib not found - it will not be bundled"
    fi
done

echo "    Native libraries to bundle:"
for lib in "${!NATIVE_LIBS[@]}"; do
    echo "      - $lib"
done

BINARY_SIZE=$(stat -c%s "$OPENCODE_BINARY")
BUILD_DATE=$(date +%s)

# Clean up
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"

# ==========================================
# 1. ZIP package
# ==========================================
echo ">>> Creating ZIP package..."
ZIP_NAME="opencode-${OPENCODE_VERSION}-android-aarch64.zip"
ZIP_STAGING="$PKG_DIR/zip-staging"
rm -rf "$ZIP_STAGING"
mkdir -p "$ZIP_STAGING"

# The binary is shipped as opencode.bin; the wrapper takes its name.
cp "$OPENCODE_BINARY" "$ZIP_STAGING/opencode.bin"
cp "$REPO_ROOT/scripts/opencode-wrapper.sh" "$ZIP_STAGING/opencode"
chmod 755 "$ZIP_STAGING/opencode" "$ZIP_STAGING/opencode.bin"
for lib in "${!NATIVE_LIBS[@]}"; do
    cp "${NATIVE_LIBS[$lib]}" "$ZIP_STAGING/$lib"
done

cd "$ZIP_STAGING"
zip -9 "$PKG_DIR/$ZIP_NAME" opencode opencode.bin "${!NATIVE_LIBS[@]}"
echo "    Created $ZIP_NAME"

# ==========================================
# 2. Pacman package (Termux)
# ==========================================
echo ">>> Creating pacman package..."
PACMAN_STAGING="$PKG_DIR/pacman-staging"
BIN_DIR="$PACMAN_STAGING/data/data/com.termux/files/usr/bin"
LIB_DIR="$PACMAN_STAGING/data/data/com.termux/files/usr/lib/opencode"
mkdir -p "$BIN_DIR" "$LIB_DIR"

cp "$OPENCODE_BINARY" "$LIB_DIR/opencode.bin"
cp "$REPO_ROOT/scripts/opencode-wrapper.sh" "$BIN_DIR/opencode"
chmod 755 "$BIN_DIR/opencode" "$LIB_DIR/opencode.bin"
for lib in "${!NATIVE_LIBS[@]}"; do
    cp "${NATIVE_LIBS[$lib]}" "$LIB_DIR/$lib"
done

# Create .PKGINFO
cat > "$PACMAN_STAGING/.PKGINFO" << EOF
pkgname = opencode
pkgver = ${OPENCODE_VERSION}-1
pkgdesc = AI-powered coding assistant for the terminal
url = https://github.com/anomalyco/opencode
builddate = ${BUILD_DATE}
packager = opencode-termux
size = ${BINARY_SIZE}
arch = aarch64
license = MIT
depend = ripgrep
EOF

PACMAN_NAME="opencode-${OPENCODE_VERSION}-1-aarch64.pkg.tar.xz"
cd "$PACMAN_STAGING"
tar cf - .PKGINFO data | xz -9 > "$PKG_DIR/$PACMAN_NAME"
echo "    Created $PACMAN_NAME"

# ==========================================
# 3. Deb package (old Termux format)
# ==========================================
echo ">>> Creating deb package..."
DEB_STAGING="$PKG_DIR/deb-staging"
DEB_BIN="$DEB_STAGING/data/data/data/com.termux/files/usr/bin"
DEB_LIB="$DEB_STAGING/data/data/data/com.termux/files/usr/lib/opencode"
mkdir -p "$DEB_BIN" "$DEB_LIB" "$DEB_STAGING/DEBIAN"

cp "$OPENCODE_BINARY" "$DEB_LIB/opencode.bin"
cp "$REPO_ROOT/scripts/opencode-wrapper.sh" "$DEB_BIN/opencode"
chmod 755 "$DEB_BIN/opencode" "$DEB_LIB/opencode.bin"
for lib in "${!NATIVE_LIBS[@]}"; do
    cp "${NATIVE_LIBS[$lib]}" "$DEB_LIB/$lib"
done

# Create control file
INSTALLED_SIZE=$((BINARY_SIZE / 1024))
cat > "$DEB_STAGING/DEBIAN/control" << EOF
Package: opencode
Version: ${OPENCODE_VERSION}
Architecture: aarch64
Maintainer: kimcrowing <kimcrowing@users.noreply.github.com>
Installed-Size: ${INSTALLED_SIZE}
Depends: ripgrep
Section: utils
Priority: optional
Homepage: https://github.com/anomalyco/opencode
Description: AI-powered coding assistant for the terminal
 OpenCode is an AI-powered coding assistant that runs in the terminal.
 This package provides a standalone binary compiled for Android/Termux.
EOF

DEB_NAME="opencode_${OPENCODE_VERSION}_aarch64.deb"

# Build deb manually (dpkg-deb may not be available)
cd "$DEB_STAGING/data"
tar czf "$DEB_STAGING/data.tar.gz" data
cd "$DEB_STAGING/DEBIAN"
tar czf "$DEB_STAGING/control.tar.gz" control
echo "2.0" > "$DEB_STAGING/debian-binary"
cd "$DEB_STAGING"
ar rc "$PKG_DIR/$DEB_NAME" debian-binary control.tar.gz data.tar.gz
echo "    Created $DEB_NAME"

# ==========================================
# Summary
# ==========================================
echo ""
echo "=== Packages created ==="
echo ""
ls -lh "$PKG_DIR"/*.{zip,xz,deb} 2>/dev/null
echo ""
echo "Install on Termux:"
echo "  pacman -U $PACMAN_NAME"
echo "  dpkg -i $DEB_NAME"
echo "  unzip $ZIP_NAME -d /data/data/com.termux/files/usr/bin/"
