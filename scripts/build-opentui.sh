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
# Without this patch, bionic's libdl/libpthread handling breaks Android builds.
# Previous versions of this patch incorrectly disabled linkLibC, causing
# "pthread.h file not found" and "libc headers not available" errors.
OPENTUI_PATCH="$REPO_ROOT/patches/opentui/android-libc-link.patch"
if [ -f "$OPENTUI_PATCH" ]; then
    echo ">>> Applying opentui Android patch..."
    cd "$OPENTUI_SRC"
    # Ensure we start from a clean file so patch migration (old 3-hunk -> new 1-hunk)
    # works: restore build.zig first, then apply.
    if ! git diff --quiet -- packages/core/src/zig/build.zig 2>/dev/null; then
        echo "    Restoring build.zig to clean state before patching..."
        git checkout -- packages/core/src/zig/build.zig 2>/dev/null || git checkout -- . 2>/dev/null || true
    fi
    # Also handle case where old patch is already applied (would now be dirty)
    # Try to revert any previous patch state by checking if file contains old hack
    if grep -q "ANDROID_NDK_LIB_DIR" packages/core/src/zig/build.zig 2>/dev/null; then
        echo "    Detected old patch remnants, restoring..."
        git checkout -- packages/core/src/zig/build.zig 2>/dev/null || git checkout -- . 2>/dev/null || true
        # If still present (old patch was committed), try to restore from parent commit or tag
        if grep -q "ANDROID_NDK_LIB_DIR" packages/core/src/zig/build.zig 2>/dev/null; then
            echo "    Old patch appears committed, trying to restore from tag..."
            git fetch --depth 1 origin tag "$OPENTUI_VERSION" 2>/dev/null || true
            git checkout FETCH_HEAD -- packages/core/src/zig/build.zig 2>/dev/null || \
            git checkout HEAD~1 -- packages/core/src/zig/build.zig 2>/dev/null || \
            git checkout origin/"$OPENTUI_VERSION" -- packages/core/src/zig/build.zig 2>/dev/null || true
        fi
    fi
    if git diff --quiet -- packages/core/src/zig/build.zig 2>/dev/null && ! git apply --check "$OPENTUI_PATCH" 2>/dev/null; then
        echo "    Patch already applied, skipping"
    elif git apply --check "$OPENTUI_PATCH" 2>/dev/null; then
        git apply "$OPENTUI_PATCH"
        echo "    Patch applied successfully"
    else
        echo "    WARNING: Patch does not apply cleanly, attempting restore + apply..."
        git checkout -- packages/core/src/zig/build.zig 2>/dev/null || git checkout -- . 2>/dev/null || true
        if git apply --check "$OPENTUI_PATCH" 2>/dev/null; then
            git apply "$OPENTUI_PATCH"
            echo "    Patch applied successfully (after restore)"
        else
            echo "    ERROR: Patch still failed to apply"
            git apply --check "$OPENTUI_PATCH" 2>&1 || true
        fi
    fi
fi

OPENTUI_ZIG_DIR="$OPENTUI_SRC/packages/core/src/zig"

if [ ! -f "$OPENTUI_ZIG_DIR/build.zig" ]; then
    echo "ERROR: build.zig not found at $OPENTUI_ZIG_DIR"
    exit 1
fi

echo ">>> Building with Zig (target: aarch64-linux-android)..."
cd "$OPENTUI_ZIG_DIR"

# Zig 0.15.2 does not ship bionic libc. We must provide NDK sysroot for
# headers (pthread.h etc.) and for linking. Without --sysroot, Zig reports
# "libc headers not available; compilation does not link against libc" and
# fails on #include <pthread.h> in miniaudio.
ZIG_ARGS=()
if [ -n "${NDK_SYSROOT:-}" ] && [ -d "$NDK_SYSROOT" ]; then
    echo "    Using NDK sysroot: $NDK_SYSROOT"
    ZIG_ARGS+=(--sysroot "$NDK_SYSROOT")
elif [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot" ]; then
    SYSROOT_FALLBACK="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/sysroot"
    echo "    Using NDK sysroot (fallback): $SYSROOT_FALLBACK"
    ZIG_ARGS+=(--sysroot "$SYSROOT_FALLBACK")
else
    echo "WARNING: NDK sysroot not found. Build may fail with 'pthread.h file not found'."
    echo "         Expected NDK_SYSROOT=$NDK_SYSROOT or ANDROID_NDK_HOME=$ANDROID_NDK_HOME"
fi

# Keep for backward compatibility with any patch that reads this env
export ANDROID_NDK_LIB_DIR="${ANDROID_NDK_HOME:-/opt/android-ndk}/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/${ANDROID_API:-24}"
export ANDROID_NDK_HOME

"$ZIG_BIN" build \
    "${ZIG_ARGS[@]}" \
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
