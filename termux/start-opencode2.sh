#!/usr/bin/env bash
# Start OpenCode v2 (opencode2) as a headless server on Termux.
#
# Environment variables
# ---------------------
#   OPENCODE_SERVER_PASSWORD
#       HTTP basic-auth password (username defaults to "opencode").
#   OTUI_ASSET_ROOT
#       Directory holding the self-compiled libopentui.so. @opentui/core checks
#       this before it tries to import a platform package, and there is no
#       android platform package, so this variable is what makes the TUI work at
#       all on device. Layout:
#           $OTUI_ASSET_ROOT/@opentui/core-linux-arm64/libopentui.so
#   LD_PRELOAD / LD_LIBRARY_PATH
#       The Android compat libraries (libtagfix.so, libseccomp_shim.so) plus
#       libc++_shared.so. Without them the Bun binary aborts on startup.
#   BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1
#       Keeps Bun's event loop off epoll_pwait2, which Android's seccomp policy
#       blocks and would otherwise kill the process with SIGSYS.

set -euo pipefail

# Resolve the install directory: alongside this script's parent, or override.
INSTALL_DIR="${OPENCODE_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

BIN="$INSTALL_DIR/opencode2"
LIB_DIR="$INSTALL_DIR/lib"
ASSET_ROOT="${OTUI_ASSET_ROOT:-$INSTALL_DIR/otui-assets}"

if [ ! -x "$BIN" ]; then
    echo "ERROR: opencode2 not found or not executable at $BIN" >&2
    exit 1
fi

# --- Android compat preloads -------------------------------------------------
# libtagfix.so        : disables bionic heap pointer tagging (Android 11+)
# libseccomp_shim.so  : SIGSYS -> ENOSYS (Android 10)
PRELOAD=""
for lib in libtagfix.so libseccomp_shim.so; do
    if [ -f "$LIB_DIR/$lib" ]; then
        PRELOAD="${PRELOAD:+$PRELOAD:}$LIB_DIR/$lib"
    else
        echo "WARNING: $LIB_DIR/$lib not found (startup may crash)" >&2
    fi
done

if [ -n "$PRELOAD" ]; then
    export LD_PRELOAD="$PRELOAD"
fi
export LD_LIBRARY_PATH="${LIB_DIR}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# --- Native TUI library ------------------------------------------------------
if [ -d "$ASSET_ROOT" ]; then
    export OTUI_ASSET_ROOT="$ASSET_ROOT"
else
    echo "WARNING: OTUI_ASSET_ROOT not found at $ASSET_ROOT" >&2
    echo "         The TUI will fail to start; only server/API mode will work." >&2
fi

# --- Bun on Android ----------------------------------------------------------
export BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1
export OPENCODE_SERVER_PASSWORD="${OPENCODE_SERVER_PASSWORD:-www}"

cd "${OPENCODE_WORKDIR:-$HOME}"

exec "$BIN" serve \
    --hostname "${OPENCODE_HOST:-0.0.0.0}" \
    --port "${OPENCODE_PORT:-4096}"
