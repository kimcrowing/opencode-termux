#!/usr/bin/env bash
# Build/copy the native libraries that must ship alongside opencode.bin.
#
# Each library fixes a specific Android problem that the Bun-based binary cannot
# handle on its own. They are preloaded (or dlopened) by the wrapper.
#
#   1. libtagfix.so       - built from src/tagfix.c
#      Disables bionic heap pointer tagging (Android 11+). Bun/JSC NaN-boxing
#      clears the top-byte tag on heap pointers, so bionic aborts on free():
#        "Pointer tag ... was truncated"
#
#   2. libseccomp_shim.so - built from src/seccomp_shim.c
#      Converts seccomp SIGSYS kills into ENOSYS returns (Android 10). Android's
#      per-app seccomp policy blocks syscalls Bun uses (openat2, pidfd_open,
#      epoll_pwait2...). Old allow-lists deliver SIGSYS instead of an errno, so
#      Bun's own ENOSYS fallbacks never run.
#
#   3. libc++_shared.so   - copied from the NDK
#      Required by Bun's JIT-compiled modules. Android's /system/lib64 does not
#      provide it, and it must be loadable from the real filesystem because
#      Bun's virtual /$bunfs/root/... paths are not intercepted on Android.
#
# libopentui.so is NOT handled here - it is produced by scripts/build-opentui.sh.
#
# Usage
#   ./scripts/build-native-libs.sh [output-dir]
#
# Environment
#   ANDROID_NDK_ROOT / ANDROID_NDK_HOME  - NDK location (for libc++_shared.so)
#   ANDROID_TRIPLE_API                   - e.g. aarch64-linux-android24 (from env.sh)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/env.sh" 2>/dev/null || true

OUT_DIR="${1:-${DIST_DIR:-$REPO_ROOT/dist}}"
mkdir -p "$OUT_DIR"

# ------------------------------------------------------------------
# Compiler: NDK cross-compiler when available, else native (Termux
# clang is already aarch64).
# ------------------------------------------------------------------
CC=""
for candidate in \
    "${ANDROID_CC:-}" \
    "${ANDROID_NDK_ROOT:-/opt/android-ndk}/toolchains/llvm/prebuilt/linux-x86_64/bin/${ANDROID_TRIPLE_API:-aarch64-linux-android24}-clang" \
    "${ANDROID_NDK_HOME:-/opt/android-ndk}/toolchains/llvm/prebuilt/linux-x86_64/bin/${ANDROID_TRIPLE_API:-aarch64-linux-android24}-clang" \
    "${ANDROID_NDK_ROOT:-/opt/android-ndk}/toolchains/llvm/prebuilt/darwin-x86_64/bin/${ANDROID_TRIPLE_API:-aarch64-linux-android24}-clang" \
    "aarch64-linux-android24-clang" \
    "aarch64-linux-gnu-clang" \
    "clang" \
    "cc" \
    "gcc"
do
    [ -n "$candidate" ] || continue
    if command -v "$candidate" >/dev/null 2>&1; then
        CC="$candidate"
        break
    fi
done

if [ -z "$CC" ]; then
    echo "ERROR: no C compiler found (tried NDK clang, clang, cc, gcc)" >&2
    exit 1
fi

echo "=== Building native libraries ==="
echo "    output:   $OUT_DIR"
echo "    compiler: $CC"

# ------------------------------------------------------------------
# 1 + 2: the two compat shims we build from source
# ------------------------------------------------------------------
for pair in "tagfix:libtagfix.so" "seccomp_shim:libseccomp_shim.so"; do
    src_name="${pair%%:*}"
    lib_name="${pair##*:}"
    src="$REPO_ROOT/src/$src_name.c"

    if [ ! -f "$src" ]; then
        echo "ERROR: missing source $src" >&2
        exit 1
    fi

    echo ">>> Building $lib_name from src/$src_name.c"
    "$CC" -shared -fPIC -O2 -o "$OUT_DIR/$lib_name" "$src" -ldl -pthread
done

# ------------------------------------------------------------------
# 3: libc++_shared.so, copied from the NDK
# ------------------------------------------------------------------
echo ">>> Locating libc++_shared.so"

LIBCXX=""
for ndk in "${ANDROID_NDK_ROOT:-}" "${ANDROID_NDK_HOME:-}" "/opt/android-ndk"; do
    [ -n "$ndk" ] || continue
    # The sysroot copy is the one meant for packaging into an APK/app.
    for candidate in \
        "$ndk/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" \
        "$ndk/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so" \
        "$ndk/sources/cxx-stl/llvm-libc++/libs/arm64-v8a/libc++_shared.so"
    do
        if [ -f "$candidate" ]; then
            LIBCXX="$candidate"
            break 2
        fi
    done
done

if [ -n "$LIBCXX" ]; then
    cp "$LIBCXX" "$OUT_DIR/libc++_shared.so"
    echo "    copied from: $LIBCXX"
else
    echo "WARNING: libc++_shared.so not found in NDK - it will not be bundled."
    echo "         Set ANDROID_NDK_ROOT to your NDK path to include it."
    echo "         Without it, Bun's JIT-compiled modules may fail to load."
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "=== Native libraries in $OUT_DIR ==="
ls -l "$OUT_DIR"/*.so 2>/dev/null || echo "(none)"
