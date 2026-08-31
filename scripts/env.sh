#!/usr/bin/env bash
# Environment variables for building OpenCode for Android aarch64
# Source this file before running any build scripts:
#   source scripts/env.sh

set -euo pipefail

export REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Versions — from-source chain (no self-built Bun/WebKit/ICU; use official
# Bun android runtime + opentui native compiled from source).
# BUN_VERSION is the official Bun whose --target supports bun-linux-aarch64-android
# (>= 1.4.0). OPENCODE_VERSION is the opencode release being built.
export OPENCODE_VERSION="${OPENCODE_VERSION:-1.18.25}"
# @opentui/core version bundled by the pinned OPENCODE_VERSION (resolved from
# opencode's bun.lock catalog). Its native libopentui.so has NO official android
# prebuild, so we compile it from opentui source for aarch64-linux-android.
export OPENTUI_VERSION="${OPENTUI_VERSION:-v0.4.5}"
export ZIG_VERSION="${ZIG_VERSION:-0.15.2}"
export ANDROID_API="${ANDROID_API:-24}"

# Official Bun android runtime tag to bundle with (embeds the bun-linux-*-android
# runtime; --compile target string is bun-linux-aarch64-android).
export BUN_VERSION="${BUN_VERSION:-1.4.0}"
export BUN_TAG="bun-v${BUN_VERSION}"

# Android NDK
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

# Build directories (all relative to REPO_ROOT)
export WORK_DIR="${WORK_DIR:-${REPO_ROOT}/build}"
export OPENTUI_SRC="${WORK_DIR}/opentui-src"
export OPENCODE_SRC="${WORK_DIR}/opencode-src"

# ICU / deps prefix — consumed by build-icu.sh / build-webkit.sh and the
# build.yml ICU job (deps-android/prefix cache + icu-prefix.tar artifact).
export ICU_SRC="${WORK_DIR}/icu-src"
export DEPS_PREFIX="${WORK_DIR}/deps-android/prefix"

# Where the built android assets live and are reachable at runtime via
# OTUI_ASSET_ROOT (see opentui platform/runtime-assets). Layout mirrors the
# @opentui/core-linux-arm64 package: <dir>/libopentui.so.
export OPENTUI_ANDROID_DIR="${WORK_DIR}/opentui-android"
export OPENTUI_ANDROID_SO="${OPENTUI_ANDROID_DIR}/libopentui.so"

export DIST_DIR="${WORK_DIR}/dist"

# Number of parallel jobs (can be overridden for low-RAM machines)
export JOBS="${JOBS:-$(nproc)}"

echo "=== OpenCode Android Build Environment ==="
echo "Repo root:     ${REPO_ROOT}"
echo "Work dir:      ${WORK_DIR}"
echo "NDK:           ${ANDROID_NDK_HOME}"
echo "API Level:     ${ANDROID_API}"
echo "Target:        ${ANDROID_TRIPLE}"
echo "Bun runtime:   ${BUN_VERSION} (official --target=bun-linux-aarch64-android)"
echo "OpenCode ver:  ${OPENCODE_VERSION}"
echo "OpenCode ver:  ${OPENCODE_VERSION}"
echo "Jobs:          ${JOBS}"
echo "==========================================="
