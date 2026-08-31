# OpenCode for Termux (Android)

Cross-compile [OpenCode](https://github.com/anomalyco/opencode) to run natively on
Android devices via [Termux](https://termux.dev/).

Standing on **OpenCode 1.18.25**, this repository provides an **independent, automated
build system** (`.github/workflows/from-source.yml`) plus the native compat libraries the
resulting binary needs to run on Android.

- Official **Bun 1.4** Android runtime (no self-built Bun/WebKit/ICU).
- **`libopentui.so`** compiled from opentui source — the only native piece with no
  official Android prebuild.
- Runs on **Android 10+** with the seccomp/heap-tagging fixes built in.

## What the from-source chain produces

Two reusable GitHub Actions artifacts per run:

```
opencode       single-file Bun-compiled binary (bun-linux-aarch64-android)
libopentui.so  ARM64 Android native TUI renderer
```

The Android build pipelines are:

```
build-libopentui ->  libopentui.so (aarch64-linux-android), Zig 0.15.2 + NDK r28
build-opencode  ->  opencode (official Bun 1.4 cross-compiled for Android)
```

Triggered by a `v*` tag push (drafts a release) or `workflow_dispatch`
(`opencode_version` input, default `1.18.25`). Stage jobs are isolated so a failed
step only restarts itself.

## Android compat libraries

The two Bun binary still needs three **preloaded native libraries** that Android's
bionic does not provide by default. Their sources live in this repo
(`src/tagfix.c`, `src/seccomp_shim.c`); a prebuilt set ships on the release page.

| Library | Fixes |
|---------|-------|
| `libtagfix.so` | Disables bionic **heap pointer tagging** (Android 11+). Bun/JSC NaN-boxing clears the ARM TBI tag on heap pointers, so bionic would `SIGABRT` on `free()` (`"Pointer tag ... was truncated"`). Sets heap tagging off via `mallopt` before JSC starts. |
| `libseccomp_shim.so` | Converts seccomp **`SIGSYS` kills into `ENOSYS` returns** (Android 10). Android's per-app seccomp allow-list predates syscalls Bun uses (`openat2`, `pidfd_open`, `epoll_pwait2`), and delivers a kill instead of an errno, so Bun's own `ENOSYS` fallbacks never get to run. |
| `libc++_shared.so` | C++ std library required by Bun's JIT modules (Android `/system` does not provide it). |

On Android 10, without the shim the binary starts but dies within 30–120 s:

```
Fatal signal 31 (SIGSYS), code 1 (SYS_SECCOMP)
Cause: seccomp prevented call to disallowed arm64 system call 291 (openat2)
Cause: seccomp prevented call to disallowed arm64 system call 434 (pidfd_open)
```

## Installation

Grab the latest artifacts from [releases](https://github.com/kimcrowing/opencode-termux/releases)
(or the `opencode-android` + `libopentui` action artifacts from a dispatch run), then:

```bash
mkdir -p ~/opencode18/{native,lib}
cp opencode ~/opencode18/opencode.bin
cp libopentui.so ~/opencode18/libopentui.so
# compat libraries (from the release / an existing install)
cp libtagfix.so libseccomp_shim.so libc++_shared.so ~/opencode18/lib/
chmod +x ~/opencode18/opencode.bin
pkg install ripgrep
```

### Launcher

`opencode` **will not run standalone** — it needs the preloads and the native libs on
the load path. Use a wrapper like this (this repo ships one at
[`termux/start-opencode.sh`](termux/start-opencode.sh) for the server):

```bash
#!/data/data/com.termux/files/usr/bin/sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"

export TMPDIR="${TMPDIR:-$HOME/tmp}"; mkdir -p "$TMPDIR"
export OPENCODE_DISABLE_TUI_AUDIO=1
export LD_PRELOAD="${DIR}/lib/libtagfix.so:${DIR}/lib/libseccomp_shim.so"
export LD_LIBRARY_PATH="${DIR}/lib"
export OPENTUI_LIB_PATH="${DIR}/libopentui.so"

exec "$DIR/opencode.bin" "$@"
```

Save it as `opencode` next to `opencode.bin`, `chmod +x`, and run it. Without the
`LD_PRELOAD` of `libtagfix.so` you get a `Bad system call` (SIGSYS from bionic TBI
heap tagging).

## Running two versions side-by-side

Install a new build under its own directory and call it by path — it shares nothing
with an existing install except the data/config dirs (below):

```bash
opencode --version                        # existing install
~/opencode18/opencode --version           # new build
```

> Data & config are shared: `~/.local/share/opencode/opencode.db`,
> `~/.config/opencode/opencode.json` and the `~/.config/opencode/plugins/*` are used
> by every version. This is intentional — sessions, credentials and plugins carry over
> between test installs.

## Configuration

Provider credentials are managed per-version through `opencode auth` / `providers list`
(`~/.local/share/opencode/auth.json`). For the headless server, set:

```bash
export OPENCODE_SERVER_PASSWORD="secret"    # HTTP basic-auth password
export OPENCODE_SERVER_USERNAME="opencode"  # default username
```

## Server & HTTP API

```bash
./opencode serve --hostname 0.0.0.0 --port 4096
```

The server authenticates with **HTTP Basic Auth** — `Authorization: Basic
base64(<username>:<password>)` (username defaults to `opencode`, password from
`OPENCODE_SERVER_PASSWORD`). Unauthenticated requests get `401`. `web`, `serve`
and the `/session`, `/message`, `/part`, `/config`, `/tools`, `/models` endpoints all
honour it.

## Verified against 1.18.25 (2026-08-31)

Tested on this machine with the from-source 1.18.25 artifacts, installed as a side-by-side
coexisting build:

| Area | Result |
|------|--------|
| `--version` / `--help` / TUI logo | ✅ |
| `debug paths` / `info` / `config` / `skill` | ✅ full config + 5 plugins + skills load |
| `db` / `session list` / `export` / `stats` | ✅ reads/writes the shared DB |
| `models` | ✅ 21 models (opencode free + codebuddy) |
| `run` (real model call) | ✅ opencode/big-pickle returns |
| MCP `mcp list` | ✅ firecrawl / scholar_mcp / browserless connected |
| MCP real tool call | ✅ `firecrawl_firecrawl_search` invoked |
| plugin tool (`dingtalk_status`) | ✅ local plugin tool invoked |
| HTTP Basic Auth + all endpoints | ✅ 200 authed / 401 without |

## Known issues

- **scholar-mcp `year_range` schema** (1.18.25+ stricter): the bundled
  `scholar-mcp` used `z.tuple([...])` which produces an array-form JSON Schema
  `items` that 1.18.25's strict validation rejects on startup
  (`Tool 65 ... is not of type 'object','boolean'`). Fix: change its two
  `z.tuple([z.number().int(), z.number().int()])` to
  `z.array(z.number().int()).length(2)`. This only bites when running the same MCP
  against 1.18.25.
- **Shared DB columns**: some plugins (e.g. `codebuddy`) may write schema not present
  in an older DB (e.g. `replacement_seq`). Irrelevant if the plugin is removed.
- **`db` `LEFT()`**: Bun's bundled sqlite has no `LEFT()` string function; use
  `substr()`.

## Building From Source

Prerequisites on the runner: Android NDK r28+, Zig 0.15.2, host Bun 1.4+.

```bash
git clone https://github.com/kimcrowing/opencode-termux
cd opencode-termux
source scripts/env.sh
./scripts/build-opentui.sh             # build libopentui.so (NDK clang++ + Zig)
bun ./scripts/build-opencode-android.ts # bundle opencode w/ official Bun for android
```

Notes for `libopentui.so` on Android:

- **Yoga C++** (added in opentui v0.4.5) is compiled with the NDK `clang++`
  (`-fPIC -std=c++20`), *not* Zig — Zig 0.15.2 cannot cross-compile C++ against a
  bionic libc it cannot provision. The `.o` files are linked into the Zig-built `.so`.
- `yoga.zig` uses `std.heap.page_allocator` rather than `c_allocator` (which would
  require `linkLibC()` on a libc-less Android target).
- The `.so` gets `NEEDED libc.so` + `NEEDED libc++_shared.so` via NDK stubs so Android
  `dlopen()` can resolve `getauxval` etc.

The whole pipeline is automated in `.github/workflows/from-source.yml`.

## License

MIT — same as upstream OpenCode.

## Contributing

PRs welcome for Android 9 support (seccomp policy differs), additional MCP/server
integrations, and compatibility fixes. See
[`docs/TERMUX_OPENCODE_PATCHES.md`](docs/TERMUX_OPENCODE_PATCHES.md) for the patch
history.
