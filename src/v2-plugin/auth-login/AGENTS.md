# auth-login 插件（通用扫码登录框架）专属须知

> 全局/本机通用事实见 `~/.config/opencode/AGENTS.md`；本文件只记本项目（opencode-termux v2 分支）中
> `src/v2-plugin/auth-login/` 的专属内容。这是一个**新增 v2 插件**（非 v1 迁移），由用户需求驱动：
> “扫码登录做成通用 opencode 扩展模块，GitCode 第一个接入，其它网站换适配器即可”。

## 1. 定位与架构

- **目标**：让用户在 opencode 会话/web UI 中扫码登录任意网站，登录态持久化后可跑「可配置活动列表」
  （自动签到/领积分）。
- **通用框架**（与网站无关，全部零依赖）：
  - `qr.js`：纯 JS QR 编码（vendored 自 qrcode-generator/Arase，MIT）。**已实测**：生成 PNG 可被
    在线解码器（api.qrserver.com/read-qr-code）精确还原原文 → 二维码真实可扫描。
  - `png.js`：零依赖 PNG 编码（手写 zlib stored blocks）。
  - `provider-qr.mjs`：把文本渲染成 `storage/<site>/qr-*.png` + ASCII。
  - `core.mjs`：扫码登录状态机 + 后台轮询 + token 持久化（`storage/<site>.json`，参照 uyanip session.json 模式）
    + 活动执行器。
- **站点适配器**：`providers/<site>.mjs`（目前 gitcode / mock）。每个适配器实现 `loginUrl()/pollStatus()/
  headers()/manualToken()` 等；接入新网站 = 新建一个 provider 文件 + 在 opencode.json 的
  `options.sites` 配一个条目，**框架代码零改动**。
- **工具清单（10 个，namespace `auth_login`）**：sites / login / status / token / refresh / logout /
  run_activities / manual_token / render_qr / qr_image_path。
- **二维码在 web UI 呈现的机制（实测确认）**：工具返回 ASCII（任何 UI 直接显示）+ PNG 文件路径；
  agent 用 `read` 工具读 PNG，tool-result 图片会在 opencode 会话中渲染。`auth_login_qr_image_path`
  专门返回路径供 agent read。

## 2. GitCode 适配器现状（重要，勿猜端点）

- GitCode = AtomGit，GitLab 系。**网页端纯扫码（qrcode）接口在 SPA bundle 中已发现的只有微信小程序
  相关**（`/api/v1/user/oauth/login/qrcode/wechat_mini_program` 等，带 `X-Source` 头），**网页端扫码
  端点未确认**。
- 因此 `providers/gitcode.mjs` 采用**双路径/配置驱动**：
  - **方式 A（开箱即用，稳定）**：OAuth 授权码——二维码内容 = GitCode OAuth 授权页 URL
    （`gitcode.com/oauth/authorize`，公开稳定；token 15 天可 refresh）；用户手机扫码→浏览器登录授权→
    redirect 带 code（注意：**本地无 web 服务接收 redirect**，当前形态适合“手填 token/code”，
    与 `auth_login_manual_token`/`exchangeCode` 配合）。
  - **方式 B（待抓包确认）**：`sites.gitcode.qr.enabled=true` + `qr.generate_url`/`qr.check_url`/
    `qr.state_map`/`qr.token_path` 等配置覆盖即可，框架会用配置发请求+解析字段，无需改代码。
- **鉴权头**：REST v5 支持 `Authorization: Bearer` / `PRIVATE-TOKEN`（`api.gitcode.com/api/v5`）。
- 上线前的必做：**用真实抓包确认 GitCode 网页扫码端点后填入配置**，或确认 OAuth 流程用户可接受。

## 3. 验证（CI + 本机）

- CI：`verify.sh`（通用，已加入 auth-login 为第 4 个 shipped 插件）+ `verify-auth-login.sh`（专项，
  断言 10 个 `auth_login_*` 工具 ID；端口 `41847`，sentinel env `AUTH_LOGIN_VERIFY_SENTINEL`）。
- 本机冒烟：`tmp/opencode/auth_smoke2.sh`（用 `~/opencode2/bin/opencode2` + tagfix LD_PRELOAD）——
  **已实测 PASS**：插件 `status:active`、无非 active 插件、10 个工具 ID 齐全。
- 框架端到端（node 直测，无需 opencode）：`tmp/opencode/auth_test.mjs`（mock provider：生成二维码→
  轮询确认→拿 token→跑活动→持久化→logout）——**已实测 PASS**，且 mock 二维码 PNG 可被在线解码还原。

## 4. 关键坑/注意

- **storage/ 目录含登录 token，已在 .gitignore 忽略**（`src/v2-plugin/auth-login/storage/`），禁止提交。
- mock provider 仅用于自测，生产配置不要启用（或删除该文件）。
- `gitcode.mjs` 的 `pollStatus` 在 OAuth 模式下**恒返回 pending**（OAuth 无轮询），登录完成靠
  `manual_token` 注入，勿期待轮询自动确认。
- 目录插件是 ESM，**禁止 `require`**（沿用三插件契约）；本插件只用 `import`。