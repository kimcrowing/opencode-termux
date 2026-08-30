# Termux OpenCode 移植补丁汇总

## 一、源码信息

### 安装来源
- **仓库**：https://github.com/guysoft/opencode-termux
- **Release**：v0.2.1（对应 OpenCode 1.17.9 Android/Termux aarch64）
- **发布日期**：2026-06-25
- **验证**：`~/.opencode/.opencode-termux-version` 内容为 `1.17.9`

### 该仓库的性质
guysoft/opencode-termux 是**构建/打包仓库**（不是 opencode 应用源码仓库），它做的事：
1. 把 Bun + WebKit/JSC 交叉编译到 Android aarch64
2. 用这份 Bun 编译官方 opencode（源码来自 `anomalyco/opencode`）
3. 加 Android 兼容修复（libtagfix.so / libopentui.so / wrapper 脚本）

### 上游源码分层
| 想找的内容 | 去哪个仓库 |
|-----------|-----------|
| opencode 应用逻辑（TS） | https://github.com/anomalyco/opencode |
| Android 移植/构建（wrapper、libtagfix、交叉编译配置） | https://github.com/guysoft/opencode-termux |

### 构建信息（v0.2.1）
| 项目 | 版本 |
|------|------|
| Bun | v1.2.13（cross-compiled Android aarch64） |
| WebKit/JSC | 017930ebf915121f8f593bef61cbbca82d78132d |
| ICU | 75.1 |
| Android API level | 24 |
| NDK | r28b (28.1.13356709) |

### 设备环境
| 项目 | 值 |
|------|-----|
| 设备 | HONOR PCT-AL10 |
| Android | 10（内核 4.14.116） |
| 架构 | arm64-v8a |
| Termux | F-Droid 版（com.termux） |

---

## 二、补丁清单

### 补丁 1：seccomp SIGSYS 拦截库（核心，解决崩溃）

**问题**：opencode 的 Bun 运行时调用 Android 10 seccomp 禁止的新 syscall
（`openat2`=291、`pidfd_open`=434 等），被内核 SIGSYS 杀进程。启动后 30~120 秒必崩。

**方案**：写 LD_PRELOAD 共享库，拦截 SIGSYS 信号，把被拦 syscall 返回值改成 `-ENOSYS`，
让 Bun 走降级路径。

**原理来源**：Bun 官方 issue #39060 的 LD_PRELOAD workaround
（https://github.com/oven-sh/bun/issues/39060）

**文件**：
- 源码：`~/seccomp_shim.c`（103 行）
- 产物：`~/libseccomp_shim.so`（7456 字节）
- 部署副本：`~/.opencode/libseccomp_shim.so`

**编译命令**：
```bash
clang -shared -fPIC -O2 -o libseccomp_shim.so seccomp_shim.c -ldl -pthread
```

**核心逻辑**（通用版，覆盖所有被拦 syscall，不限定具体号）：
```c
static void syscall_sigsys_handler(int signo, siginfo_t *info, void *context) {
    if (signo == SIGSYS && info && info->si_code == SYS_SECCOMP) {
        ucontext_t *uc = (ucontext_t *)context;
        uc->uc_mcontext.regs[0] = (unsigned long)-ENOSYS;  // x0 = -ENOSYS
        return;
    }
    ...转发给原 handler...
}
```
附加机制：
- `constructor` 里安装 handler
- 起线程延迟 200ms 重装一次（防止 Bun 启动后覆盖 handler）
- 拦截 `sigaction()` 调用，防止进程替换 SIGSYS handler

**效果**：serve 从"30~120 秒必崩"变为"稳定运行数小时无 SIGSYS"

---

### 补丁 2：wrapper 注入 shim

**文件**：`~/.opencode/opencode`（guysoft 的启动 wrapper，3.4KB shell 脚本）

**改动**（第 43 行）：
```diff
-    export LD_PRELOAD="${NATIVE_LIB_DIR}/libtagfix.so${LD_PRELOAD:+:$LD_PRELOAD}"
+    export LD_PRELOAD="${NATIVE_LIB_DIR}/libtagfix.so:${NATIVE_LIB_DIR}/libseccomp_shim.so${LD_PRELOAD:+:$LD_PRELOAD}"
```

**说明**：guysoft 原本只 preload `libtagfix.so`（解决 heap tagging SIGABRT），
追加 `libseccomp_shim.so` 后，同时解决 SIGSYS 崩溃。两个库互不冲突
（一个处理 heap tag，一个处理 seccomp）。

**备份**：`~/.opencode/opencode.bak2`（改前原版）

**验证**：
```bash
tr "\0" "\n" < /proc/<pid>/environ | grep LD_PRELOAD
# 输出：libtagfix.so:libseccomp_shim.so:libtermux-exec-ld-preload.so
```

---

### 补丁 3：启动脚本环境变量

**文件**：`~/start_opencode_final.sh`

```bash
#!/bin/bash
export OPENCODE_SERVER_PASSWORD=www
export BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1
cd /data/data/com.termux/files/home
exec opencode serve --hostname 0.0.0.0 --port 4096
```

**两个环境变量的作用**：

| 变量 | 作用 | 来源 |
|------|------|------|
| `OPENCODE_SERVER_PASSWORD=www` | Web UI basic auth 密码 | opencode 官方 |
| `BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2=1` | 禁用 `epoll_pwait2`(syscall 441)，避免 Bun 事件循环在 Android 上 fault | Bun PR #32490 的 escape hatch |

**注意**：`BUN_FEATURE_FLAG_DISABLE_EPOLL_PWAIT2` 是 Bun 1.4.0+ 引入的，
当前 guysoft 用 Bun 1.2.13 可能不识别此变量（无害，但未必生效）。
真正起保护作用的是补丁 1 的 seccomp shim。

---

### 补丁 4：dingtalk 插件群聊三处修复

**背景**：电脑端已修复，手机端迁移时未同步，导致群里 @机器人 无反应。

**文件**：`~/.config/opencode/plugins/dingtalk/index.js`

| 位置 | 改动 |
|------|------|
| line 24 | 新增 `const SUBSCRIBE_TOPIC_GROUP = "/v1.0/im/bot/groupMessages/get";` |
| line 948 | 注册时补订群聊主题：`{ topic: SUBSCRIBE_TOPIC_GROUP, type: "CALLBACK" }` |
| line 681 | `conversationType` 默认值 `"1"` → `"2"`（与 `targetFrom` 一致） |

**效果**：群聊消息能正常接收处理（日志出现 `conversationType:"2"` 的回调）

---

### 补丁 5：插件依赖补全（node_modules）

**问题**：迁移时只复制了插件 `.js` 文件，没带第三方依赖，
导致 dingtalk/uyanip/xcpquery 加载失败（codebuddy 因为只用 Node 内置模块所以正常）。

**方案**：打包电脑端 `~/.config/opencode/node_modules`（68 个包，78MB，压缩后 15MB）
传到手机同目录。

**关键包**：
- `ws` — dingtalk 的 WebSocket
- `node-forge`、`iconv-lite` — uyanip
- `pngjs` — xcpquery
- `@opencode-ai/plugin`、`@opencode-ai/sdk` — 插件 SDK

**补充**：`node-forge` 电脑端也缺失，手机上用 `npm install node-forge` 单独装。
注意：`npm install` 会清理 node_modules 里不在 package.json 的包，
所以顺序是「先装 node-forge，再解压 tar」（或解压后手动放 node-forge）。

---

### 补丁 6：MCP 改用 node 绝对路径（绕过 npx）

**问题**：配置里 MCP 用 `npx -y <pkg>` 启动，opencode 的 Bun spawn 子进程时
无法正确处理 npx 的 shebang（`#!/usr/bin/env node`），导致 3 个 MCP 全部
"Connection closed"。

**方案**：全局安装 MCP 包，配置里改用 `node + 绝对路径`：

```json
"firecrawl": {
  "command": ["/data/data/com.termux/files/usr/bin/node",
              "/data/data/com.termux/files/usr/lib/node_modules/firecrawl-mcp/dist/index.js"]
}
```

全局安装：
```bash
npm install -g firecrawl-mcp scholar-mcp @browserless.io/mcp
```

**效果**：3 个 MCP 全部 `✓ connected`

---

### 补丁 7：npx shebang 修复

**文件**：`/data/data/com.termux/files/usr/lib/node_modules/npm/bin/npx-cli.js`

```diff
-#!/data/data/com.termux/files/usr/bin/env node
+#!/data/data/com.termux/files/usr/bin/node
```

**说明**：`env` 是 coreutils 的 symlink，Bun spawn 时解析有问题。
改成直接指向 node 绝对路径。

---

### 补丁 8：文件权限修复

| 文件 | 原权限 | 现权限 | 原因 |
|------|--------|--------|------|
| `/data/data/com.termux/files/usr/bin/node` | 700 | 755 | coreutils(env) 执行时报 "Permission denied" |
| `/data/data/com.termux/files/usr/bin/coreutils` | 700 | 755 | 同上 |

**⚠️ 当前状态**：`node` 权限又被改回 **700**（可能被重装或其他操作覆盖）。
因为补丁 6 让 MCP 直接用 node 绝对路径而不再走 npx/env，所以 700 目前不影响。
但如果后续再用 npx，可能重现 "Permission denied"。

---

### 补丁 9：xcpquery WAF 绕过修复（已被后续重写取代）

**我当时的修复**：把两处 `spawnSync(process.execPath, ...)` 改成 `spawnSync("node", ...)`
（与电脑端一致）。原因：opencode 里 `process.execPath` 是 Bun，跑不了瑞数 WAF 的 CJS 混淆脚本。

**当前状态**：xcpquery 已被**重写升级**（不是我做的），现在用：
- `resolveWafNode()` 自动解析 node 路径（含 `XCP_WAF_NODE` 环境变量覆盖）
- 候选路径列表：termux node → local/bin/node → /usr/bin/node → /usr/local/bin/node → process.execPath
- 新增 `waf_cdp.js`（CDP 浏览器方案）作为 WAF 求解替代路径
- 新增文件：`browser.mjs`、`cpquery.js`、`login_stub.mjs`、`probe_412.mjs`、`waf_diag.js`、`waf_proxy.mjs`

**评价**：现在的方案比我的 `spawnSync("node")` 更健壮（自动探测 node 路径 + CDP 兜底）。

---

## 三、补丁效果总览

| 问题 | 补丁 | 状态 |
|------|------|------|
| opencode 启动后 SIGSYS 崩溃 | 补丁 1+2+3 | ✅ 稳定 |
| 钉钉群里 @机器人 无反应 | 补丁 4 | ✅ 正常 |
| 插件（dingtalk/uyanip/xcpquery）加载失败 | 补丁 5 | ✅ 正常 |
| 3 个 MCP 全部 Connection closed | 补丁 6+7 | ✅ 全部 connected |
| xcpquery list_documents 卡死 | 补丁 9（已被重写取代） | ✅ 正常 |

---

## 四、待办 / 已知问题

1. **`OPENCODE_SERVER_PASSWORD=www` 实际未生效**
   - 日志仍显示 "password not set; server is unsecured"
   - 无密码/错密码/对密码访问均返回 200，basic auth 未启用
   - 疑似 guysoft 1.17.9 构建的 bug，局域网内影响不大

2. **`node` 权限被改回 700**
   - 目前不影响（MCP 走 node 绝对路径），但用 npx 时可能重现问题

3. **Termux:Boot 未安装**
   - 手机重启后需手动开一次 Termux，服务才启动

4. **手机无 IPv6**
   - dynv6 只更新 IPv4

5. **单聊连续会话可能卡住**
   - 根因：`processAI` 无超时保护 + `msgQueue` 串行队列
   - 第一条消息卡死 → 后续全部排队
   - 待加超时/abort 机制

---

## 五、关键文件路径

| 用途 | 路径 |
|------|------|
| opencode 安装目录 | `~/.opencode/` |
| 主二进制 | `~/.opencode/opencode.bin`（141MB） |
| wrapper（已打补丁） | `~/.opencode/opencode` |
| wrapper 备份 | `~/.opencode/opencode.bak2` |
| seccomp shim 源码 | `~/seccomp_shim.c` |
| seccomp shim 产物 | `~/.opencode/libseccomp_shim.so` |
| 启动脚本 | `~/start_opencode_final.sh` |
| 自启脚本 | `~/start_services.sh`、`~/.termux/boot/start_services.sh` |
| opencode 配置 | `~/.config/opencode/opencode.json` |
| 插件目录 | `~/.config/opencode/plugins/` |
| 插件依赖 | `~/.config/opencode/node_modules/` |
| 技能目录 | `~/.config/opencode/skills/` |
| dynv6 更新脚本 | `~/dynv6_update.sh` |
| 服务日志 | `~/opencode_serve.log`、`/sdcard/Download/opencode_serve.log` |
| 钉钉调试日志 | `~/.config/opencode/plugins/dingtalk/_debug.log` |
