#!/usr/bin/env bash
# Build libopentui.so for Android aarch64
#
# Usage: ./scripts/build-opentui.sh
#
# OpenCode's TUI renderer (@opentui/core) uses a native Zig library.
# The upstream build targets aarch64-linux (musl), which fails on Android
# because getauxval cannot be resolved. We build for aarch64-linux-android.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

ZIG_BIN="${ZIG_BIN:-zig}"

echo "=== Building libopentui.so for Android aarch64 ==="

# Clone opentui if needed. Must stay on the tag matching the pinned OpenCode
# release (see OPENTUI_VERSION in env.sh). Cloning latest main fails because
# opentui restructured after 0.3.4 (zig moved to packages/native, Zig 0.16).
if [ ! -d "$OPENTUI_SRC/.git" ]; then
    echo ">>> Cloning opentui (${OPENTUI_VERSION})..."
    git clone --depth 1 --branch "${OPENTUI_VERSION}" https://github.com/anomalyco/opentui.git "$OPENTUI_SRC"
else
    echo ">>> opentui source exists at $OPENTUI_SRC"
fi

# Apply Android libc linking patch
# Without this patch, the .so won't have NEEDED: libc.so, and Android's
# dlopen() will fail because it can't resolve symbols like getauxval.
# The v0.4.5 patch is line-adapted for OPENTUI_VERSION=v0.4.5; the generic
# one targets older tags (0.3.4). Pick whichever applies cleanly.
OPENTUI_PATCH=""
for cand in \
    "$REPO_ROOT/patches/opentui/android-libc-link-0.4.5.patch" \
    "$REPO_ROOT/patches/opentui/android-libc-link.patch"; do
    if [ -f "$cand" ]; then
        if (cd "$OPENTUI_SRC" && git apply --check "$cand" 2>/dev/null); then
            OPENTUI_PATCH="$cand"
            break
        fi
    fi
done
if [ -n "$OPENTUI_PATCH" ]; then
    echo ">>> Applying opentui Android patch: $(basename "$OPENTUI_PATCH")"
    (cd "$OPENTUI_SRC" && git apply "$OPENTUI_PATCH")
    echo "    Patch applied successfully"
else
    echo ">>> No opentui Android patch applies to OPENTUI_VERSION=${OPENTUI_VERSION}; proceeding unpatch (may fail on bionic libc)"
fi

OPENTUI_ZIG_DIR="$OPENTUI_SRC/packages/core/src/zig"

if [ ! -f "$OPENTUI_ZIG_DIR/build.zig" ]; then
    echo "ERROR: build.zig not found at $OPENTUI_ZIG_DIR"
    exit 1
fi

echo ">>> Building with Zig (target: aarch64-linux-android)..."
cd "$OPENTUI_ZIG_DIR"

"$ZIG_BIN" build \
    -Dtarget=aarch64-linux-android \
    -Doptimize=ReleaseSafe \
    --prefix . 2>&1

# The build.zig installs to dest_dir="../lib/{output_name}" relative to
# the --prefix dir.  With --prefix=. (= OPENTUI_ZIG_DIR), the .so ends
# up one directory above: packages/core/src/lib/aarch64-linux-android/
LIBOPENTUI="$OPENTUI_ZIG_DIR/../lib/aarch64-linux-android/libopentui.so"
if [ ! -f "$LIBOPENTUI" ]; then
    echo "ERROR: libopentui.so not found"
    echo "  Expected at: $LIBOPENTUI"
    echo "  Searching for any libopentui.so under opentui-src..."
    find "$OPENTUI_SRC" -name "libopentui.so" -type f 2>/dev/null || true
    exit 1
fi

echo ""
echo "=== libopentui.so build complete ==="
echo "Output: $LIBOPENTUI"
echo "Size: $(du -h "$LIBOPENTUI" | cut -f1)"
file "$LIBOPENTUI"

# Verify the .so has NEEDED: libc.so (required for Android dlopen)
if readelf -d "$LIBOPENTUI" 2>/dev/null | grep -q "NEEDED.*libc.so"; then
    echo "OK: libopentui.so has NEEDED: libc.so (required for Android)"
else
    echo "ERROR: libopentui.so is missing NEEDED: libc.so dependency"
    echo "       Android dlopen() will fail without this."
    echo "       Ensure ANDROID_NDK_HOME is set and the opentui patch was applied."
    readelf -d "$LIBOPENTUI" 2>/dev/null | grep NEEDED || echo "       (no NEEDED entries found)"
    exit 1
fi
