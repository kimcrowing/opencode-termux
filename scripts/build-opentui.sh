#!/usr/bin/env bash
# Build libopentui.so for Android aarch64 (OpenCode v2 / opentui 0.5.x).
#
# Usage: ./scripts/build-opentui.sh
#
# Why this exists
# ---------------
# @opentui/core ships native prebuilds for linux/darwin/win32 only - there is no
# android variant in its optionalDependencies. At runtime it resolves the native
# library by importing @opentui/core-<platform>-<arch>, so on Android it would
# throw "OpenTUI is not supported on the current platform".
#
# We therefore compile libopentui.so from opentui source for
# aarch64-linux-android and ship it via OTUI_ASSET_ROOT (see env.sh), which
# @opentui/core checks first and which overrides the whole platform-package
# lookup. No runtime patching needed.
#
# Differences from the v1 script
# ------------------------------
# v1 built opentui 0.4.5 from packages/core/src/zig with Zig 0.15.
# v2 builds opentui 0.5.x from packages/native with Zig 0.16:
#   * build.zig moved: packages/core/src/zig -> packages/native
#   * Zig 0.16 is hard-required (build.zig exits on any other version)
#   * addYogaDependencies takes a Module, not an artifact
#   * -Dlibrary-target=<triple> accepts arbitrary targets, so the android
#     triple can be passed straight through without touching SUPPORTED_TARGETS

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/env.sh"

ZIG_BIN="${ZIG_BIN:-zig}"

echo "=== Building libopentui.so for Android aarch64 ==="

# ---------------------------------------------------------------------------
# 1. Fetch opentui source
# ---------------------------------------------------------------------------
# Must stay on the tag matching the opentui version the pinned v2 source
# requires. Cloning main is not safe: opentui restructures its packages layout
# between minor versions.
if [ ! -d "$OPENTUI_SRC/.git" ]; then
    echo ">>> Cloning opentui (${OPENTUI_VERSION})..."
    git clone --depth 1 --branch "${OPENTUI_VERSION}" \
        https://github.com/anomalyco/opentui.git "$OPENTUI_SRC"
else
    echo ">>> opentui source exists at $OPENTUI_SRC"
fi

# ---------------------------------------------------------------------------
# 2. Verify layout (fail fast with a clear message if upstream moved again)
# ---------------------------------------------------------------------------
OPENTUI_NATIVE_DIR="$OPENTUI_SRC/packages/native"
if [ ! -f "$OPENTUI_NATIVE_DIR/build.zig" ]; then
    echo "ERROR: build.zig not found at $OPENTUI_NATIVE_DIR/build.zig" >&2
    echo "       opentui ${OPENTUI_VERSION} does not use the packages/native layout." >&2
    echo "       Check OPENTUI_VERSION in env.sh against the v2 source's catalog." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 3. Apply the Android libc linking patch
# ---------------------------------------------------------------------------
# Without it:
#   * link_libc = true fails - Zig cannot provision a bionic libc
#   * the .so ends up without NEEDED libc.so, so Android's dlopen() cannot
#     resolve symbols like getauxval
OPENTUI_PATCH="$REPO_ROOT/patches/opentui/android-libc-link-0.5.x.patch"
if [ ! -f "$OPENTUI_PATCH" ]; then
    echo "ERROR: opentui Android patch not found at $OPENTUI_PATCH" >&2
    exit 1
fi
echo ">>> Applying opentui Android patch: $(basename "$OPENTUI_PATCH")"
if (cd "$OPENTUI_SRC" && git apply --check "$OPENTUI_PATCH" 2>/dev/null); then
    (cd "$OPENTUI_SRC" && git apply "$OPENTUI_PATCH")
    echo "    Patch applied successfully"
elif (cd "$OPENTUI_SRC" && git apply --reverse --check "$OPENTUI_PATCH" 2>/dev/null); then
    echo "    Patch already applied, skipping"
else
    echo "ERROR: patch does not apply cleanly to opentui ${OPENTUI_VERSION}" >&2
    echo "       The patch is line-adapted; rebase it against this tag." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 4. Precompile yoga C++ with the NDK clang++
# ---------------------------------------------------------------------------
# Zig cannot cross-compile C++ against a bionic libc it cannot provision, so we
# compile yoga's C++ with the NDK's own clang++ (which sets up the correct
# bionic + libc++ include ordering by construction) and let Zig link the .o
# files. The patched addYogaDependencies reads OPENTUI_YOGA_OBJS_DIR.
if [ -z "${ANDROID_NDK_HOME:-}" ] || [ ! -d "${ANDROID_NDK_HOME:-/nonexistent}" ]; then
    echo "ERROR: ANDROID_NDK_HOME is not set or does not exist: ${ANDROID_NDK_HOME:-<unset>}" >&2
    exit 1
fi

echo ">>> Precompiling yoga C++ with NDK clang++ ..."
# Must match the yoga version in packages/native/build.zig.zon.
YOGA_TAG="${YOGA_TAG:-v3.2.1}"
if [ ! -d "$YOGA_SRC/.git" ]; then
    git clone --depth 1 --branch "$YOGA_TAG" \
        https://github.com/facebook/yoga.git "$YOGA_SRC"
else
    echo "    yoga source exists at $YOGA_SRC"
fi

mkdir -p "$YOGA_OBJS"
if [ ! -x "$ANDROID_CXX" ]; then
    echo "ERROR: NDK clang++ not found at $ANDROID_CXX" >&2
    exit 1
fi

# Keep in sync with YOGA_CXX_SOURCES in packages/native/build.zig.
# If upstream adds/removes a source, this list must change with it or the link
# step fails with undefined symbols.
YOGA_SOURCES=(
    yoga/YGConfig.cpp yoga/YGEnums.cpp yoga/YGNode.cpp
    yoga/YGNodeLayout.cpp yoga/YGNodeStyle.cpp yoga/YGPixelGrid.cpp
    yoga/YGValue.cpp
    yoga/algorithm/AbsoluteLayout.cpp yoga/algorithm/Baseline.cpp
    yoga/algorithm/Cache.cpp yoga/algorithm/CalculateLayout.cpp
    yoga/algorithm/FlexLine.cpp yoga/algorithm/PixelGrid.cpp
    yoga/config/Config.cpp
    yoga/debug/AssertFatal.cpp yoga/debug/Log.cpp yoga/event/event.cpp
    yoga/node/LayoutResults.cpp yoga/node/Node.cpp
)

for src in "${YOGA_SOURCES[@]}"; do
    stem="$(basename "$src" .cpp)"
    "$ANDROID_CXX" -c -fPIC -std=c++20 -fexceptions -frtti \
        -I"$YOGA_SRC" \
        -o "$YOGA_OBJS/$stem.o" "$YOGA_SRC/$src"
done
export OPENTUI_YOGA_OBJS_DIR="$YOGA_OBJS"
if [ -n "${GITHUB_ENV:-}" ]; then
    echo "OPENTUI_YOGA_OBJS_DIR=$YOGA_OBJS" >> "$GITHUB_ENV"
fi
echo "    yoga C++ objects -> $YOGA_OBJS (${#YOGA_SOURCES[@]} objects)"

# ---------------------------------------------------------------------------
# 5. Build with Zig
# ---------------------------------------------------------------------------
# -Dlibrary-target accepts an arbitrary triple; unrecognised targets are treated
# as custom (build.zig falls through SUPPORTED_TARGETS to buildTarget directly),
# so we do not need to patch the target table.
echo ">>> Building with Zig (target: ${ANDROID_TRIPLE})..."
cd "$OPENTUI_NATIVE_DIR"

# Cap Zig's own parallelism: linking libopentui.so is memory hungry and GitHub's
# free runners have ~16GB. ZIG_JOBS lets CI tune this.
ZIG_JOBS="${ZIG_JOBS:-2}"
"$ZIG_BIN" build \
    -Dlibrary-target="${ANDROID_TRIPLE}" \
    -Doptimize=ReleaseSafe \
    -j"${ZIG_JOBS}" \
    --prefix . 2>&1

# build.zig installs to dest_dir="../lib/{output_name}" relative to --prefix,
# so with --prefix=. (= packages/native) the .so lands at
# packages/native/../lib/aarch64-linux-android/libopentui.so
# i.e. packages/lib/aarch64-linux-android/libopentui.so
LIBOPENTUI="$OPENTUI_NATIVE_DIR/../lib/${ANDROID_TRIPLE}/libopentui.so"

if [ ! -f "$LIBOPENTUI" ]; then
    # Fall back to a search before giving up - upstream may move the dest dir.
    echo "WARNING: libopentui.so not at expected path, searching ..." >&2
    LIBOPENTUI="$(find "$OPENTUI_SRC" -name libopentui.so -type f 2>/dev/null | head -1 || true)"
fi
if [ -z "$LIBOPENTUI" ] || [ ! -f "$LIBOPENTUI" ]; then
    echo "ERROR: libopentui.so not found after build" >&2
    echo "       Expected at: $OPENTUI_NATIVE_DIR/../lib/${ANDROID_TRIPLE}/libopentui.so" >&2
    find "$OPENTUI_SRC" -name '*.so' -type f 2>/dev/null || true
    exit 1
fi

# ---------------------------------------------------------------------------
# 6. Stage into the OTUI_ASSET_ROOT layout
# ---------------------------------------------------------------------------
# @opentui/core resolves $OTUI_ASSET_ROOT/<packageName>/<fileName> where
# packageName = "@opentui/core-linux-arm64" and fileName = "libopentui.so"
# (see getNativeAssetDescriptor in @opentui/core). Reproduce that layout here so
# the tarball can be unpacked straight into the asset root on device.
STAGE_DIR="$WORK_DIR/${ASSET_ROOT_NAME}/@opentui/core-linux-arm64"
mkdir -p "$STAGE_DIR"
cp -f "$LIBOPENTUI" "$STAGE_DIR/libopentui.so"

echo ""
echo "=== libopentui.so build complete ==="
echo "Built:  $LIBOPENTUI"
echo "Staged: $STAGE_DIR/libopentui.so"
echo "Size:   $(du -h "$STAGE_DIR/libopentui.so" | cut -f1)"

# ---------------------------------------------------------------------------
# 7. Verify NEEDED entries (Android dlopen requires them)
# ---------------------------------------------------------------------------
if readelf -d "$STAGE_DIR/libopentui.so" 2>/dev/null | grep -q "NEEDED.*libc.so"; then
    echo "OK: libopentui.so has NEEDED: libc.so (required for Android dlopen)"
else
    echo "ERROR: libopentui.so is missing NEEDED: libc.so" >&2
    echo "       Android dlopen() will fail to resolve getauxval and friends." >&2
    echo "       Ensure ANDROID_NDK_HOME is set and the patch was applied." >&2
    readelf -d "$STAGE_DIR/libopentui.so" 2>/dev/null | grep NEEDED \
        || echo "       (no NEEDED entries found)"
    exit 1
fi
