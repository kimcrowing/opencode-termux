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

# On Android, Zig cannot cross-compile C++ against a bionic libc it cannot
# provision (Zig 0.15 has no android libc), so yoga's C++ is compiled with the
# NDK's own clang++ (which sets up the correct bionic + libc++ include ordering
# by construction) into .o files, then those objects are linked by Zig.
# This is triggered by OPENTUI_YOGA_OBJS_DIR in build.zig's addYogaDependencies.
if [ -n "${ANDROID_NDK_HOME:-}" ] && [ -n "${ANDROID_API:-}" ]; then
    echo ">>> Precompiling yoga C++ with NDK clang++ ..."
    YOGA_TAG="v3.2.1"   # must match .yoga dep in build.zig.zon
    YOGA_SRC="$OPENTUI_SRC/../yoga-src-${YOGA_TAG}"
    if [ ! -d "$YOGA_SRC/.git" ]; then
        git clone --depth 1 --branch "$YOGA_TAG" https://github.com/facebook/yoga.git "$YOGA_SRC"
    fi
    OBJS_DIR="$OPENTUI_SRC/../yoga-objs"
    mkdir -p "$OBJS_DIR"
    NDK_BIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
    CXX="$NDK_BIN/aarch64-linux-android${ANDROID_API}-clang++"
    if [ ! -x "$CXX" ]; then
        echo "ERROR: NDK clang++ not found at $CXX" >&2
        exit 1
    fi
    for src in \
        yoga/YGConfig.cpp yoga/YGEnums.cpp yoga/YGNode.cpp \
        yoga/YGNodeLayout.cpp yoga/YGNodeStyle.cpp yoga/YGPixelGrid.cpp \
        yoga/YGValue.cpp yoga/algorithm/AbsoluteLayout.cpp \
        yoga/algorithm/Baseline.cpp yoga/algorithm/Cache.cpp \
        yoga/algorithm/CalculateLayout.cpp yoga/algorithm/FlexLine.cpp \
        yoga/algorithm/PixelGrid.cpp yoga/config/Config.cpp \
        yoga/debug/AssertFatal.cpp yoga/debug/Log.cpp yoga/event/event.cpp \
        yoga/node/LayoutResults.cpp yoga/node/Node.cpp; do
        stem="$(basename "$src" .cpp)"
        "$CXX" -c -fPIC -std=c++20 -fexceptions -frtti \
            -I"$YOGA_SRC" \
            -o "$OBJS_DIR/$stem.o" "$YOGA_SRC/$src"
    done
    if [ -n "${GITHUB_ENV:-}" ]; then
        echo "OPENTUI_YOGA_OBJS_DIR=$OBJS_DIR" >> "$GITHUB_ENV"
    fi
    export OPENTUI_YOGA_OBJS_DIR="$OBJS_DIR"
    echo "    yoga C++ objects -> $OBJS_DIR"
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
