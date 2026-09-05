# OpenCode for Termux（Android 中文版）

将 [OpenCode](https://github.com/anomalyco/opencode) 交叉编译为可在 Android 设备上
通过 [Termux](https://termux.dev/) **原生运行** 的构建系统。

基于 **OpenCode 1.18.25**，本仓库提供一套**独立的自动化构建系统**
（`.github/workflows/from-source.yml`），加上二进制在 Android 上运行所需的**原生兼容库**。

- 官方 **Bun 1.4** Android 运行时（无需自建 Bun/WebKit/ICU）。
- **`libopentui.so`** 从 opentui 源码编译 —— 这是唯一没有官方 Android 预编译产物的原生组件。
- 内置 seccomp / 堆指针标记修复，支持 **Android 10+**。

## from-source 构建链的产物

每次构建产生两个可复用 GitHub Actions artifact：

```
opencode      单文件 Bun 编译二进制 (bun-linux-aarch64-android)
libopentui.so ARM64 Android 原生 TUI 渲染库
```

Android 构建流水线：

```
build-libopentui ->  libopentui.so (aarch64-linux-android), Zig 0.15.2 + NDK r28
build-opencode  ->  opencode（官方 Bun 1.4 交叉编译到 Android）
```

由 `v*` tag push（会草拟 release）或 `workflow_dispatch`
（`opencode_version` 输入，默认 `1.18.25`）触发。各阶段 job 相互隔离，失败步骤只需重启自身。

## 项目架构

```
                       ┌────────────────────────────────────────────────┐
                       │          GitHub Actions (ubuntu-latest)        │
                       │             from-source.yml                    │
                       │                                                │
  build-libopentui job │   Zig 0.15.2        NDK r28 clang++            │
  ────────────────────▶│   build-opentui.sh  ──▶ libopentui.so          │
                       │                                                │
  build-opencode job   │   官方 Bun 1.4  ──▶ opencode (单文件二进制)     │
  ────────────────────▶│   build-opencode-android.ts                    │
                       │                                                │
                       └────────────────────────────────────────────────┘
                                       │ upload-artifact
                                       ▼
                             opencode + libopentui.so
                                       │ release 页面（预编译包）
                                       ▼
   ┌─────────────┐   ┌───────────────┐   ┌───────────────────┐   ┌───────────┐
   │ opencode    │ + │ libopentui.so │ + │ libtagfix.so      │ + │ libc++_   │
   │ (Bun 二进制)│   │ (TUI 渲染)    │   │ libseccomp_shim.so│   │ shared.so │
   └─────────────┘   └───────────────┘   └───────────────────┘   └───────────┘
       由 wrapper 预加载: LD_PRELOAD + LD_LIBRARY_PATH + OPENTUI_LIB_PATH
                                       │
                                       ▼
               在 Termux 中于 Android 10+ (aarch64) 原生运行
```

目录结构：

| 路径 | 用途 |
|------|------|
| `.github/workflows/from-source.yml` | 两阶段 CI：先构建 `libopentui.so`，再打包 `opencode`（官方 Bun）。另含 `opencode.yml`（评论触发构建）和 `test-opentui.yml`（libopentui 快速重建测试）。 |
| `scripts/env.sh` | 统一管理构建版本/路径/工具链（NDK、Zig、Bun、目标三元组）。 |
| `scripts/build-opentui.sh` | 从 opentui 源码编译 `libopentui.so`（Yoga C++ 用 NDK clang++，其余用 Zig）。 |
| `scripts/build-opencode-android.ts` | 将 opencode 打包为单个 `bun-linux-aarch64-android` 二进制（内嵌 Web UI）。 |
| `src/tagfix.c` | `libtagfix.so` 的源码（关闭 Android 11+ 堆指针标记）。 |
| `src/seccomp_shim.c` | `libseccomp_shim.so` 的源码（将 Android 10 的 seccomp `SIGSYS` 转为 `ENOSYS`）。 |
| `patches/opentui/*.patch` | 应用到 opentui 源码的 Android 修复（libc 链接、v0.4.5 平台名归一化）。 |
| `termux/start-opencode.sh` | 无头服务器启动器（`opencode serve`，设置 `OPENCODE_SERVER_PASSWORD` 与 `BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2`）。 |

## Android 兼容库

Bun 二进制仍需要三个 Android bionic 默认不提供的**预加载原生库**。
其源码在本仓库（`src/tagfix.c`、`src/seccomp_shim.c`）；预编译包随 release 页面发布。

| 库 | 修复内容 |
|----|----------|
| `libtagfix.so` | 关闭 bionic **堆指针标记**（Android 11+）。Bun/JSC 的 NaN-boxing 会清除 ARM TBI 标记的高位，导致 bionic 在 `free()` 时 `SIGABRT`（`"Pointer tag ... was truncated"`）。通过 `mallopt` 在 JSC 启动前关闭堆标记。 |
| `libseccomp_shim.so` | 将 seccomp **`SIGSYS` 杀死转为 `ENOSYS` 返回**（Android 10）。Android 的 per-app seccomp 白名单早于 Bun 使用的系统调用（`openat2`、`pidfd_open`、`epoll_pwait2`），直接交付 kill 而非 errno，导致 Bun 自身的 `ENOSYS` 回退从未执行。 |
| `libc++_shared.so` | Bun 的 JIT 模块所需的 C++ 标准库（Android `/system` 不提供）。 |

在 Android 10 上，若缺少该 shim，二进制启动后会在 30–120 秒内崩溃：

```
Fatal signal 31 (SIGSYS), code 1 (SYS_SECCOMP)
Cause: seccomp prevented call to disallowed arm64 system call 291 (openat2)
Cause: seccomp prevented call to disallowed arm64 system call 434 (pidfd_open)
```

## 安装

从 [releases](https://github.com/kimcrowing/opencode-termux/releases) 获取最新产物
（或从 dispatch 运行得到的 `opencode-android` + `libopentui` 两个 action artifact），然后：

```bash
mkdir -p ~/opencode18/{native,lib}
cp opencode ~/opencode18/opencode.bin
cp libopentui.so ~/opencode18/libopentui.so
# 兼容库（来自 release / 已有安装）
cp libtagfix.so libseccomp_shim.so libc++_shared.so ~/opencode18/lib/
chmod +x ~/opencode18/opencode.bin
pkg install ripgrep
```

### 启动器（Launcher）

`opencode` **无法独立运行** —— 它需要预加载与原生库在加载路径上。使用类似下面的
wrapper（本仓库在 [`termux/start-opencode.sh`](termux/start-opencode.sh) 提供服务器版）：

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

将其保存为 `opencode` 放在 `opencode.bin` 旁，`chmod +x` 后运行。若不 `LD_PRELOAD`
`libtagfix.so`，会报 `Bad system call`（bionic TBI 堆标记导致的 SIGSYS）。

## 两个版本共存运行

把新构建安装到独立目录并按路径调用 —— 除数据/配置目录（见下）外，与现有安装互不共享：

```bash
opencode --version                        # 现有安装
~/opencode18/opencode --version           # 新构建
```

> 数据与配置是共享的：`~/.local/share/opencode/opencode.db`、
> `~/.config/opencode/opencode.json` 及 `~/.config/opencode/plugins/*` 被每个版本共用。
> 这是有意的 —— 会话、凭证与插件可在不同测试安装之间沿用。

## 配置

Provider 凭证通过 `opencode auth` / `providers list` 逐版本管理
（`~/.local/share/opencode/auth.json`）。无头服务器设置：

```bash
export OPENCODE_SERVER_PASSWORD="secret"    # HTTP basic-auth 密码
export OPENCODE_SERVER_USERNAME="opencode"  # 默认用户名
```

## 服务器与 HTTP API

```bash
./opencode serve --hostname 0.0.0.0 --port 4096
```

服务器使用 **HTTP Basic Auth** 鉴权 —— `Authorization: Basic
base64(<username>:<password>)`（用户名默认 `opencode`，密码来自
`OPENCODE_SERVER_PASSWORD`）。未鉴权请求返回 `401`。`web`、`serve` 以及
`/session`、`/message`、`/part`、`/config`、`/tools`、`/models` 端点都遵循该鉴权。

## 针对 1.18.25 的可验证测试（2026-08-31）

### 测试环境

| 项 | 值 |
|----|----|
| 设备 | HONOR **PCT-AL10** (HWPCT) |
| 厂商 | HUAWEI / HONOR |
| Android | **10**（API 29），`10.1.0.162C00` |
| 安全补丁 | 2020-08-01 |
| 内核 | Linux 4.14.116 (aarch64) |
| ABI | arm64-v8a |
| Termux 运行时 | Node v24.18.0、git 2.55.0 |
| OpenCode | **1.18.25**（from-source 链，action run `33370408745`，head `52676ba6`） |
| 安装方式 | 共存目录 `~/.opencode18/` + wrapper（`LD_PRELOAD libtagfix.so:libseccomp_shim.so`，`OPENTUI_LIB_PATH=.../libopentui.so`） |

以下所有检查均在**这台 Android 10 设备上**通过 Termux shell 执行。

### 测试结果

| 项目 | 结果 |
|------|------|
| `--version` / `--help` / TUI logo | ✅ |
| `debug paths` / `info` / `config` / `skill` | ✅ 完整配置 + 5 个插件 + skills 加载 |
| `db` / `session list` / `export` / `stats` | ✅ 读写共享数据库 |
| `models` | ✅ 21 个模型（opencode 免费 + codebuddy） |
| `run`（真实模型调用） | ✅ opencode/big-pickle 正常返回 |
| MCP `mcp list` | ✅ firecrawl / scholar_mcp / browserless 已连接 |
| MCP 真实工具调用 | ✅ `firecrawl_firecrawl_search` 被调用 |
| 插件工具（`dingtalk_status`） | ✅ 本地插件工具被调用 |
| HTTP Basic Auth + 所有端点 | ✅ 带鉴权 200 / 无鉴权 401 |

## 已知问题

- **scholar-mcp `year_range` schema**（1.18.25+ 更严格校验）：内置的
  `scholar-mcp` 使用了 `z.tuple([...])`，会生成数组形式的 JSON Schema `items`，
  被 1.18.25 的严格校验在启动时拒绝（`Tool 65 ... is not of type 'object','boolean'`）。
  修复：将其两处 `z.tuple([z.number().int(), z.number().int()])` 改为
  `z.array(z.number().int()).length(2)`。只有在相同 MCP 下运行 1.18.25 才会触发。
- **共享数据库列**：某些插件（如 `codebuddy`）可能写入旧数据库不存在的 schema
  （如 `replacement_seq`）。若移除该插件则无影响。
- **`db` 的 `LEFT()`**：Bun 内置的 sqlite 无 `LEFT()` 字符串函数；改用 `substr()`。

## 从源码构建

运行机前置：Android NDK r28+、Zig 0.15.2、host Bun 1.4+。

```bash
git clone https://github.com/kimcrowing/opencode-termux
cd opencode-termux
source scripts/env.sh
./scripts/build-opentui.sh              # 构建 libopentui.so（NDK clang++ + Zig）
bun ./scripts/build-opencode-android.ts  # 用官方 Bun 打包 opencode 到 android
```

`libopentui.so` 在 Android 上的实现要点：

- **Yoga C++**（opentui v0.4.5 新增）用 NDK `clang++` 编译（`-fPIC -std=c++20`），
  *而非* Zig —— Zig 0.15.2 无法针对其无法供给的 bionic libc 交叉编译 C++。
  生成的 `.o` 文件链接进 Zig 构建的 `.so`。
- `yoga.zig` 使用 `std.heap.page_allocator` 而非 `c_allocator`（后者在无 libc 的
  Android 目标上需要 `linkLibC()`）。
- 该 `.so` 通过 NDK stub 声明 `NEEDED libc.so` + `NEEDED libc++_shared.so`，
  以便 Android `dlopen()` 能解析 `getauxval` 等符号。

完整流水线自动化于 `.github/workflows/from-source.yml`。

## 许可证

MIT —— 与上游 OpenCode 相同。

## 贡献

欢迎针对 Android 9 支持（seccomp 策略不同）、更多 MCP/服务器集成及兼容性修复提交 PR。

## 发布说明（Release v1.18.25）

首个面向 **Android 10+（aarch64）** 的 from-source 发布（release `v1.18.25`，手动经 API 发布，
未触发 CI 重新构建，使用实测通过的产物）。资产：

- `opencode-1.18.25-android-aarch64` —— 主程序（单文件 Bun 二进制）
- `libopentui.so` —— TUI 原生渲染库
- `libtagfix.so` —— Android 11+ 堆标记修复
- `libseccomp_shim.so` —— Android 10 seccomp shim
- `libc++_shared.so` —— C++ 标准库

下载全部 5 个资产，按上文“安装 + 启动器”部署即可运行。
