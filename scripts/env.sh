#!/usr/bin/env bash
# Environment variables for building OpenCode v2 (opencode2) for Android aarch64.
#
# Source this file before running any build script:
#   source scripts/env.sh
#
# OpenCode v2 lives on the upstream `beta` branch and is a full monorepo rewrite:
#   packages/cli  -> the `opencode2` binary (was packages/opencode in v1)
#   packages/app  -> the embedded web UI (Solid + Vite)
# The native TUI library comes from opentui, which has NO android prebuild, so
# it is compiled here from source (see build-opentui.sh).

set -euo pipefail

export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- Upstream source ---------------------------------------------------------
# UPSTREAM_REPO / UPSTREAM_REF pin the opencode v2 source we build against.
# `beta` is the active v2 line; `dev` is the v1 line (do not mix them).
export UPSTREAM_REPO="${UPSTREAM_REPO:-https://github.com/anomalyco/opencode.git}"
export UPSTREAM_REF="${UPSTREAM_REF:-beta}"
# Pin to a known-good commit for reproducible builds. Leave empty to track the
# branch head (CI re-runs will then pick up upstream changes).
export UPSTREAM_SHA="${UPSTREAM_SHA:-}"

# Where the upstream checkout lands. Kept outside REPO_ROOT so it can be cached
# between CI steps and is never accidentally committed.
export WORK_DIR="${WORK_DIR:-${REPO_ROOT}/build}"
export OPENCODE_SRC="${WORK_DIR}/opencode-src"

# --- Versions ----------------------------------------------------------------
# OpenCode v2 requires a newer Bun than v1 (1.4.0) because packages/cli uses
# Bun APIs added in 1.4.x. 1.4.1 ships bun-linux-aarch64-android.zip, which is
# the compile target we need.
export BUN_VERSION="${BUN_VERSION:-1.4.1}"

# @opentui/core version required by the pinned v2 source (read from the upstream
# catalog in package.json, so this is only a fallback / documentation value).
# v2 uses the packages/native layout; v1 used packages/core/src/zig.
export OPENTUI_VERSION="${OPENTUI_VERSION:-v0.5.10}"

# opentui v0.5.x build.zig hard-checks the Zig version and exits on mismatch.
# 0.15.x will NOT work here - v2 needs Zig 0.16.
export ZIG_VERSION="${ZIG_VERSION:-0.16.0}"

# Android API level. 24 is the floor for the bionic stubs we link against.
export ANDROID_API="${ANDROID_API:-24}"

# --- Android NDK -------------------------------------------------------------
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-/opt/android-ndk}"
export ANDROID_ABI=arm64-v8a
export ANDROID_ARCH=aarch64
export ANDROID_TRIPLE="aarch64-linux-android"
export ANDROID_TRIPLE_API="${ANDROID_TRIPLE}${ANDROID_API}"

# NDK toolchain paths
export NDK_TOOLCHAIN="${ANDROID_NDK_HOME}/toolchains/llvm/prebuilt/linux-x86_64"
export NDK_SYSROOT="${NDK_TOOLCHAIN}/sysroot"
export ANDROID_CC="${NDK_TOOLCHAIN}/bin/${ANDROID_TRIPLE_API}-clang"
export ANDROID_CXX="${NDK_TOOLCHAIN}/bin/${ANDROID_TRIPLE_API}-clang++"
export ANDROID_AR="${NDK_TOOLCHAIN}/bin/llvm-ar"
export ANDROID_RANLIB="${NDK_TOOLCHAIN}/bin/llvm-ranlib"
export ANDROID_STRIP="${NDK_TOOLCHAIN}/bin/llvm-strip"
export ANDROID_NM="${NDK_TOOLCHAIN}/bin/llvm-nm"
export ANDROID_LD="${NDK_TOOLCHAIN}/bin/ld.lld"

# --- Build directories -------------------------------------------------------
export OPENTUI_SRC="${WORK_DIR}/opentui-src"

# Yoga is compiled with the NDK clang++ into .o files and linked by Zig, because
# Zig cannot cross-compile C++ against a bionic libc it cannot provision. The
# source tree is opentui's own vendored copy (zig-deps/yoga), which is the same
# tree build.zig.zon points b.dependency("yoga") at.
export YOGA_SRC="${WORK_DIR}/opentui-src/packages/native/zig-deps/yoga"
export YOGA_OBJS="${WORK_DIR}/yoga-objs"

# --- Runtime asset layout ----------------------------------------------------
# @opentui/core resolves its native library from
#   $OTUI_ASSET_ROOT/@opentui/core-linux-arm64/libopentui.so
# when OTUI_ASSET_ROOT is set, before it ever tries the platform packages (which
# have no android variant). This is the official escape hatch that lets us ship a
# self-compiled libopentui.so without patching opentui's resolver.
export ASSET_ROOT_NAME="${ASSET_ROOT_NAME:-otui-assets}"

echo "=== OpenCode v2 Android Build Environment ==="
echo "Repo root:     ${REPO_ROOT}"
echo "Work dir:      ${WORK_DIR}"
echo "Upstream:      ${UPSTREAM_REPO} @ ${UPSTREAM_SHA:-${UPSTREAM_REF}}"
echo "NDK:           ${ANDROID_NDK_HOME}"
echo "API Level:     ${ANDROID_API}"
echo "Target:        ${ANDROID_TRIPLE}"
echo "Bun runtime:   ${BUN_VERSION} (--target=bun-linux-aarch64-android)"
echo "opentui:       ${OPENTUI_VERSION} (packages/native)"
echo "Zig:           ${ZIG_VERSION}"
echo "CPU:           $(nproc)"
echo "=============================================="
