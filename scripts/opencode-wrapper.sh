#!/data/data/com.termux/files/usr/bin/sh
# opencode — wrapper that makes the Bun-based binary survive on Android.
#
# The real opencode binary is opencode.bin. Android needs three things that the
# bare binary cannot do for itself, so this script sets them up before exec'ing:
#
#   1. libtagfix.so disables bionic's software heap pointer tagging.
#      Without it, Bun/JSC's NaN-boxing clears the 0xB4 top-byte tag on heap
#      pointers and bionic aborts on free():
#        "Pointer tag ... was truncated"  (SIGABRT, Android 11+)
#
#   2. libseccomp_shim.so turns seccomp SIGSYS kills into ENOSYS returns.
#      Android's per-app seccomp policy blocks syscalls that Bun uses (openat2,
#      pidfd_open, epoll_pwait2, ...). On older allow-lists (notably Android 10)
#      the kernel delivers SIGSYS instead of an errno, so Bun's own ENOSYS
#      fallbacks never get a chance to run. The shim converts the signal into
#      the -ENOSYS return Bun expects.
#        "Fatal signal 31 (SIGSYS), code 1 (SYS_SECCOMP)"  (Android 10)
#
#   3. Real filesystem paths for native libraries.
#      Bun's virtual /$bunfs/root/... paths are not intercepted on Android, so
#      libopentui.so must be loaded from disk via OPENTUI_LIB_PATH, and
#      libc++_shared.so (needed by Bun's JIT modules, not provided by Android)
#      must be findable via LD_LIBRARY_PATH.
#
# Path resolution order (supports both the standalone zip and the installed
# package layout):
#   zip:       opencode, opencode.bin and the .so files all live in the same dir
#   installed: bin/opencode, lib/opencode/opencode.bin, lib/opencode/*.so

set -e

dir="$(cd "$(dirname "$0")" && pwd)"
export ANDROID_ROOT="${ANDROID_ROOT:-/system}"
export TERMUX_VERSION="${TERMUX_VERSION:-opencode-termux}"
export TMPDIR="${OPENCODE_TMPDIR:-${HOME:-/data/data/com.termux/files/home}/tmp}"
export TEMP="$TMPDIR"
export TMP="$TMPDIR"
export OPENCODE_DISABLE_TUI_AUDIO="${OPENCODE_DISABLE_TUI_AUDIO:-1}"
mkdir -p "$TMPDIR" 2>/dev/null || true

# Locate the native libraries we ship alongside the wrapper.
# Prefer the installed package layout (libs under ../lib/opencode) over the flat
# zip layout (libs next to the wrapper). This avoids picking up stale libraries
# that may have been left behind by an earlier manual extraction into bin/.
NATIVE_LIB_DIR=""
for candidate in \
    "$dir/../lib/opencode" \
    "${PREFIX:-/data/data/com.termux/files/usr}/lib/opencode" \
    "$dir"
do
    if [ -f "$candidate/libtagfix.so" ]; then
        NATIVE_LIB_DIR="$candidate"
        break
    fi
done

if [ -n "$NATIVE_LIB_DIR" ]; then
    # Both compat libraries are preloaded. They fix different crashes and do not
    # conflict. libseccomp_shim.so is optional so the wrapper still works if a
    # build predates it.
    PRELOAD="${NATIVE_LIB_DIR}/libtagfix.so"
    if [ -f "${NATIVE_LIB_DIR}/libseccomp_shim.so" ]; then
        PRELOAD="${PRELOAD}:${NATIVE_LIB_DIR}/libseccomp_shim.so"
    fi
    export LD_PRELOAD="${PRELOAD}${LD_PRELOAD:+:$LD_PRELOAD}"
    # Bun's JIT-compiled modules need libc++_shared.so. Android's /system/lib64/
    # does not contain it, so point the linker at the directory where we ship it.
    export LD_LIBRARY_PATH="${NATIVE_LIB_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    # Bun's /$bunfs/root/ virtual paths are not intercepted on Android, so load
    # opentui's renderer library from the real filesystem.
    export OPENTUI_LIB_PATH="${NATIVE_LIB_DIR}/libopentui.so"
    if [ -f "${NATIVE_LIB_DIR}/librust_pty_arm64.so" ]; then
        export BUN_PTY_LIB="${NATIVE_LIB_DIR}/librust_pty_arm64.so"
    fi
    # @parcel/watcher only bundles the host-arch native binding in our build;
    # disable it on Android/Termux to avoid a dlopen architecture mismatch.
    export OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER="${OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:-true}"
    # If a real Bun binary is shipped next to opencode, use it for plugin installs.
    if [ -x "$NATIVE_LIB_DIR/bun" ]; then
        export OPENCODE_BUN_PATH="$NATIVE_LIB_DIR/bun"
    fi
else
    echo "opencode: warning: native library directory not found, may crash on Android 11+" >&2
fi

# Locate opencode.bin. Prefer the package layout first so upgrades do not
# accidentally execute a stale flat-layout binary left in $PREFIX/bin.
for candidate in \
    "$dir/../lib/opencode/opencode.bin" \
    "${PREFIX:-/data/data/com.termux/files/usr}/lib/opencode/opencode.bin" \
    "$dir/opencode.bin"
do
    if [ -x "$candidate" ]; then
        exec "$candidate" "$@"
    fi
done

echo "opencode: error: could not find opencode.bin" >&2
exit 127
