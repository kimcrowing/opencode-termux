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
  - 待领列表：**`GET /uc/api/v1/task/unclaimed?__s=aihub` 实测恒返回 200 空 body（含 status=0 可领任务
    也漏报），不可用于自动领取**——claim_all 曾依赖它导致积分从不自动领（2026-09-08 实证修复）。
    真实待领以 **`GET /uc/api/v1/task/v2/uncompleted?limit=100` 的 `status==0`** 为准：
    响应 `{starter_task,daily_task,normal_task}` 三数组（status: 0=待领取/1=已领/2=未完成；
    同一 task_id 会跨数组重复），claimAll 遍历三数组按 `task_id` 去重后逐个
    `POST /uc/api/v1/task/{id}/points` 领取（2026-09-08 端到端实测：kimcrowing 4 个滞留任务一次领全）。
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
  - **★ user.email 被 refresh 冲掉（2026-09-08 实测修复，commit 8f0b75f）**：`refresh()` 重建 user 对象
    `{username: payload.sub, payload}`（**不含自定义 email**）；core 的 ensureDaily 刷新后
    `saveSession({token,cookies,headers,user,savedAt})` 全量覆盖账号文件 → 昨夜写入的 `user.email`
    今晨 refresh 后被冲掉（文件只剩 username/payload）→ 当日 daily_update 报 400 `email参数错误`。
    修复：provider refresh 返回的 user 沿用旧值 `email: (s.user && s.user.email) || ""`。
    **教训**：任何会重构 user 对象并落盘的路径都要保留扩展字段（user 是框架容忍的扩展承载位）；
    daily_update 前若怀疑 email 丢失，先查账号文件 `user.email`。
  - **行为上报端点（2026-09-08 实证）**：`POST /api/v1/report?event_id=<event>`（body 任意 JSON、query
    带 `__s=aihub`）是 GitCode 行为埋点统一入口——`daily_view`(PC_PageClick)、`daily_invite`(page_click)、
    `download_ai_file`(aihub_model_page_file_download) 都走它。`download_ai_file` 上报后**即时结算**
    （任务 85 status=0，立即能领，无需等 1h）。bundle 里封装见
    `chunks/*.js` 的 `baseService.request({url:"/api/v1/report",...})`；event_id 为调用点字符串常量，
    压缩代码不可直接枚举，需从页面 JS 行为或抓包获取。
  - **新账号任务补齐实操（2026-09-08 全实测，gcw_TojUaPz9）**：
    - cann_star(104) → `{"star_count":20}`；cann_follow(94) → 200（自动发放 50/200）。
    - 任务 18「README 介绍」：给仓库 commit 一个 README.md → **即时结算**（无需个人主页操作）。
    - 任务 25「启用个人README」：enable_readme（readme_repo/readme_file_path/readme_branch/readme_switch）→ 即时结算。
    - 任务 6「创建开源项目」：**建仓时 `visibility:"public"` 才有效**（POST 建仓参数实证生效；
      PUT /api/v2/projects/{id} 更新 visibility **无效**——补全必填字段 PUT 后 GET 仍 private）；
      `license_template:"mit"` 参数被接受但 **LICENSE 文件不会自动生成**（repository/tree 只有 README.md，
      license 元数据 None）→ 需手动 commits API 补 LICENSE；即使补了 LICENSE，任务 6 仍 status=2（待复查，
      可能要求建仓时初始化 LICENSE 或 1h 结算）。
    - **commits API 一次只支持单个 action**：`actions:[{create LICENSE},{create README}]` 两个 → 400
      `PARAMETER_ERROR 参数错误`；分开单 action 各自成功。
    - 分支名：xcpquery 默认 `main`（建仓历史默认），autobot-tools 新建默认 `master`——commit 前先查
      repository/tree 或 GET project 的 default_branch。
    - 任务 15/70（完善资料/个性化设置）：save 接口顶层 `nickname` 会真实生效（Lit→Lit-bot），但
      `update_count` 只统计 profile 内字段（只改 nickname 时 0 也属正常）；**未即时结算**——guide 要求
      「昵称+简介+头像」，缺头像可能不结算（头像上传端点未定位），也可能同属 1h 延迟结算。
    - 任务 16「创建访问令牌」：`/api/v2/personal_access_tokens`、`/api/v2/user/*` 全部 404；真实创建页在
      aihub 端 `/dashboard/token-classic/create`（未登录抓不到创建 API，待补）。
  - **aihub（ai.gitcode.com）登录态（2026-09-08 实测）**：与 gitcode.com 前端**不同鉴权体系**——aihub 把
    token 存 **localStorage**（key: access_token/refresh_token/userInfo），登录成功经
    `window.parent.postMessage({access_token, refresh_token})` 回调写入；模型页打开时若 localStorage 校验
    不过会被**清空**（EMPTY）。**无头浏览器注入 localStorage 后 reload 无效、模拟 postMessage 也无效**——
    需要真实登录流转（扫码/账号密码）。因此依赖 aihub 登录的任务（84 模型体验/86 Space/87 Notebook/
    105 CANN 课程）暂不可自动完成；gitcode.com 端的行为任务（2/3/4/96 等）用**无头 chromium + Cookie
    access_token** 打开目标页面可触发前端上报（CDP 流程见全局 AGENTS §2b，execute/sync 脚本**必须显式
    `return`**，无 return 表达式全返回 None）。
  - **行为类任务触发实测（2026-09-08）**：archive 下载 `GET https://gitcode.com/{ns}/-/archive/{branch}.zip`
    （带 Cookie access_token）→ HTTP 200（任务 4 下载项目触发）；打开 blob 页 `/{ns}/-/blob/{branch}/xxx.md`
    → 200（任务 3 查看代码）；`/?p=seo` 搜索页提交关键词 → SSR 页面（任务 2）。**结算需 1h**（与 96 一致，
    复查方式：1h 后查 uncompleted status==0）。
  - **任务 85 下载模型文件（2026-09-08）**：仅 report 上报（不 GET raw 文件）也即时结算 status=0。
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
## 6. 京东适配器（jd）实证（2026-09-08 PC 登录流；2026-09-09 签到链路全打通更正）

> ⚠️ **2026-09-09 重大更正（实测推翻下方部分旧结论）**：
> 下方「signBeanAct S109 软拒绝」「h5st 4.x」「路线未定」等结论**已被 2026-09-09 实测推翻**，
> 以本节末尾「★ 天天领豆 2026 真实接口 + h5st 5.3（kr 模式）全打通」为准。
> 旧 signBeanAct 接口**已迁移**（现返回 402「活动现在挤不进去呀」= 活动挪到别处，无 cookie 也 402）；
> 2026 年天天领豆真实接口 = `bff_rightsCenter_interaction`（beanDailySign）；
> 正确签名 = **h5st 5.3（kr 模式 krh5st，js_security_v3 + isvObfuscator tk06 token）**，4.x 已被拒（1711002）。

### 登录流（PC 码，京东 App 可扫）——已端到端成功
- 二维码：`qr.m.jd.com/show?appid=133&size=147&t=<ms>`（PNG 直接返回，京东 App 扫）；
  轮询 `qr.m.jd.com/check` JSONP（201未扫/202已扫待确认/200→ticket/203过期）。
- **★ step4 成功参数（绕风控 1100 的关键，勿再用旧参数）**：
  `GET passport.jd.com/uc/qrCodeTicketValidation?t=<ticket>&ReturnUrl=https%3A%2F%2Fwww.jd.com%2F&callback=jsonp`
  头：`Referer: https://union.jd.com/index`；`Cookie:` **只带 `wlfstk_smdl=<token>`**（不要带全量会话 cookie！）。
  响应是 **JSONP**（`jsonp({...})`）；Set-Cookie 为 **PC 端 cookie（thor 体系，非 pt_key/pt_pin）**：
  thor/pin=<用户名>/unick=<昵称>/light_key/flash/TrackID/logining=1/_pst/pinId/_tp/DeviceSeq 等。
  ⚠️ **更正（2026-09-09 实测）**：thor 实际有效期**远短于 Cookie 头标注的 ~1 年**——09-08 22:33:07
  成功保存的 thor（288 字符，含 thor/pin/unick 等 16 cookie）在 **09-09 09:00 已被服务端拒绝**
  （signBeanAct 402「挤不进去」/petName 302/bean.jd.com 重定向登录页 = 三重印证无有效 cookie）。
  实测寿命约 **10.5h**。京东无 refresh()，thor 失效只能重新扫码（update 模式）续期。
- 旧参数（无 ReturnUrl/callback、Referer=passport.uc.login、带全量 cookie）→ **riskCode:1100**
  （要求 aq.jd.com 安全验证）且零登录 cookie = 死路。已实测废弃。
- ⚠️ **新事实（2026-09-09 实测，推翻"修复参数必成功"的隐含假设）**：09-09 用上述 step4 成功参数
  重扫（update 模式续期），**仍返回 riskCode:1100**（lastError=`风控拦截 riskCode:1100`，url 指向
  aq.jd.com 安全验证页）——参数正确不等于一定过风控。**真实无头 chromium 页面内扫码同样被 1100**
  （页面跳转 aq.jd.com/certified/index...&resultCode=1100），排除了设备指纹/IP 因素。
- ★ **1100 根因结论（2026-09-09 实测定性，勿再猜）**：连带真实浏览器都跳 aq.jd.com = **账号级安全标记**
  （aq 页面原文「您的账号存在安全风险，暂无法在京东网页端使用。请使用该账号登录【京东商城 APP】
  完成安全验证」）。node fetch 与 chromium 两次落地的风控参数 `p=6e758c4f2920ca0d` **完全一致** →
  与设备指纹/IP/UA 无关，**只认账号**。触发时机：09-08 成功登录后到 09-09 之间被标记（可能因
  多设备/自动化环境频繁登录）。**解除途径只有一条：用京东 APP 登录该账号完成安全验证**（网页端
  无任何绕过手段）。验证解除后再试 PC 扫码。aq.jd.com 页面仅含隐藏 eid/fp 两个 input + 提示文案，
  无滑块/短信通道可走。
- ✅ **风控解除 + 新鲜 thor 落库（2026-09-09 端到端确认）**：用户在【京东商城 APP】完成安全验证后，
  用真实浏览器（Windows Edge, 远程 IP 222.212.211.66）访问 www.jd.com 成功——请求头 cookie 含
  **完整新鲜 thor 登录态**（thor 288 字符 + pin=loon520 + unick=Kimcrowing + flash/light_key/pinId/
  logining/_pst/_tp/ceshi3.com 等 26 cookie）。已用 `auth_login_manual_token` 注入账号池
  `storage/jd/accounts/loon520.json`（savedAt=2026-09-09 09:55:43）。
  **验证（本机 node probe）**：petName 返回 HTTP 200 + 用户数据（头像 URL `6c6f6f6e...` =
  uid「loon5201582330687253」hex 编码）✅ 服务端接受新 thor；bean.jd.com 返回正常 HTML ✅。
  **注意**：manualToken 仅认 pt_pin 会把 user 解析成「jd」，需手动修正账号文件 user 字段
  （`{username:"loon520", nick_name:"Kimcrowing"}`）。
- **移动端流（plogin.m.jd.com/cgi-bin/m/tmauth）已废弃**：其二维码京东 App 扫码提示
  「暂无可用打开方式」（openapp.jdmobile:// 深链打不开），只适合手机浏览器扫；PC 码才是 App 标准登录。
- 登录态保存 = s.cookies 存**全量 PC cookie 字典**；user.username=`pin`、nick_name=`unick`；
  cookieType=`pc_thor`。京东无 token 刷新 → 无 refresh()，失效靠重新扫码（update 模式）。

### 【历史记录·已被 2026-09-09 实测推翻】signBeanAct S109「当前签到人数较多」= 旧结论，勿再参考
- 旧结论（2026-09-08）：无 cookie → 402「活动现在挤不进去呀」；有 thor → code:0+S109，判断为「风控软拒绝」。
- **推翻点**：2026-09-09 实测 **signBeanAct 已不是天天领豆的当前接口**（活动迁移，旧入口统一回 402
  「挤不进去」占位，无 cookie 也 402）；当前接口 = `bff_rightsCenter_interaction`（见下节）。
  当时「带签名 4.x 仍 S109」的观察实际是 h5st 4.x 不被接受 + 接口已迁移的混合效应。
- 一条仍然成立：光有 cookie 不够，api.m.jd.com 需要有效 h5st（**5.3 版本**，4.x 必 1711002）。
- 用户信息接口现状（未变）：`wq.jd.com/user/info/QueryJDUserInfo` 403 nginx（WAF 拦 thor）；
  `passport.jd.com/.../getUserInfoForMiniJd.action` 302。均未通（不影响签到链路）。

### ★ 天天领豆 2026 真实接口 + h5st 5.3（kr 模式）全打通（2026-09-09 端到端实测）
**链路已全通**：krh5st 生成 h5st 5.3 → thor PC cookie → `bff_rightsCenter_interaction` → 业务层响应
（真实返回 `1714001 请稍后再试`，签名/参数/登录全部被接受；**但 10:12 活动时段内实测仍 1714001**，
判断内置 assignmentId `VdbAAQEQ4t6u7ZommctabgaobfW` 已换期失效，需动态获取新 assignmentId——
见下节「PC 京豆接口+1714001 更正」）。

#### 2026 年天天领豆标准请求（抓自 jd_signbeanact_.js 20260608 实际发包）
```
POST http://api.m.jd.com/client.action?functionId=bff_rightsCenter_interaction
form: functionId=bff_rightsCenter_interaction
      appid=signed_wh5
      body={"scene":"commonDoInteractiveAssignment","activityCode":"beanDailySign",
            "businessScenario":"jingDouCenter","commonScene":"secKillChannel",
            "assignmentId":"VdbAAQEQ4t6u7ZommctabgaobfW"}
      client=apple  clientVersion=11.1.2  t=<ms>  h5st=<5.3>
```
- 老 signBeanAct（appid=ld|signed_wh5_ihub）**已迁移废弃**：返回 402「活动现在挤不进去呀」（无 cookie 同）；
  勿再作为目标接口。
- **assignmentId 目前取脚本内置值**，10:00 后若失败需改为动态获取（query 类接口，待确认）。
- UA 必须是京东 APP 完整 iOS UA（含 `ep=%7B%22ciphertype%22%3A5...` 加密指纹参数，抓自真实请求；普通
  `JD4iPhone/...` UA 也能过签名层，但完整 UA 更不易风控）。
- 请求头：Content-Type form-urlencoded + Referer `https://api.m.jd.com/`（缺 Referer 会 403
  `cross-origin request from '' is not allowed`）；X-Requested-With/Accept-Language zh-cn 建议带全。

#### ★ h5st 签名核心结论（推翻此前"4.x 可用"的一切记录）
- **h5st 4.x（dylib/dyland/dylans 老算法）已不被 api.m.jd.com 接受**：`1711002 参数错误`。
  全混淆脚本 jd_signbeanact_.js 20260608 用的就是 dylans 签名 → 必 1711002（不是脚本 bug，
  是其内置签名器已过期）。
- **h5st 5.3 且必须带正确 tk06 token 才被接受**：kr 模式 krh5st 直出 5.3（8-10 段结构）→
  bff_rightsCenter_interaction 过签名层（落业务层 1714001，而非 1711002）。
- **krh5st 用法（终极路线，无需逆向 47.js / ParamsSign 内部）**：
  ```js
  const H5 = require('<jdpro>/function/krh5st.js');  // 内含 jsdom + isvObfuscator 实时换 tk06 token
  const h5st = await H5(UA, { functionId: 'bff_rightsCenter_interaction',
                              body, appid: 'signed_wh5', client: 'apple', clientVersion: '11.1.2' });
  ```
  传入的 body/appid 必须与请求参数完全一致（bodySign 段绑定 body）。
- krgetToken/krgetSign 不可用（参数语义未明、返回空），**不要再用**；krh5st 自带 token 获取。
- kr 套件依赖：`function/node_modules/ds`（自建 mock）+ redis（`npm i redis`）——npm i 会清 mock，需重建。
- h5source/47.js = 官方 ParamsSign 明文（webpack + obfuscator-vm 字节码），jsdom 可加载 `new ParamsSign({appId})`
  备用；krgetH5st 的 domWindow getter 当前为 null，勿依赖。

#### ★ PC 京豆中心接口**全部免 h5st 签名**（2026-09-09 无头浏览器抓包 + node 直测双重实证）
**重大发现**：PC 端京豆体系接口无需 h5st——`api.m.jd.com/api?functionId=...&appid=asset-h5`（PC 京豆
中心 bean.jd.com）与 `api.m.jd.com/client.action?functionId=...&appid=ld&client=wh5`（购物返豆 H5）
**都不需要签名**，仅需有效 thor cookie。实测（node 直连，无 h5st）：
- `BEAN_BALANCE` → `{"code":"0000","data":{"balance":444,...}}`（京豆余额）
- `BEAN_EXPIRED_DETAILS` → 过期豆明细（expireDayNum 30）
- `BEAN_DETAILS_NOCNT` → 收支明细（pageNo/pageSize/dataType 参数）
- `BEAN_USER_COMMONT_ORDER` → 评价领豆统计
- `SHOP_BEAN_GET_MANUAL_COLLECT_ORDER_LIST` → 10000 系统异常（参数问题非签名问题，勿用）
- `manualCollectIndex` body=`{"rnClient":"1"}` → 待领取订单列表（orderList[].orderIdStr/
  orderJpeasNum/collectStatus 0=可领/collectDeadline）
- `getManualCollectOrderList` body=`{"type":0,"currentPage":-1,"orderDate":"","pageOffSet":"0"}`
  → 领取历史
- **`manualCollectBeans`（购物返豆领取）** body=`{"orderIdList":["<订单号>",...]}` → 领取成功
  `{"code":"0","data":{"collectStatus":"1000"}}`

#### ★★ 评价领京豆全链路打通（2026-09-09 端到端实测，免 h5st 全签名）
**入口**：京豆中心「去评价 >」（5 个商品待评价 = `BEAN_USER_COMMONT_ORDER` 的 commentCount:5）→
club.jd.com 评价中心 → 每个商品按「评价」进 `orderVoucher.action?ruleid=<订单号>`。

**接口（PC club.jd.com，全部免 h5st，仅需 thor cookie）**：
1. 待评价订单列表（服务端渲染 HTML，无 XHR）：`GET https://club.jd.com/myJdcomments/myJdcomment.action?sort=0`
   → 正则提取全部 `orderVoucher.action?ruleid=<订单号>`。
2. 单个订单评价页：`GET https://club.jd.com/myJdcomments/orderVoucher.action?ruleid=<订单号>`
   → 提取 `orderId`（元素 `o-info-orderinfo` 的 `oId` 属性）+ `productId`（页面第一个 `item.jd.com/<pid>.html` 链接）。
   ⚠️ 多商品订单页面只渲染**剩余未评商品**；`image-upload-(\d+)` 的 id 可能残留已评商品，**不可靠**，
   以 item.jd.com 链接为准。
3. **商品评价提交**：`POST https://club.jd.com/myJdcomments/saveProductComment.action`
   （Content-Type form-urlencoded，X-Requested-With: XMLHttpRequest，Referer=orderVoucher 页）：
   ```
   orderId=<订单号>&productId=<SKU>&score=5&content=<双重urlencode>
   &saveStatus=1&anonymousFlag=1
   ```
   - content **双重 urlencode**（submitService.js 里 `encodeURIComponent()` + jQuery 表单序列化；脚本里
     手拼 body 时 `encodeURIComponent(encodeURIComponent(text))`，勿用 URLSearchParams 否则三重）
   - 响应 `{"acc":"N","success":true,"resultCode":"1"}`（acc 每次提交 +1 = 服务端累计评价数）
   - **无需先做服务调查（insertRestSurvey）/ 安装评价（saveInstallComment）**——直接 POST 商品评价即成功
   - 星级：无图 saveStatus=1；匿名 anonymousFlag=1（页面默认勾选）
4. **服务调查（可选，页面「发表」先行步骤）**：`POST /myJdcomments/insertRestSurvey.action?voteid=145&ruleid=<oid>`
   body `oid/ gid/ sid/ tags/ ro1827=1827A1&ro1828=1828A1&ro1829=1829A1`（物流/配送/安装评分 1827-1829 各行）→
   `{"status":1}`。纯脚本可跳过。

**到账实测（2026-09-09）**：提交后 **1~12 分钟到账**（页面「京豆将于一天左右返到你的账户中」是保守文案）。
细则见 `BEAN_DETAILS_NOCNT`：`商品评价(商品号:<sku>)奖励京豆` 逐条记录。
当日 5 单全评（回力裤 3555458004465923 +10、红卫羊脂皂 3595458016191925 +10、四神汤 3595458016189989 +10、
海尔热水器 3581458011664304 +20、十月稻田 3575458002035437），4 单确认到账共 +50 豆；余额 444→509。
**BEAN_USER_COMMONT_ORDER 的 commentCount 归零后列表页不再出现**（`待评价订单: (无)`）。

**购物返豆领取全链路固化**（`projects/opencode-termux/scripts/jd/jd_collect_bean.cjs`）：
查 manualCollectIndex → 筛 collectStatus=0 → manualCollectBeans 批量领取 → 复查余额。
**2026-09-09 端到端实测**：浏览器点击「领取全部京豆」领 63+5=68 豆（余额 376→444），
node 直测 manualCollectBeans 返回 code 0 + collectStatus 1000 免签名 ✅。
请求参数：`client.action?functionId=X&body=<urlencoded JSON>&appid=ld&clientVersion=1.0.0&client=wh5&jsonp=cb<ts>&uuid=<cookie __jdu>&area=1_2802_54747_0`；
UA=Android 手机 UA（Redmi K40），Referer=购物返豆 H5 页。jsonp 包裹需剥壳解析。

#### ★ 1714001 含义更正（2026-09-09 10:12 实测推翻旧表）
**旧解释「1714001=活动时段外(00:00-10:00)」已证伪**：10:12（活动时段 10:00-21:00 **内**）实测
`bff_rightsCenter_interaction` 仍返回 `1714001 请稍后再试~~`。1714001 =「过签名+过登录但业务层
拒绝」，具体诱因是 **assignmentId 已换期失效**（AGENTS 早前标注「内置 assignmentId 若 10:00 后
仍失败需动态获取」——已触发）或今日已领/风控节流，**不是单纯时段**。

**★ 解决：PC 签到链路全打通（2026-09-09 11:33 端到端实测到账，替代失效的 H5 内置 assignmentId）**
H5 `bff_rightsCenter_interaction` 的 assignmentId 换期无法内置，但 **PC 京豆中心「签到领京豆」卡片
走独立接口，assignmentId 每次动态获取**（天然免疫换期）。**2026-09-09 实测签到成功 +2 京豆**
（明细 `活动奖励京豆` 11:33:00 到账；11:39 重跑幂等识别「今日已签到」）。
```
1) 查询（GET  https://api.m.jd.com/?functionId=pc_interact_sign_query&body={"type":1}
   +h5st/uuid/loginType=3/appid=asset-h5/client=pc/clientVersion=1.0.0/t/area）
   → data.assignmentInfoList[] 中 type=5 & extraType="sign" 项：
   id=<每日动态 assignmentId>、signDetail.itemId="1"、completionFlag=true=今日已签
   resourceData.activityId=<活动id>、newUserGuideTask{id,completionFlag}
2) 执行（POST 同 URL，functionId=pc_interact_sign_execute）
   body={"type":5,"eaId":<assignmentId>,"itemId":"1","extraType":"sign"}
   → {"success":true,"data":{"assignmentInfo":{"signList":["2026-09-09_1.0"],...},
      "assignmentRewardInfo":{"jingDouRewards":[{"quantity":2,...}]}}}
3) （可选）newUserGuideTask.completionFlag=false 时补 POST type=0&eaId=<引导id>（无奖励）
```
**⚠️ 两大坑（2026-09-09 实测，脚本已写死规避）**：
- **方法绑定 functionId**：query **必须 GET**、execute **必须 POST**；串用返回
  「互动中心内部访问出现错误」HTML 页（非 JSON）。
- **execute 的 POST 绝不能带 `Content-Type: application/x-www-form-urlencoded`**——带上即被
  api.m.jd.com 网关判非法返回同上 HTML 页；与页面一致只带 UA/Cookie/Referer。
- 签名：krh5st(PC UA, {functionId, body, appid:'asset-h5', client:'pc', clientVersion:'1.0.0'})
  → h5st 5.3；PC UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/120.0.0.0`。
  uuid = cookie `__jda` 第 2 段（页面 Ap() 逻辑）；loginType=3；area=1_2802_54747_0。
- **krh5st 首次进程初始化很慢（jsdom 4-5 分钟），有磁盘缓存后 ~12s**；插件 runScript
  timeout 已调 300s。错误码映射（抓自 channel2022/jd_bean_sign/index-legacy-*.js）：
  306=任务已经领取过 / 309=您还有未完成的任务哦 / 102/101/401=活动太火爆 / 100/3=-100=请先登录哦
  （cookie 失效）。
- 页面 JS 出处：`storage.360buyimg.com/channel2022/jd_bean_sign/index-legacy-BldL61M_.js`
  （京豆中心主框架 `assets-fe/mybean/prod/.../index.*.js` 按需加载该频道 chunk）。

#### 错误码对照（实测，2026-09-09 更新）
| 返回 | 含义 |
|---|---|
| `1711002 参数错误` | h5st 4.x 或参数集与签名不一致（签名层拒） |
| `1714001 请稍后再试` | ✔ 过签名+过登录，**业务层拒绝**（assignmentId 失效/已领/节流——**非单纯时段外**，2026-09-09 10:12 时段内实测仍返回） |
| `402 活动现在挤不进去呀` | signBeanAct 旧接口迁移占位（无 cookie 相同） |
| `403 cross-origin` | 缺 Referer 头 |
| `code:1 no access` | appid 不对（如 wh5 尝试 signBeanAct） |
| `code:2 does not exist` | functionId 不存在 |
| `code:0000` / `code:"0"` | ✅ 成功（PC 京豆接口及购物返豆） |

#### 固化产物
- **签到脚本**：`projects/opencode-termux/scripts/jd/bean_sign.cjs`（多账号从 auth-login 账号池读 thor cookie，
  **PC 签到领京豆链路**：krh5st 5.3 签名 → GET pc_interact_sign_query 动态取 assignmentId →
  POST pc_interact_sign_execute 签到；`--skip-time-check` 无视时段（默认 10:00-21:00）、已签到自动幂等跳过；
  2026-09-09 实测 +2 豆到账、11:39 重跑幂等 ✅；退出码：0=成功/已签到，2=时段外，3=全部失败）。
  ⚠️ H5 天天领豆（bff_rightsCenter_interaction/beanDailySign）assignmentId 换期失效，已弃用。
- **购物返豆领取脚本**：`projects/opencode-termux/scripts/jd/jd_collect_bean.cjs`（全免签名链路
  manualCollectIndex → manualCollectBeans → 复查；2026-09-09 实测领 68 豆 ✅；`--account/--dry-run/--debug`）。
- **评价领豆脚本**：`projects/opencode-termux/scripts/jd/jd_comment_bean.cjs`（全免签名链路
  GET 待评价列表 → GET orderVoucher 提取 productId → POST saveProductComment；`--account/--dry-run/--debug`；
  2026-09-09 实测 3/3 成功 + 明细「商品评价奖励京豆」到账 ✅）。
- **晒单领豆脚本**：`projects/opencode-termux/scripts/jd/jd_photo_bean.cjs`（全免签名链路
  GET club.jd.com/myJdcomments/myJdcomment.action?sort=1（待晒单列表）→ 正则提取 `imgContainer_<orderId>_<productId>` →
  程序生成纯色 PNG（node zlib 手写编码，免外部图片）→ POST ajaxUploadImage.action（multipart: PHPSESSID+Filename，
  响应=纯路径，拼 `//img30.360buyimg.com/shaidan/`+路径）→ POST saveShowOrder.action
  `orderId/productId/imgs=<图片URL>/saveStatus=3`；`--account/--dry-run/--debug`；
  2026-09-09 实测 5/5 单全部提交并移除待晒单 ✅。**判定**：submit 返回
  `{"success":false,"resultCode":"24"}` 是**成功受理**（订单随即从列表移除，京豆审核后约一天到账）；
  空 imgs 会真失败（列表不移除）。
- **插件每日调度（2026-09-09 接线）**：`providers/jd.mjs` `executeActivity` 新增
  `daily_collect_bean`（→ jd_collect_bean.cjs）/ `daily_comment_bean`（→ jd_comment_bean.cjs）/
  `daily_photo_bean`（→ jd_photo_bean.cjs）分支，
  `bean_sign` 也改走脚本（→ bean_sign.cjs PC 签到；signBeanAct 直连 402 已废弃），
  用 `spawnSync("node", ...)` 且 **清 LD_PRELOAD/LD_LIBRARY_PATH**（termux tagfix 干扰 node），
  timeout 300s（krh5st 首次初始化慢）；
  opencode.json `options.sites.jd.activities` 现为 4 项（京豆签到/购物返豆领取/评价领京豆/晒单领京豆），
  auth-login 每日调度（10s 首跑 + 30min interval）自动执行。独立验证脚本：`tmp/opencode/jd_test_plugin_branch.mjs`。
  ⚠️ **无头调试坑（2026-09-09 实测）**：club.jd.com sort=1 页面 chromedriver `/url` 会**等待页面 load 卡死**
  （plupload/长轮询导致 load 事件迟迟不来）——必须 `pageLoadStrategy:'none'`（导航立即返回）；
  且多次测试会堆积 20+ 残留 session 拖垮 chromedriver（DELETE 卡住），reset 方式：kill chromedriver 进程
  后重启（残留 session 无法可靠清理）。页面内 execute/sync 在该页不稳（返回 null），改用
  CDP `Runtime.evaluate`（`/goog/cdp/execute` + returnByValue:true）才稳定。
- **自动执行器**：`scripts/jd/jd_bean_sign_runner.sh`（循环等 10:00 后执行一次即退出，日志 `bean_sign.log`；
  `nohup bash jd_bean_sign_runner.sh &` 启动）。
- 运行依赖：jdpro 仓库 `tmp/opencode/jd-h5st/jdpro/function/`（krh5st + node_modules/ds + redis）。

#### 抓包方法（jdpro 脚本调试验证用）
- **安全 patch**（`tmp/opencode/jd-h5st/jdpro/patch_safe2.cjs`）：只读 got 的 `opts.body/json/form/headers` +
  hook response（含 zlib gunzip），**绝不覆盖 req.write/req.end**——旧 patch 覆盖 write/end 会让
  jd_signbeanact_.js 在发请求前崩 `Cannot read properties of undefined (reading 'includes')`（已定位是
  patch 干扰 got 的锅，非脚本自身 bug；不带 patch 时脚本能正常发包返回 1711002）。
- 抓包过滤：api.m.jd.com / isvObfuscator / bff_。
