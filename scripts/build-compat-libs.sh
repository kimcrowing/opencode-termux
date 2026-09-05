#!/usr/bin/env bash
# Build the two Android compat libraries that the opencode2 binary needs.
#
# Usage: ./scripts/build-compat-libs.sh
#
# These are pure C, take seconds to build, and are independent of the OpenCode
# version - so they are a separate cheap CI stage with a stable cache key.
#
#   libtagfix.so        disables bionic heap pointer tagging (Android 11+)
#   libseccomp_shim.so  turns seccomp SIGSYS kills into ENOSYS (Android 10)
#
# See src/tagfix.c and src/seccomp_shim.c for why each is required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

OUT_DIR="${OUT_DIR:-$WORK_DIR/compat}"
mkdir -p "$OUT_DIR"

echo "=== Building Android compat libraries for ${ANDROID_TRIPLE} ==="

if [ ! -x "$ANDROID_CC" ]; then
    echo "ERROR: NDK clang not found at $ANDROID_CC" >&2
    echo "       Set ANDROID_NDK_HOME to a valid NDK installation." >&2
    exit 1
fi

build_lib() {
    local src="$1"
    local name="$2"
    echo ">>> $name"
    "$ANDROID_CC" -shared -fPIC -O2 \
        -o "$OUT_DIR/$name" \
        "$REPO_ROOT/src/$src"
    echo "    $OUT_DIR/$name ($(du -h "$OUT_DIR/$name" | cut -f1))"
}

build_lib tagfix.c libtagfix.so
build_lib seccomp_shim.c libseccomp_shim.so

echo ""
echo "=== compat libraries complete ==="
ls -la "$OUT_DIR"
