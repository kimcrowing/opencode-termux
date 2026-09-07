# opencode-termux 项目须知

> 仓库：`~/.config/opencode/project/opencode-termux`（GitHub `kimcrowing/opencode-termux`）
> 全局/本机通用事实（termux 路径约定、网络可达性、mihomo、chromium LD_PRELOAD 等）
> 见 `~/.config/opencode/AGENTS.md`；本文件只记**本项目专属**内容。

## 1. 仓库与分支
- 主线构建分支 `dev`；**v2 插件迁移分支 `v2`**（本次工作都在这条上）。
- **push 环境（2026-09-07 实测更正）**：远程**只有 `origin`**（直连 `https://github.com/kimcrowing/opencode-termux.git`，
  fetch/push 同一 URL），**无 `github` 远程**；PAT 在 `~/.git-credentials`（`credential.helper=store`），
  **不在** `.git/credentials` 也没有 `git remote add github`（历史版本曾用 gh-proxy origin + github 直连远程，已废弃）。
- 提取 token：`TOKEN=$(sed -n 's#^https://[^:]*:\([^@]*\)@github.com$#\1#p' ~/.git-credentials)`；PAT 带 `workflow` scope，
  改 `.github/workflows/*` 可直接 push。

## 2. CI 工作流
- workflow id `350638463`（`v2-from-source.yml`）；dispatch：
  `POST .../actions/workflows/350638463/dispatches` body `{"ref":"v2","inputs":{"upstream_ref":"beta","skip_web_ui":"false","skip_opentui":"true"}}`
- 上游 `anomalyco/opencode@beta`；6 个 job（build-compat-libs / build-web-assets / build-libopentui / build-opencode2 / package / verify-v2-plugin），全绿约 4–6 分钟。`build-libopentui` 默认被 `skip_opentui=true` 跳过（Termux serve 模式不用 TUI），跳过时 `build-opencode2`/`package` 的 `needs` 用 job 级 `if` 放行。
- 查结果：`GET .../actions/runs/{run_id}`（轮询 status/conclusion）；抓日志：`GET .../actions/jobs/{job_id}/logs` 取 `location:` 签名 URL 再下载 zip。

### workflow 语义坑（实测）
- **顶层 `env:` 不允许用函数/上下文**（`hashFiles`、`runner.temp`）→ `workflow_dispatch` 返回 422 `Unrecognized function: 'hashFiles'`。把 `hashFiles(...)` 内联进每个 `actions/cache` 的 `with.key`（step 级允许）。
- **定位语义错最快方式**：dispatch 返回 422 时响应 body 带 `message` 与 `Line:col`。
- **upload-artifact 的 zip 根就是「上传 path 内容本身」**，download 到某目录直接摊开：上传 `dist/xxx`（内含 `bin/opencode2`）→ 下载到 `package/bin` 后二进制在 `package/bin/bin/opencode2`。**download 不会包一层 artifact 名**。
- **点开头文件默认不上传**（`include-hidden-files: false`，如 `.built-sha` 被静默排除）→ 要传必须显式 `include-hidden-files: true`。
- `hashFiles` 可对任意文件（含 `*.lock`）做 job 级缓存 key；key 里含布尔输入（如 `skip_web_ui`）时两种模式缓存互不污染。
- **`Script.channel`（packages/script）**：env `OPENCODE_CHANNEL` → 否则 `git branch --show-current`（detached checkout 返回空串 → channel=""、`IS_PREVIEW=true`）→ **bundle 与 web-assets 两 job 必须在同状态 checkout 下跑**（都用 `checkout --force FETCH_HEAD`）。`Script` 校验 root packageManager `bun@1.4.1`。
- **改 workflow 文件会让依赖 `hashFiles(workflow)` 的 stage cache 全部失效** → 追纯代码修复时尽量别动 workflow（历史上曾升 actions v5 又 revert 来保缓存）。

### 缓存毒化坑（2026-09-05，已加固）
- `v2-verify-install-Linux-<hashFiles(bun.lock)>` 只哈希 bun.lock；上游**同版本 tarball 被重发**（export map 新增 `./preload`）时缓存里是旧 tarball → 构建报 `error: preload not found "@opentui/solid/preload"`（build-opencode2 新装能过、verify 复用缓存必挂）。
  - 应急：`GET /actions/caches` 找条目 → `DELETE /actions/caches/<id>` 强制重装（run 33949778927 删后一次修复）。
  - 已加固（commit `0b9a4ac`）：key 改为 `v2-verify-install-${{runner.os}}-${{steps.sha.outputs.sha}}-${{hashFiles(bun.lock)}}`（clone 步加 `id: sha`）。同类 `v2-bun-install` / `v2-web-install` 仍只哈希 bun.lock，同症状同样处理。

### 上游源码实证：codebuddy/gateway 补丁内容**不在**上游（2026-09-06 复核）
- **"上游 beta"= `https://github.com/anomalyco/opencode.git` 的 `beta` 分支**（workflow `v2-from-source.yml` clone 步硬编码，非 kimcrowing/opencode-termux）。
- 线上复核（GitHub API `contents/packages/core/src/plugin/provider?ref=beta`，HEAD b2cecc63 = 构建产物 `.built-sha`）：**无 `codebuddy.ts`、无 `gateway-config.ts`、无 `gateway/` 目录、无 `docs/`**。上游原生只有 `gateway.ts`（303B shim）、`llmgateway.ts`、`cloudflare-ai-gateway.ts`——与补丁的 codebuddy/gateway provider 无关。
- **"在本机/缓存树里看到 codebuddy.ts、gateway-* 等文件 = 已打补丁的 dirty 工作树残留**（`git status` 显示 `?? docs/`、`?? codebuddy.ts`、`?? gateway-config.ts`、`?? gateway/` + 3 个 M），曾因clone/restore 复用了打过补丁的树所致。`checkout --force HEAD -- packages/core packages/schema` + `git clean -fd -- packages/core packages/schema docs` 后全部消失 → 证实这些文件从不是上游内容，只是补丁 new file 残留。
- 推论：补丁冲突根因**不是**"上游吸收了补丁"，而是**缓存/工作树毒化**（apply 前未清干净 untracked new file → `already exists`）。修复 commit `848d7d5` 对症，run `34029607479` 已全绿。

### 历史构建线（自建链，已废弃，留档）
- 曾以 `build.yml` 自建 Bun/WebKit/ICU/TinyCC 链，后改用 `from-source.yml`（官方 Bun 1.4）为主力，自建链脚本已 `git rm`（commit `52676ba`）。
- **opencode 源码版本耦合**：v1.17.9 起 TUI worker 从 `cli/cmd/tui/worker.ts` 迁到 `cli/tui/worker.ts`；`scripts/build-opencode-android.ts` 已改为 `fs.existsSync` 探测新旧两路径。
- commit `88c0c69` 修复后 run `33348372376` 全链绿灯（产物 zip 52MB / pkg.tar.xz 32MB / deb）。GitHub release 仅 `v*` tag push 时发布。
- `test-opentui.yml` 在 commit `97fa973` 通过（run 33339845964）：`patches/opentui/android-libc-link.patch` 生效（Android 分支加 NDK bionic 两个系统包含路径）。
- 1.18.25 官方链产物：run `33370408745` 两 job 全绿，artifact `opencode-android` / `libopentui`。

## 3. v1 → v2 插件迁移（2026-09-05）

**目标**：把 v1 插件迁移到 v2 API，每个都以「CI 真实二进制 + workflow 验证步 PASSED」为硬证据。
v1 插件与 `~/.config/opencode/opencode.json` **冻结不改为底线**。
**迁移本身就是对 v2 opencode 的测试**：每个插件都真实加载、注册工具、跑通宿主契约。

| 插件 | commit | CI run | 工具数 | 状态 |
|---|---|---|---|---|
| uyanip | `6bc63ec` + `2a0fe2a` | 33949778927 | 9 | ✅ PASSED |
| xcpquery | `0b9a4ac` | 33953149902 | 7 | ✅ PASSED |
| dingtalk | `3f0932b` | 33954486202 | 12 | ✅ PASSED |
| voice | — | — | — | 用户要求延后（契约已探明，见下） |
| **auth-login**（新增 v2 插件，非迁移） | 待 CI | 待 CI | 12 | 🛠 本机冒烟 PASS（`auth_smoke2.sh`） + GitCode 真端点端到端 PASS；CI 验证步已加入 workflow |

> **auth-login**：通用扫码登录框架（QR 生成→web UI 呈现→后台轮询→token 持久化→可配置活动执行器），
> GitCode 为第一个接入站点，**微信小程序扫码三端点 + 签到/积分端点 + 成长中心 9 类任务触发端点
> 已全部抓包实证**（`web-api.gitcode.com` + `__s=aihub` + `X-Source: toolbar_login`；
> 每日Star/查看热门/分享/更新项目/关注CANN/下载模型文件/完善资料/README 等触发 body 见
> `src/v2-plugin/auth-login/AGENTS.md` §2 任务实证）。

### v2 插件核心契约（实测硬结论）
- `setup(ctx)` 里 `ctx.tool.transform(cb)` 的**回调在插件宿主 worker 运行（独立 global 作用域）**：回调内对外层闭包数组/变量的修改**在 setup 的 `await` 之后不可见**（探针 `sameGlobal:false` 证实）；回调内的副作用（写文件、`editor.list()`）**可见且含 host 全部内置工具**。
  → **验证 sentinel / 组合 ID 捕获必须写在回调内部**。闭包跨 await 传不了，只能靠文件共享。
- `editor.add(...)` 无效时**静默失败**（不抛错）：错误推入 `editor.errors` 并打 `Skipping invalid tool registration`。**plugin "active" 不等于工具已注册**。
- 工具 ID = `options.namespace` + `_` + `name.replace(/[^a-zA-Z0-9_-]/g,"_")`（`packages/core/src/tool/runtime.ts`）。eg. `bad name!` → `bad_name_`。判定以回调内 `editor.list()` 为准。
- HTTP 层**无 tool 列表端点** → CI 验证靠回调内写 sentinel 文件再断言。
- 目录插件是 ESM，**不能用 `require`**（bun 下 ReferenceError → setup 抛错 → 插件静默不加载，`/api/plugin` 里压根不列）。一律 `import`。
- 裸 npm 包（`ws` 等）**由 opencode 二进制内置提供**，插件宿主里 `await import("ws")` 可解析；但 standalone node 会 ERR_MODULE_NOT_FOUND（**排查时别用 standalone node 判定这类失败**）。

### 迁移套路（三插件通用）
- 协议逻辑**原样复制**为 `src/v2-plugin/<name>/core.mjs`，只删 v1 胶水。
  - **必删地雷：`import { tool } from "@opencode-ai/plugin"` 与 `const z = tool.schema;`**——后者位置不固定（xcpquery 在第 90 行、dingtalk 在第 9 行），漏删会 `ReferenceError: tool is not defined` → **插件在加载期就 failed**（`/api/plugin` 里只有 `source` + `state.status:"failed"`、**没有 id**，setup 根本不跑，日志只有 `Plugin failed to load` + 一个 `ref`）。
  - `grep -n "tool("` **查不到它**（不是函数调用），必须 `grep -nE "\btool\b"`。
  - 浏览器/WAF 运行时 `cjs/` 需整体 vendor 进 `src/v2-plugin/<name>/cjs/`（index 里用 `__dir/cjs/...` 解析）。复制 v1 不算修改 v1。
- v2 入口 `server.ts`：注册工具（裸 JSON Schema，无 zod）+ 回调内写 sentinel（`process.env.<NAME>_VERIFY_SENTINEL`）。
- **查加载失败的套路**：起服后 `curl /api/plugin` 只看 `source.type=="local"`；`status:failed` 且无 id = 加载期异常。要真实错误就在探针插件里 `await import('<路径>/core.mjs')` 并 catch。

### v2 会话桥接（dingtalk/voice 必用，本机探针实测）
- `create`：**四种 directory 写法（`body.directory` / `body.location` / 顶层 `directory` / `query.directory`）全被接受但都不生效**，`location.directory` 恒为 server 的 project 目录 → **v1 的 `query:{directory}` 在 v2 失效，插件无法指定会话目录**（v1 dingtalk/voice 的 directory 配置在 v2 下无意义）。
- `create` **直接返回 session 对象**（顶层 `{id,projectID,cost,tokens,time,location}`），**不是 `{data}` 包装**（写 `created.data.id` 会取空）。
- `prompt`：**唯一通过 schema 校验的形状是 `{sessionID, text}`**；`{sessionID, prompt:{text}}` / `body` / `input` / `parts` 全报 `SchemaError(Missing key at ["text"])`。
- 回复需 `wait({sessionID})` 后 `context({sessionID})` 读取（两者都扁平 `{sessionID}`；`{path:{sessionID}}` 报 `Missing key at ["sessionID"]`）。
- `switchModel` 的 `model` 是 **`Model.Ref` 结构化对象**，传 `"opencode/big-pickle"` 字符串报 `SchemaError(Expected Model.Ref)`。
- `session.synthetic({sessionID, text, description})` 可发布消息（返回 `SessionMessage.Info`：`{id,sessionID,timeCreated,type:"synthetic",payload:{text,description},delivery:"steer"}`），但**合成消息不会出现在 `context()` 里**（实测 count=0）。
- 无 provider 时 `prompt` **一直挂起**（不报错）→ 探针必须加超时，否则后续候选全被吞掉。
- `ctx` 顶层键：`app location options agent aisdk catalog command event experimental generate integration mcp permission plugin reference rpc skill storage tool vcs websearch worktree session shell`。
- `ctx.session` 键：`hook create get switchAgent switchModel prompt generate command synthetic interrupt rename move wait context`（**无 `instructions`**）。
- **系统指令注入位 = `ctx.session.hook("context", cb)`**（上游 `packages/core/src/plugin/system-prompt.ts` 即范例）：回调里改 `event.system`——replace 用 `event.system[0]={...system,text:prompt}`，append 用 `event.system.splice(1,0,SystemPart.make(prompt))`。这替代 v1 的每次请求 `body.system`。
  - HTTP 侧 `PUT /api/session/:sid/instructions/entries/:key`（body `{value}`，渲染成 `<context key="...">`）在插件 `ctx.session` 上**不可达**，不要用。
- `PromptInput.Prompt = { text, files?, agents?, skills? }` —— 扁平 `text`，**无 `parts`、无 per-request `system`**。

### 验证脚本与 sentinel 约定
- `tests/v2-plugin/verify.sh <linux-binary>` 全插件验证（codebuddy provider + 四个工具插件 dingtalk/uyanip/xcpquery/auth-login 全部注册且 active，且 `/api/plugin` 无任何非 active 状态）；专项脚本 `verify-uyanip.sh` / `verify-xcpquery.sh` / `verify-dingtalk.sh` / `verify-auth-login.sh`（各自断言 host 合成工具 id），参数都是二进制路径。
- 端口：uyanip `41844` / xcpquery `41845` / dingtalk `41846` / auth-login `41847`（可用 `V2_<NAME>_PORT` 覆盖）。
- sentinel env：`UYANIP_VERIFY_SENTINEL` / `XCPQUERY_VERIFY_SENTINEL` / `DINGTALK_VERIFY_SENTINEL`；脚本内 `PASSWORD="${V2_PASSWORD:-opencode-verify-password}"`。
- 工作流在 ubuntu runner 上 `bun install` 后 build linux-x64 二进制（`--skip-web-ui --skip-install`）再跑。

### voice 迁移待办（用户要求延后，契约已探明）
- v1 的 `VOICE_SYSTEM_PROMPT`（"口语化、简短自然、中文、50 字以内…"）在 v2 **无 per-request `system` 可传** → 改用 `ctx.session.hook("context", cb)` 追加（见上）。
- v1 走 `input.client.session.create/prompt`（openapi-fetch 风格 `{path,body,query}`、`body.parts`）；v2 走 `ctx.session`（扁平 `{sessionID, text}`，`create` 无 `{data}` 包装）。
- HTTP 侧 `POST /api/session/:id/prompt` 的 payload 是 `PromptInput`（`{text, files?, agents?, skills?}`），async durable，返回 `SessionInbox.User`（**不是同步回复**）；另有 `/api/session/:id/generate`（瞬态、无历史、无 system）。
- v1 voice 的 `directory` 配置在 v2 失效（见上「会话桥接」）。

### 本机复现/复验（比 CI 快，用 CI 自己的产物）
- CI 的 build-opencode2 产物 artifact `opencode2-android`（android aarch64 v2 二进制 ~192MB，含 `.built-sha`）可在本机直接跑：
  `LD_PRELOAD=~/.opencode/libtagfix.so:~/.opencode/libseccomp_shim.so LD_LIBRARY_PATH=~/.opencode TMPDIR=<tmp> env -u OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD=<pwd> <bin> serve --hostname 127.0.0.1 --port <空闲高位端口>`
  （tagfix 必带否则 `Bad system call`；`env -u` 必须排在所有 `NAME=VALUE` 之前。）
- 判就绪用 `/api/config`（此版 `/api/global/health` 返回空）。
- `tests/v2-plugin/verify.sh`（通用）+ `verify-{uyanip,xcpquery,dingtalk,auth-login}.sh`（专项，参数 = 二进制路径，端口 41844/41845/41846/41847）；脚本里 `LD_PRELOAD=` 是给 CI 用的，**本机跑需换成 tagfix**（可用 `tmp/mk_local_verify*.py` 生成 wrapper，并把 `REPO_ROOT` 写死）。auth-login 本机冒烟用 `tmp/opencode/auth_smoke2.sh`。
- 探针套路：`tmp/{voiceprobe,bridgeprobe,bridgeprobe2,wsprobe,dtprobe}/server.ts`（目录插件 + env 输出 JSON）。

## 4. 其他项目相关
- **opencode-web 前端项目**：工作目录 `project/opencode-web`，push 仓库是 **`kimcrowing/openui`**（不是 opencode-web / opencode-wui，那些 404）。
  - `_pnpm` 装的 `@solidjs/router` 0.15.4 精读结论（改写 prefixed-router.tsx 时用）：包根导出 `createRouter/createBeforeLeave/keepDepth/saveCurrentDepth/notifyIfNotBlocked/BaseRouterProps`，**不导出** `setupNativeEvents/bindEvent/scrollToHash`（需自实现）。
  - `createRouter(config)` config 形如 `{get,set,init?,create?,utils?}`；`init(notify)` 里须自己 addEventListener popstate 并把 `notifyIfNotBlocked(notify, block→boolean)` 的返回注册为 handler；`create(router)` 用 `router.navigatorFactory(router.base)` 拦截同源 `<a>` 点击。
  - `createBranches(routeDefs, props.base||"")` 中 base 为 `""` 时返回**干净绝对路径**（如 `/new-session`，绝不带 `/openui/`）→ 「内部干净路径 + get/set 边界剥/加前缀」方案成立。
  - 官方 `A` 组件 href 是 `useHref` 解析出的干净路径；**点击拦截必须生效**，否则走原生刷新到无前缀 URL → 404。
- **xcpquery（v1 插件，已冻结）WAF 优化留档**：检索慢的根因是每个请求现场用无头 Chromium 重解瑞数 WAF。优化已落地：`_wafCache` TTL 20s→5min、resident WS 复用、412 才重解、**WAF 重解改为按 pathname 签发**（实测瑞数 WP 按路径签发；**绝不可用带 query 的完整签名 URL 导航**，会卡死 30s）、retry sleep 降到 300ms。实测查询 warm 12.04s→4.20s。
  - 测试脚本：`plugins/xcpquery/real_query.mjs`（真实凭据端到端计时，从 opencode.json 的 xcpquery 插件配置读 username/password，不打印）、`bench_header.mjs`（隔离 fullCookieHeader 冷/热/缓存失效）、`deliverable_timed.mjs`（登录+查询+下载全流程）。跑这些跨进程浏览器脚本须 `env LD_PRELOAD=.../libtermux-exec-ld-preload.so` 起（见全局 AGENTS §7 的 SIGTRAP 坑）。
  - 源码曾双份同步：`plugins/xcpquery/`（部署）↔ `project/rspss/xcpquery-plugin/`（源码），改完两边都要同步并 `node --check`；live opencode 需 kill→看门狗重拉才加载新代码。
  - 演进中的坑（勿回退）：曾试「fast-path 直接读浏览器 `localStorage.ACCESS_TOKEN` 跳 SSO」——只有 token 而无 WAF cookie/jar 就绪，反而让下载 412 重解更频繁（22s），**已回退**。结论：session 校验只信 Node 端 TOKEN + `loadSession()`；浏览器 token 由 `browserRequest` 在每次 `doFetch` 里现读（`browserEval(localStorage.ACCESS_TOKEN)`），无需在 `ensureSession` 里预判。
  - 曾误判：`bench_opt.mjs` 的 hot 段 13.39s 是**无 JWT 的 401 把 WP cookie 打没**的测试伪象，非真实流程。
- **v2 插件部署目录实测（2026-09-06，`plugins/xcpquery/` = 本机部署，非仓库内）**：
  - **结论更正**：`list_documents` 偶发的 `client error 400` **不是 WAF 抖动**，而是**真实的无数据栏目**：
    `scxx/wxwj`（无效文件）、`scjd`（复审无效审查决定）对无相应程序/无审查决定的案件返回**真实的 400 空 body**。
    cpqueryRequest 曾把「空 body 400」一律视同 WAF 重试 4 次（重解 WAF 也救不回真实 400）→ 耗尽抛错中断整个列表。当时误判为「WAF 抖动」是偷懒结论，已更正。
  - **修复（core.mjs）**：cpqueryRequest 增加 `opts.emptyOk`——`emptyOk && status===400 && 空 body` 直接按空响应返回（不重试不抛错）；
    getAllDocuments 的分类查询/子目录展开、getScjdTree 根查询都传 `emptyOk:true`；`obtain-init-treenodes`（树初始化前置）顶层失败降级为 warning 继续；分类级 try-catch 记 warnings。
    412/带 HTML 的 400 仍按 WAF 重试，不受影响。
  - **110 v1 的「正常下载」真相**：成功路径（deliverable_timed.mjs）**根本不走 list_documents 递归**，是 login → get_examination_tree → `download_document(rid/ds/wenjiandm)` 直连。
    → 直连下载最稳；list_documents 只用于拿参数，失败也可用 `get_case_summary(发文信息)` 找线索后重试。
  - **实测参数模板（2024106091101 意见陈述书）**：2025-12-31 那份 = `rid=102026037313818, ds=ZJWJ, wenjiandm=100012`；
    2026-05-25 那份 = `rid=102026046383934, ds=ZJWJ, wenjiandm=100012`。`ds` 取值：SQWJ=申请文件 / ZJWJ=中间文件(含意见陈述书) / TZS=通知书。
  - **下载验证**：本机 3 份 PDF 落盘 `/data/data/com.termux/files/usr/tmp/opencode/`（意见陈述书×2 + 第一次审查意见通知书）；
    `意见陈述书_2025-12-31.pdf` md5=`2b7c92519283748b0e043b3a438c4798` 与 110 `first_opinion_2024106091101.pdf` **完全一致**。
  - **参数使用示例已固化**：插件 `README.md`（标准工作流/参数模板/已知坑）+ server.ts 的 `list_documents`/`download_document` description（catalog 已生效）。
  - 调试手法：改完 core.mjs 用独立 node 进程 `env LD_PRELOAD=libtermux-exec-ld-preload.so XCP_DEBUG=1 node dbg_list.mjs` 验证（execute 内插件工具会话可能加载旧代码，结论以独立进程为准）。
