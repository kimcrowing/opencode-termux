# OpenCode for Termux (Android 10+ Compatible Build)

Build system for cross-compiling [OpenCode](https://github.com/anomalyco/opencode) to run natively on Android devices via [Termux](https://termux.dev/).

This repository provides an **independent, automated build system** that cross-compiles OpenCode for Android aarch64 with **Android 10 compatibility fixes** built in. Builds run automatically on GitHub-hosted runners.

On **Android 10 (API 29)** and similar older versions, upstream builds (which target newer Android versions) start but die after 30-120 seconds with:

```
Fatal signal 31 (SIGSYS), code 1 (SYS_SECCOMP)
Cause: seccomp prevented call to disallowed arm64 system call 291 (openat2)
Cause: seccomp prevented call to disallowed arm64 system call 434 (pidfd_open)
```

Android 10's per-app seccomp allow-list predates these syscalls, so the kernel sends SIGSYS instead of returning ENOSYS. Bun's errno-based fallbacks never get a chance to run.

This build **integrates the fixes at compile time** so the published binaries run on Android 10+ out of the box.

## What This Build Fixes

| Issue | Solution |
|-------|----------|
| **SIGSYS crashes (Android 10)** | `libseccomp_shim.so` converts seccomp SIGSYS kills into ENOSYS returns, letting Bun's fallback paths work |
| **SIGABRT on Android 11+** | `libtagfix.so` disables bionic heap pointer tagging that breaks Bun/JSC's NaN-boxing |
| **MCP server crashes** | `npx` shebang fixed; MCP servers now use absolute `node` path |
| **Bun process.env on Android** | Wrapper restores `process.env` from `/proc/self/environ` at startup |
| **Bun epoll_pwait2 issue** | `BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1` disables problematic syscall |

## Installation

### Option 1: Standalone Binary (Recommended)

Download the latest release from [releases](https://github.com/kimcrowing/opencode-termux/releases):

```bash
# Download and install
mkdir -p $PREFIX/libexec/opencode $PREFIX/lib
unzip opencode-*-android-aarch64.zip
mv opencode $PREFIX/bin/opencode
chmod +x $PREFIX/bin/opencode
mv opencode.bin $PREFIX/libexec/opencode/opencode.bin
chmod +x $PREFIX/libexec/opencode/opencode.bin
mv libtagfix.so libc++_shared.so libopentui.so libseccomp_shim.so $PREFIX/lib/

# Install required dependency
pkg install ripgrep

# Run
opencode
```

### Option 2: Pacman Package (Termux)

```bash
curl -LO https://github.com/kimcrowing/opencode-termux/releases/latest/download/opencode-aarch64.pkg.tar.xz
pacman -U opencode-*-aarch64.pkg.tar.xz
opencode
```

### Option 3: Deb Package

```bash
curl -LO https://github.com/kimcrowing/opencode-termux/releases/latest/download/opencode-aarch64.deb
dpkg -i opencode-*.deb
opencode
```

## What's Included in Each Package

Every package contains:
- `opencode` — wrapper script (preloads compat libraries)
- `opencode.bin` — standalone Bun binary
- `libtagfix.so` — disables bionic heap pointer tagging (Android 11+)
- `libseccomp_shim.so` — seccomp SIGSYS shim for Android 10
- `libopentui.so` — OpenTUI renderer (ARM64 Android build)
- `libc++_shared.so` — C++ standard library (required by Bun JIT)

## Configuration

Set your AI provider API key:

```bash
# Anthropic Claude
export ANTHROPIC_API_KEY="sk-..."

# Or OpenAI
export OPENAI_API_KEY="sk-..."

# Then run
opencode
```

## What's Fixed vs Upstream

| Issue | Upstream | This Build |
|-------|----------|-----------|
| Android 10 SIGSYS crashes | ❌ Crashes | ✅ Fixed (seccomp shim) |
| Android 11+ heap tagging SIGABRT | ❌ Crashes | ✅ Fixed (libtagfix) |
| `list_documents` tool | ❌ Connection closed | ✅ Works (waf bypass) |
| `OPENCODE_SERVER_PASSWORD` | ❌ Ignored | ✅ Fixed (process.env restore) |
| MCP via `npx` | ❌ Connection closed | ✅ Use absolute `node` path |
| `epoll_pwait2` crash | ❌ Crashes | `BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1` |

## Building From Source

```bash
# Prerequisites: Android NDK r28+, Bun host binary
git clone https://github.com/kimcrowing/opencode-termux
cd opencode-termux
./scripts/apply-patches.sh      # Apply patches to Bun/WebKit/Zig
./scripts/build-bun.sh          # Build Android Bun
./scripts/build-opentui.sh      # Build libopentui.so
./scripts/build-opencode.sh     # Build opencode binary
./scripts/make-packages.sh      # Create all package formats
```

**Requirements:**
- Android NDK r28+
- Host Bun (for bundling)
- Linux build environment (CI/CD or WSL)

## Compatibility Summary

| Feature | Stock/upstream approach | This repository |
|---------|------------------------|-----------------|
| Android 10 support | ❌ | ✅ |
| Built-in seccomp shim | ❌ | ✅ Built-in |
| libtagfix.so | External asset | Built from source |
| libseccomp_shim.so | ❌ Missing | ✅ Built-in |
| OPENCODE_SERVER_PASSWORD | Broken | Fixed (process.env restore) |
| MCP via npx | Broken | Fixed (node absolute path) |
| Target Android | 11+ | **10+** |

## License

MIT License - same as upstream OpenCode.

## Contributing

This build maintains compatibility with upstream OpenCode while adding Android 10 support.
PRs welcome for:
- Android 9 support (seccomp policy may differ)
- Additional MCP server integrations
- Performance optimizations

See [CHANGELOG.md](CHANGELOG.md) for version history.