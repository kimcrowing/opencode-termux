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
  - `core.mjs`：扫码登录状态机 + 后台轮询 + token 持久化
    （**账号池**：`storage/<site>/accounts/<user>.json`，每账户一文件，参照 uyanip session.json 模式；
    旧版单文件 `storage/<site>.json` 首次访问自动迁移）+ 活动执行器。
- **站点适配器**：`providers/<site>.mjs`（目前 gitcode / mock / **codebuddy**）。每个适配器实现 `generateQr()/pollStatus()/
  headers()/manualToken()` 等（文本二维码也可用 `loginUrl()`）；接入新网站 = 新建一个 provider 文件 +
  在 opencode.json 的 `options.sites` 配一个条目，**框架代码零改动**。
- **工具清单（13 个，namespace `auth_login`）**：sites / login / accounts / status / token / refresh /
  logout / run_activities / manual_token / daily / **import_accounts** / render_qr / qr_image_path。
- **账号池（多账户/站 + 两种扫码场景，用户需求驱动）**：
  - `auth_login_login` 参数 `mode`：`add`（默认）= **扫码添加**账户（临时槽 `_new_<ts>` 扫码，确认后以
    `user.username` 落盘入池，如 `accounts/kimcrowing.json`）；`update` = **扫码更新**指定 `account`
    （重新扫码覆盖其 token 续期，不新增账户；已登录也强制重新出码）。
  - 账号池操作：`accounts`（列池）、`status`/`token`/`refresh`/`logout` 带可选 `account`（缺省=池首个或全站）、
    `manual_token` 可指定目标账户（缺省池首个），`run_activities` 带可选 `account`（缺省**遍历全部账户**）。
  - 内存 key = `siteId::accountId`；add 确认后从临时 key 迁移到 `siteId::username` 并删旧文件。
  - 迁移兼容：旧 `storage/<site>.json` 首次 `accountIds()` 时自动迁为 `accounts/<username|default>.json` 并删旧文件。
  - 活动执行带 20s 单活动超时保护（Promise.race），单活动挂死不拖跨整批/整池。
  - **每日自动任务（2026-09-07 新增）**：`daily` 工具 + 插件自动调度——serve 启动后对配置了 activities 的站点
    每 ~30min 检查一次日期变化，每天每账户最多执行一次（`storage/<site>/daily-meta.json` 记
    perAccount 日期，幂等；`daily:false` 关闭调度，`dailyIntervalMin` 调间隔）。
    重启丢失的当日任务在下次启动时自动补跑。执行前先 `refresh()` 滚动 token（GitCode 续期 24h，
    解决 access_token「次日过期」问题；refresh 失败该账户跳过并提示扫码更新）。<br>
    **refresh 端点（2026-09-07 JS bundle 实证，勿猜改）**：
    `POST https://web-api.gitcode.com/uc/api/v1/user/token/refresh?__s=aihub`
    body（**form-urlencoded**，非 JSON）`refresh_token=...`；头 `Authorization: Bearer <旧access_token>` +
    `content-type: application/x-www-form-urlencoded` + app headers→ 200 扁平 `{access_token, refresh_token}`，
    新 token 续期 24h，旧 token 宽限期内不立即失效；refresh_token 很长命可复用。
- **二维码在 web UI 呈现的机制（实测确认，含 2026-09-07 补充更正）**：工具返回 ASCII（任何 UI 直接显示）+ PNG 文件路径。
  呈现首选 **markdown 引用本地路径**：`![](<绝对路径>)`——由 web UI 的 markdown 渲染层直读本地文件，**不依赖模型视觉能力**，
  实测 storage 下绝对路径（`…/auth-login/storage/codebuddy/qr-*.png`）与复制到 `/data/data/com.termux/files/usr/tmp/opencode/`
  的副本都能正常显示（2026-09-07 用户确认「两个都显示正常」）。
  **坑**：`read` 工具读 PNG 依赖当前模型的图片输入能力——不支持图片输入的模型会报
  `Cannot read … (this model does not support image input)`，不能作为二维码呈现手段；此时直接用 markdown 引用路径。
  `auth_login_qr_image_path` 返回路径供 agent 引用/read。

## 2. GitCode 适配器现状（重要，全部端点已抓包+JS bundle 实证，勿猜/勿改）

- **真实 API 域：`https://web-api.gitcode.com`**（不是 gitcode.com！），所有请求统一带 query
  `__s=aihub`。此前 curl 401 的根因 = 域名错 + `X-Source: web`（应为 `toolbar_login`）+ 缺 `__s` 全错。
- 登录 = 微信小程序扫码（**非 OAuth web 扫码**），三端点全实证：
  1. 生成：`POST /uc/api/v1/qrcode/wechat_mini_program?__s=aihub`，body `{}`，头带
     `X-Source: toolbar_login` → `{qrcode:"data:image/png;base64,...", scene_id}`。
     **qrcode 是服务端生成的微信小程序码 PNG，本地 QR 编码器无法重编码** → provider `generateQr()`
     返回 `{base64}`，core.mjs `startLogin` 检测对象返回后直接落盘 `storage/<site>/qr-<ts>.png`
     （唯一时间戳文件名，防 web UI 浏览器缓存旧码）。
  2. 轮询：`GET /uc/api/v1/qrcode/wechat_mini_program?scene_id=X&__s=aihub` →
     `{"status":"WAITING"|"SCAN"|"LOGIN"|"TIMEOUT"}`。
  3. login 换 token：`POST /uc/api/v1/user/oauth/login/qrcode/wechat_mini_program?scene_id=X&__s=aihub`
     body `{}` 头带 `X-Source: toolbar_login`。未扫码 → 400 `{error_code:1000,error_message:"二维码已失效"}`
     （业务错误非 401）；扫码后 → 200，响应体扁平 `{access_token, refresh_token}`（JS 源码
     `O?.access_token` 实证）。页面行为：轮询到 SCAN/LOGIN 后自动调 login。
- 状态机：`WAITING→SCAN→LOGIN→TIMEOUT`；**用户必须在小程序里点「确认登录」**，且 SCAN/LOGIN 后
  若不调 login 换 token 会 TIMEOUT。二维码有效期约 2 分钟（provider 本地兜底 180s 过期）。
- 轮询/生成/活动的通用 app headers（全实证）：`X-Platform:web X-OS-Version:Unknown X-Device-ID:unknown
  X-App-Channel:gitcode-fe X-Device-Type:Windows X-App-Version:0 X-Network-Type:4g` + Referer
  `https://ai.gitcode.com/`；生成与 login 额外带 `X-Source: toolbar_login`。
- 签到/积分（`Authorization: Bearer <access_token>` + app headers，全实证）：
  - 签到：`POST /uc/api/v1/task/sign-in?__s=aihub` body `{}` → 200 成功；400
    `"今日已签到，明天记得来签到哦。"`（次日再签）。
  - 签到状态：`GET /uc/api/v1/task/v2/sign_status?__s=aihub` →
    `{award_index, is_sign_in, scores:[7,7,14,7,7,7,21], growths:[...]}`（7 天循环积分序列）。
  - 待领列表：`GET /uc/api/v1/task/unclaimed?__s=aihub` → 无待领时 200 **空 body**（不要当异常）。
  - 领取：`POST /uc/api/v1/task/{id}/points?__s=aihub`（id 取 unclaimed 列表，静态 JS 定义实证）。
  - 任务详情：`GET /uc/api/v1/task/{id}?__s=aihub`。
- 活动配置（opencode.json 插件 options.sites.gitcode.activities）：
  `[{name:"每日签到",type:"sign_in"},{name:"领取待领积分",type:"claim_all"}]`，走 provider
  `executeActivity()` 专用逻辑；其他 type 回退通用请求。
- **账号池部署配置示例（多账户场景）**：options.sites 的 activities 是**站点级**（同一站点全部账户共享同一套
  活动，`run_activities` 缺省 account 时遍历账号池每个账户执行）：
  ```jsonc
  "plugins": [{ "package": "…/src/v2-plugin/auth-login", "options": {
    "sites": { "gitcode": { "name": "GitCode", "activities": [
      { "name": "每日签到",       "type": "sign_in" },
      { "name": "领取待领积分",   "type": "claim_all" },
      { "name": "下载模型文件",   "type": "download_ai_file" },
      { "name": "每日Star",       "type": "daily_star" },
      { "name": "查看热门",       "type": "daily_view" },
      { "name": "每日分享",       "type": "daily_invite" }
    ]}}
  }}]
  ```
  加第二/更多账户：`auth_login_login {site:"gitcode", mode:"add"}`（每次扫码确认一个新账户入池；
  token 过期或个人需要续期时 `mode:"update", account:"<username>"` 重扫覆盖，不新增）。
- **成长中心任务实证（2026-09-07 全部抓包+页面点击实测，已固化进 executeActivity 新活动类型）**：
  任务机制 = **行为触发 + 服务端结算**：做真实动作/上报 → compile_time 记录 → status 变 0（待领取）
  → `POST /uc/api/v1/task/{id}/points` 领分；部分任务（关注CANN/Star CANN/访问CANN）结算后自动发放
  （从未完成列表消失即完成，无需领取）。
  - `daily_star`：`POST /api/v2/projects/{repoId}/star` body `{"repoId":10708627}`（cann/cannbot），
    200 `{"star_count":9}`，重复幂等。
  - `daily_view`（查看热门）：点首页推荐卡片 → 前端上报
    `POST /api/v1/report?event_id=PC_PageClick` body
    `{"repo_id":9709354,"module_name":"推荐_今日热门","page":1,"repo_index":0,"Project_card_star":"card"}`。
  - `daily_invite`（每日分享）：`/setting/points?type=invite` 点「复制邀请链接」→
    `POST /api/v1/report?event_id=page_click` body `{"button_name":"常规邀请_复制邀请链接_PC"}`。
  - `daily_update`（每日更新项目）：`POST /api/v2/projects/{ns}/repository/commits`（GitLab 风格），
    body 必须带 **`author_name` + `author_email` + `actions[].encoding:"base64"`（content 为 base64）**，
    否则报「username参数错误」/「actions.encoding: param is missing」。push 后 compile 立即记录。
    **坑（2026-09-07 部署实测，已修复）**：`action:"create"` 在文件已存在时报错（每日第二次起必挂，
    实测当天调度器 daily_update 静默失败、xcpquery 无新 commit）。已改为 probe
    `GET /api/v2/projects/{ns}/repository/files/{path}?ref=` 判断 + **create/update 双重 fallback**：
    create 报已存在→update（内容每次带新日期→总能产生新 commit），update 报不存在→create。
    注意：GitCode 该文件探接口实测**探不到**（probe 返回非 200 → 误判不存在先 create 再 fallback，
    依赖 fallback 兜底，probe 只是减少一次失败请求）；修复后实测 update 成功（commit `6dbd7d8b`）。
  - **★ author_email 校验规则（2026-09-07 多账号实测更正，勿再猜）**：GitCode commits API 校验
    `author_email` **必须等于当前登录账号已绑定的邮箱**——用其他任何合法邮箱（`test@test.com`、空串、
    `gcw_TojUaPz9@petalmail.com` 等全试过）一律 400 `error_code:1001 "email参数错误"`。
    kimcrowing 成功 commit 的 email=`kim_mail@petalmail.com`（其绑定邮箱）；微信小程序新扫码账号
    （如 `gcw_TojUaPz9`）**默认无绑定邮箱** → daily_update 必然 400，需先网页绑定邮箱。
    provider `updateProject` 的 email 优先级：**账号文件 `user.email` > 活动 `def.email` > 默认
    `kim_mail@petalmail.com`**；每个账号在自己的 `storage/<site>/accounts/<user>.json` 加 `user.email`
    字段即可（框架容忍 user 扩展字段）。绑定邮箱后可顺手领「添加电子邮箱」任务积分。
  - **创建仓库端点（实测）**：`POST /api/v2/projects?__s=aihub`，body `{"name","path","visibility":"private",
    "description"}`（GitLab 风格）→ 200 返回 project（id/name_with_namespace）。给新账号建仓后 daily_update
    目标用 `"{username}/<repo>"` 模板（opencode.json 里 repo 已改为 `{username}/xcpquery`，provider 替换
    username 后 `/`→`%2F`）。
  - **任务结算时序实测（新账号）**：commit push 后**立即结算**（compile_time=push 时刻，无需等 1h），
    「每日更新项目1次/更新你的项目/添加新建项目文件」status 变 0 可领；同一天同内容 update 不产生新 commit
    （内容按天递增，跨天自然有新 diff）。每日任务积分领过返回 1002「已超过可领取次数」= 当天次数已用完，
    属正常幂等。
  - `cann_follow`：`POST /uc/api/v1/follow` body `{"followedUsername":"cann","followType":1}` → +200 自动发放。
  - `cann_star`：同 daily_star（repoId=10708627）→ +50 自动发放。
  - `download_ai_file`：模型文件行点 resolve 下载 → `POST /api/v1/report?event_id=aihub_model_page_file_download`
    body `{"aihub_model_name":"Qwen2.5-Omni-7B","aihub_model_path":"hf_mirrors/Qwen/Qwen2.5-Omni-7B",
    "aihub_author_name":"xxm","aihub_file_name":".gitattributes"}`（+ GET `raw.gitcode.com/.../blobs/.../file`）。
  - `complete_profile`（+20）：`POST /uc/api/v1/user/setting/save`，profile.description ≥10 字即完成。
  - `enable_readme`（+10）：同 save 接口，profile 填 `readme_repo:"xcpquery"|"kimcrowing/xcpquery"`
    （ns 格式 update_count=3）+ `readme_file_path:"README.md"` + `readme_branch:"main"` + `readme_switch:1`。
  - 全量任务：`GET /uc/api/v1/task/v2/uncompleted?limit=100`（0=待领取/1=已领/2=未完成）；
    任务列表：`GET /uc/api/v1/task?page=1&per_page=50&type=0|1`；当日统计：
    `GET /uc/api/v1/task/unclaimed/tips_pc`、`/task/total-unclaimed-rewards`、`/score/will_expire`。
  - **1小时内结算**：cann-star(104)/访问CANN(96)/模型任务等 completed 后需约 1h 才 status=0 可领。
- 登录态持久化：`storage/gitcode/accounts/kimcrowing.json`（账号池格式 `{token,cookies,headers,user,savedAt}`，
  已由旧版 `storage/gitcode.json` 自动迁移；目录已被 .gitignore 忽略，禁止提交）；
  本机已注入抓包实测登录态（username=kimcrowing，access_token JWT 次日过期）。
- **鉴权头**：Bearer + app headers（见上），不是 `api.gitcode.com/api/v5`（那是 REST 旧域，登录活动走 web-api）。

## 3. 验证（CI + 本机）

- CI：`verify.sh`（通用，已加入 auth-login 为第 4 个 shipped 插件）+ `verify-auth-login.sh`（专项，
  断言 13 个 `auth_login_*` 工具 ID（含 `auth_login_daily` / `auth_login_import_accounts`）；端口 `41847`，
  sentinel env `AUTH_LOGIN_VERIFY_SENTINEL`）。
- 本机冒烟：`tmp/opencode/auth_smoke2.sh`（用 `~/opencode2/bin/opencode2` + tagfix LD_PRELOAD）——
  **已实测 PASS**：插件 `status:active`、无非 active 插件、13 个工具 ID 齐全。
- 框架端到端（node 直测，无需 opencode）：`tmp/opencode/auth_test.mjs`（mock provider：生成二维码→
  轮询确认→拿 token→跑活动→持久化→logout）——**已实测 PASS**，且 mock 二维码 PNG 可被在线解码还原。
- **账号池端到端（2026-09-07 新增，`tmp/opencode/auth_pool_test.mjs`）——已实测 PASS**：mock provider 验证
  add×2 入池（user-1/user-2）→ update user-1 续期（token 变、不新增）→ run_activities 全池/单账户 →
  getStatus 全池/单账户 → logout 单账户/全清 → manual_token 注入 → 旧版单文件迁移。
- **每日任务引擎 + refresh（2026-09-07 新增，全部 PASS）**：
  `auth_daily_test.mjs`（mock：幂等/force/单账户/无活动配置/meta 落盘/**执行前自动 refresh**/refresh 失败→跳过需扫码更新）
  与 `gc_daily_e2e.mjs`（真实 gitcode：refresh 续期 24h + 签到"今日已签到" + claim_all"无待领"，存储 token 已更新）。
- GitCode 真端点端到端（2026-09-07，全部 PASS）：`gc_plugin_test.mjs`（manualToken 解码 user=kimcrowing +
  signIn 返回 400"今日已签到" + claimAll 无待领）、`gc_qr_test2.mjs`（generateQr 生成合法 PNG 小程序码 +
  pollStatus=WAITING）、`gc_core_e2e.mjs`（core.startLogin 直供 PNG 落盘 + runActivities 逐项 ok + logout）。

## 4. 关键坑/注意

- **storage/ 目录含登录 token，已在 .gitignore 忽略**（`src/v2-plugin/auth-login/storage/`），禁止提交。
- mock provider 仅用于自测，生产配置不要启用（或删除该文件）。
- **微信小程序码不能本地重编码**：core.startLogin 对 `generateQr()` 返回**对象** `{base64|path, ascii}` 时
  直供服务端 PNG 落盘；返回字符串才走本地 QR 渲染。GitCode 的 `generateQr()` 必须返回 `{base64}`。
- 目录插件是 ESM，**禁止 `require`**（沿用三插件契约）；本插件只用 `import`。

## 5. CodeBuddy 适配器 + credential 同步（方案 A，2026-09-07 全实测）

**接入背景**：用户需求——CodeBuddy 登录态让「模型加载（codebuddy/hy3）+ 补丁内置自动签到 + auth-login 每日积分任务」
共用同一 token。方案 A：auth-login 登录/刷新成功后把 `{access, refresh}` 写进 opencode credential 表
（integration_id=`codebuddy`，methodID=`ioa`）；opencode 内置 codebuddy provider 的 integration
`connection.active()` 每次现查 db（上游源码实证无缓存）→ **直写即生效，无需重启**。

### 端点实证（全部 2026-09-07 真机实测，勿猜改）
- **IOA 登录（copilot.tencent.com）**：`POST /v2/plugin/auth/state?platform=VSCode&ioa=1`（noAuth 头、无 body）
  → `{code:0, data:{state, authUrl}}`；`GET /v2/plugin/auth/token?state=` 未确认返回 code:11217。
- **★ refresh 端点实测更正（2026-09-07，推翻了补丁 ioa.ts 的形状）**：
  `POST https://copilot.tencent.com/v2/plugin/auth/token/refresh` 必须带 **`X-Refresh-Token: <refreshToken>` 头**
  （可同时带 `Authorization: Bearer <RT>`，但**纯 Bearer 无 X-Refresh-Token 必 400** `{"code":10001,"msg":"refreshToken is empty"}`；
  body/query 传 refreshToken/refresh_token 也全部实测 400）。无 body。
  响应 `{code:0, data:{accessToken, refreshToken(轮换!), expiresIn(秒=60天), tokenType, scope, ...}}`：
  **refreshToken 每次轮换**，必须取新值落盘，否则下次刷新用旧 RT 被拒。
  另：补丁 ioa.ts 的 `ioaRefreshToken` 与公开仓库 cainiao1992/dsh-codebuddy-auth 的实现都是纯 Bearer（均未实测），
  以本次 `X-Refresh-Token` 实测为准，勿再照抄纯 Bearer 形状。
- **成长/积分（copilot.tencent.com，纯 Bearer + fetchRetry 兜 APISIX 偶发 401）**：
  `GET /v2/activity/growth/tasks` → `{code:0, data:{tasks:[{task_code, accept_status, progress, reward_credit}]}}`
  （accept_status=completed 才可领）；`POST /activity/growth/tasks/{task_code}/claim`（无 /v2 前缀）未完成 400
  「task not completed」；`GET /activity/growth/lottery/chances` → `{balance}`；`POST /activity/growth/lottery/draw`
  body `{client_token: uuid}`；`GET /v2/activity/growth/profile`。
- **礼包（www.codebuddy.cn，Bearer + X-Domain + X-User-Id(uid=JWT sub)）**：
  `POST /billing/meter/claim-gift` → `{code:10001,"每人限领一次…"}` = 已领（幂等，provider 按 ok 处理）；
  `GET /billing/meter/check-gift-claimed` 实测 404 不存在，勿用。

### credential 同步（credential-sync.mjs + provider.syncCredentialSafe）
- **双库写入**：`~/.local/share/opencode/opencode.db` 与 `opencode-.db` 都写（dbPaths() 探测既存库）；
  driver 自适应 node:sqlite → bun:sqlite（**已实测插件宿主可用**，import_accounts 首次调用即成功读表）；
  都不可用才降级「仅 storage」并警告。
- **makeActive 语义**：`true`（登录成功/手动注入/import 后同步）→ 同 integration 旧行全部 active=0、本行 active=1；
  `false`（每日 refresh）→ **只滚动 token**：UPDATE 分支保持既有 active（主库 active 账号不会被每日轮询拨乱），
  但 **INSERT 分支（该库原本无此行）active 写 0**——实测 opencode.db（--service 冗余库，原 credential 空）
  的 3 行全 inactive，而主库 opencode-.db 的 18623190160 保持 active=1。**此差异无实际影响**（--service 旧
  serve 本来没有 codebuddy 连接；import_accounts 去重取 active 优先，主库数据为准）。
- **value JSON 形状**：`{"type":"oauth","methodID":"ioa","refresh","access","expires"(ms),"metadata":{"uid"}}`；
  id 用 `cred_` + 上游同构时间戳编码。

### import_accounts（第 13 个工具，server.ts）
- `auth_login_import_accounts {site:"codebuddy"}`：读 credential 表（listOpencodeCredentials，双库去重
  取 active/新 expires）→ 每账号 provider.manualToken 构造会话 → persistSession 入 auth-login 账号池。
  **不写回 credential 表**（import 只是把已有凭据导入池，防止循环写）。
- 实测导入本机 credential 表 3 个 codebuddy 账号：`18623190160`（opencode active，昵称 Kim）、
  `15123837998`（同恒源-秦京）、`13983704720`（lit）——storage/codebuddy/accounts/<手机号>.json 三文件落盘。

### daily 多账户轮询实测（2026-09-07）
- `auth_login_daily {site:"codebuddy", force:true}` 对 3 账号**逐个**：真实 IOA refresh（X-Refresh-Token 头，
  token 轮换 60 天续期，3 账号 3 秒内依次完成=轮询节奏正常）→ 3 个活动打真实端点：
  成长任务领奖（tasks code:0，15/16/16 个任务无 completed 可领）、幸运抽奖（chances balance:0「今日无抽奖次数」）、
  新手礼包（claim-gift 10001 幂等「已领取过」）——**3 账号全部 executed、0 skipped**。
- **幂等**：不 force 再跑 → 3 账号全部「今日已完成」skip（daily-meta.json 落盘生效）。
- 刷新后 credential 表同步验证：3 行 token 均换新（exp=now+60 天）、无重复行、18623190160 保持 active=1。