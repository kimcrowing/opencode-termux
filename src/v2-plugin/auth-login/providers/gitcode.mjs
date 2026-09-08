// providers/gitcode.mjs — GitCode (AtomGit) 扫码登录 + 签到/领积分活动适配器。
//
// 【端点全部为 2026-09-07 抓包 + 页面 JS bundle 实证，勿猜测改动】
//
//   真实 API 域：https://web-api.gitcode.com（不是 gitcode.com！）
//   所有请求统一带 query 参数 __s=aihub
//   常见 app headers（生成/轮询/login/签到/领积分通用）：
//     X-Platform: web / X-OS-Version: Unknown / X-Device-ID: unknown
//     X-App-Channel: gitcode-fe / X-Device-Type: Windows / X-App-Version: 0
//     X-Network-Type: 4g（+ Referer）
//   generate 与 login 额外带 X-Source: toolbar_login
//
// 登录（微信小程序码，三端点）：
//   1) POST /uc/api/v1/qrcode/wechat_mini_program?__s=aihub   body:{}  X-Source: toolbar_login
//      → { qrcode: "data:image/png;base64,...", scene_id: "..." }
//      qrcode 是服务端生成的微信小程序码 PNG，必须原样展示（本地 QR 编码器无法重编码小程序码）。
//   2) GET  /uc/api/v1/qrcode/wechat_mini_program?scene_id=X&__s=aihub
//      → { "status": "WAITING" | "SCAN" | "LOGIN" | "TIMEOUT" }
//      （页面行为：状态到 SCAN/LOGIN 后自动调 login 换 token）
//   3) POST /uc/api/v1/user/oauth/login/qrcode/wechat_mini_program?scene_id=X&__s=aihub
//      body:{}  X-Source: toolbar_login
//      → 未扫码时 400 { error_code:1000, error_message:"二维码已失效" }（业务错误，非 401）；
//        扫码后 200，响应体为扁平 { access_token, refresh_token, ... }
//
// 签到 / 积分（Authorization: Bearer <access_token> + app headers）：
//   POST /uc/api/v1/task/sign-in?__s=aihub            body:{} → 200 成功；400 "今日已签到，明天记得来签到哦。"
//   GET  /uc/api/v1/task/v2/sign_status?__s=aihub     → { award_index, is_sign_in, scores:[7,7,14,7,7,7,21], growths:[...] }
//   GET  /uc/api/v1/task/unclaimed?__s=aihub          → 待领取任务列表（无待领时 200 空 body）
//   POST /uc/api/v1/task/{id}/points?__s=aihub        → 领取指定任务积分
//   GET  /uc/api/v1/task/{id}?__s=aihub               → 任务详情
//
// 活动定义（opencode.json 插件 options.sites.gitcode.activities）：
//   [{ "name": "每日签到",           "type": "sign_in"            }]
//   [{ "name": "领取全部待领积分",    "type": "claim_all"          }]
//   [{ "name": "每日Star一个项目",    "type": "daily_star",   "repo_id": 10708627 }]
//   [{ "name": "每日查看热门",        "type": "daily_view",   "repo_id": 9709354 }]
//   [{ "name": "每日分享",            "type": "daily_invite"        }]
//   [{ "name": "每日更新项目",        "type": "daily_update", "repo": "kimcrowing/xcpquery" }]
//   [{ "name": "关注CANN社区",        "type": "cann_follow"         }]
//   [{ "name": "Star CANN项目",      "type": "cann_star",     "repo_id": 10708627 }]
//   [{ "name": "下载模型文件",        "type": "download_ai_file"    }]
//   [{ "name": "完善资料",            "type": "complete_profile", "bio": "…10字以上…" }]
//   [{ "name": "启用个人README",      "type": "enable_readme"       }]
//   type 为以上值时走下方对应实证逻辑；其他 type 回退通用请求（def.path/method/body）。

import { SITE_STATE } from "../core.mjs";

const API = "https://web-api.gitcode.com";

// 通用 app headers（生成/轮询/login/活动全部使用）
function appHeaders(extra = {}) {
  return Object.assign(
    {
      "X-Platform": "web",
      "X-OS-Version": "Unknown",
      "X-Device-ID": "unknown",
      "X-App-Channel": "gitcode-fe",
      "X-Device-Type": "Windows",
      "X-App-Version": "0",
      "X-Network-Type": "4g",
      Referer: "https://ai.gitcode.com/",
    },
    extra
  );
}

// 从 JWT 解码用户信息（零依赖，仅用于展示用户名）
function decodeJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function extractToken(body) {
  if (!body || typeof body !== "object") return null;
  const src = body.data && typeof body.data === "object" ? body.data : body;
  const t = src.access_token || src.accessToken || src.token;
  return t ? String(t) : null;
}

export default {
  id: "gitcode",
  name: "GitCode",
  apiBase: API,
  pollIntervalMs: 3000,
  qrTimeoutMs: 150000, // 二维码有效期约 2 分钟；本地兜底超时

  // 生成微信小程序码。返回 { base64 } → core.mjs 落盘为 storage/<site>/qr-<ts>.png（服务端原图，不重编码）。
  // scene_id 挂到会话对象上，供 pollStatus / login 使用。
  async generateQr(s) {
    const url = `${API}/uc/api/v1/qrcode/wechat_mini_program?__s=aihub`;
    const res = await fetch(url, {
      method: "POST",
      headers: appHeaders({ "Content-Type": "application/json", "X-Source": "toolbar_login" }),
      body: "{}",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`生成二维码失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`生成二维码返回非 JSON: ${text.slice(0, 200)}`);
    }
    if (!j || !j.qrcode || !j.scene_id) {
      throw new Error(`生成二维码响应缺字段: ${JSON.stringify(j).slice(0, 200)}`);
    }
    s.sceneId = String(j.scene_id);
    s._qrT0 = Date.now();
    return {
      base64: String(j.qrcode),
      ascii: `[GitCode] 微信小程序扫码登录已生成，请用微信扫码并在小程序中点击「确认登录」。二维码约 2 分钟内有效。`,
    };
  },

  // 轮询扫码/确认状态；SCAN/LOGIN 后按页面行为自动调 login 换 token。
  async pollStatus(s) {
    const sceneId = s && (s.sceneId || s.tokenPayload?.scene_id);
    if (!sceneId) return { state: SITE_STATE.ERROR, message: "缺少 scene_id" };

    // 本地兜底超时（二维码约 2 分钟有效，超 180s 视为过期）
    if (s._qrT0 && Date.now() - s._qrT0 > 180000) {
      return { state: SITE_STATE.EXPIRED };
    }

    const pollUrl = `${API}/uc/api/v1/qrcode/wechat_mini_program?scene_id=${encodeURIComponent(sceneId)}&__s=aihub`;
    let poll;
    try {
      const res = await fetch(pollUrl, { headers: appHeaders() });
      const text = await res.text();
      if (!res.ok) return { state: SITE_STATE.ERROR, message: `轮询失败 HTTP ${res.status}: ${text.slice(0, 150)}` };
      poll = JSON.parse(text);
    } catch (e) {
      return { state: SITE_STATE.WAITING }; // 网络抖动：下轮再试
    }

    const status = (poll && poll.status) || "";
    if (status === "WAITING") return { state: SITE_STATE.WAITING };
    if (status === "TIMEOUT") return { state: SITE_STATE.EXPIRED };

    // SCAN / LOGIN → 调 login 换 token（页面行为）
    if (status === "SCAN" || status === "LOGIN") {
      const r = await this.doLogin(sceneId);
      if (r.ok) {
        return {
          state: SITE_STATE.CONFIRMED,
          token: r.token,
          refreshToken: r.refreshToken,
          cookies: r.cookies,
          headers: this.headers(r.token),
          user: r.user,
        };
      }
      // login 未成功（业务错误，如尚未确认）→ 视为已扫码，等下一轮 LOGIN/重试
      return status === "LOGIN"
        ? { state: SITE_STATE.SCANNED, message: "LOGIN 态 login 未成功，继续重试" }
        : { state: SITE_STATE.SCANNED, message: r.message };
    }

    // 未知状态（如仍 WAITING 的变体 / 字段缺失）→ 保守 WAITING
    return { state: SITE_STATE.WAITING };
  },

  // 用 scene_id 换 token；成功返回 { ok, token, refreshToken, cookies, user }
  async doLogin(sceneId) {
    const url = `${API}/uc/api/v1/user/oauth/login/qrcode/wechat_mini_program?scene_id=${encodeURIComponent(sceneId)}&__s=aihub`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: appHeaders({ "Content-Type": "application/json", "X-Source": "toolbar_login" }),
        body: "{}",
      });
    } catch (e) {
      return { ok: false, message: `login 网络异常: ${e.message}` };
    }
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const msg = j?.error_message || j?.error || text.slice(0, 150);
      return { ok: false, message: `login HTTP ${res.status}: ${msg}` };
    }
    const token = extractToken(j);
    if (!token) {
      return { ok: false, message: `login 响应无 access_token: ${text.slice(0, 200)}` };
    }
    const refreshToken =
      (j && (j.data && (j.data.refresh_token || j.data.refreshToken))) || (j && (j.refresh_token || j.refreshToken)) || "";
    const payload = decodeJwtPayload(token);
    return {
      ok: true,
      token,
      refreshToken,
      cookies: { access_token: token, refresh_token: refreshToken },
      user: payload ? { username: payload.sub, payload } : null,
    };
  },

  // 手动注入 token（OAuth 备用 / 抓包得到的现有登录态）。
  // opts.token 必填；opts.refreshToken / opts.user 可选。
  async manualToken(s, opts) {
    const token = opts?.token;
    if (!token) throw new Error("需要 token 参数");
    const payload = decodeJwtPayload(token);
    return {
      token,
      user: opts?.user || (payload ? { username: payload.sub, payload } : null),
      cookies: {
        access_token: token,
        refresh_token: opts?.refreshToken || "",
      },
      headers: this.headers(token),
    };
  },

  // 刷新 access token（2026-09-07 JS bundle 实证）：
  //   POST https://web-api.gitcode.com/uc/api/v1/user/token/refresh
  //   body(form-urlencoded): refresh_token=...   响应体扁平 { access_token, refresh_token }
  //   实测：200 后新 access_token 续期 24h（旧 token 宽限期内仍 200，不立即失效），幂等可每天调用。
  async refresh(s) {
    const refreshToken = (s.cookies && s.cookies.refresh_token) || s.refreshToken || "";
    if (!refreshToken) {
      return { ok: false, message: "缺少 refresh_token（重新扫码登录后可获得）" };
    }
    const body = new URLSearchParams({ refresh_token: refreshToken }).toString();
    let res;
    try {
      res = await fetch(`${API}/uc/api/v1/user/token/refresh?__s=aihub`, {
        method: "POST",
        headers: Object.assign(
          { Authorization: `Bearer ${s.token || ""}`, "content-type": "application/x-www-form-urlencoded" },
          appHeaders()
        ),
        body,
      });
    } catch (e) {
      return { ok: false, message: `refresh 网络异常: ${e.message}` };
    }
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const msg = j?.error_message || j?.error || text.slice(0, 150);
      return { ok: false, message: `refresh HTTP ${res.status}: ${msg}` };
    }
    const token = extractToken(j);
    if (!token) return { ok: false, message: `refresh 响应无 access_token: ${text.slice(0, 200)}` };
    const newRefresh = (j && (j.refresh_token || j.refreshToken)) || "";
    const payload = decodeJwtPayload(token);
    return {
      ok: true,
      token,
      refreshToken: newRefresh,
      cookies: { access_token: token, refresh_token: newRefresh },
      headers: this.headers(token),
      // 【坑（2026-09-08 实测修复）】refresh 会重建 user 对象——必须沿用旧 user.email，
      //   否则账号文件里登记的历史 email（用于 daily_update 的 author_email 校验）会被冲掉，
      //   导致次日 daily_update 报 400「email参数错误」（实测：昨晚写入 user.email，
      //   今晨 refresh 后文件 user 只剩 username/payload → daily_update 400）。
      user: payload ? { username: payload.sub, payload, email: (s.user && s.user.email) || "" } : (s.user || null),
    };
  },

  // 鉴权请求头：Bearer + app headers
  headers(token) {
    return token ? Object.assign({ Authorization: `Bearer ${token}` }, appHeaders()) : appHeaders();
  },

  // 活动执行器：全部为 2026-09-07 抓包 + 页面点击实证的真实触发接口（勿猜改）。
  //   sign_in / claim_all 见下方方法；
  //   daily_star / daily_view / daily_invite / daily_update / cann_follow /
  //   cann_star / download_ai_file / complete_profile / enable_readme 为实证活动（见注释）；
  //   其他 type 回退通用请求（def.method/path/body）。
  async executeActivity(s, def) {
    // 活动定义账户级模板替换：def 里的 {username} → 当前账户 user.username
    // （典型用于 daily_update 的 repo "kimcrowing/xcpquery" → 各账户自己的仓库 "{username}/xcpquery"）。
    const raw = def || {};
    def = {};
    for (const [k, v] of Object.entries(raw)) {
      def[k] = typeof v === "string"
        ? v.replace(/\{username\}/g, (s.user && s.user.username) || "")
        : v;
    }
    const type = String(def.type || "");
    if (type === "sign_in" || type === "sign-in" || type === "signin") return this.signIn(s);
    if (type === "claim_all" || type === "claim") return this.claimAll(s);
    if (type === "daily_star") return this.starProject(s, Number(def.repo_id || def.repoId || 10708627));
    if (type === "cann_star") return this.starProject(s, Number(def.repo_id || 10708627));
    if (type === "daily_view") return this.dailyViewRecommended(s, def);
    if (type === "daily_invite") return this.dailyInviteShare(s);
    if (type === "daily_update") return this.updateProject(s, def);
    if (type === "cann_follow") return this.followCann(s);
    if (type === "download_ai_file") return this.downloadAiFile(s, def);
    if (type === "complete_profile") return this.completeProfile(s, def);
    if (type === "enable_readme") return this.enableReadme(s, def);
    // 通用 fallback：def.method/path/body
    const url = (def.baseUrl || API) + (def.path || "");
    const res = await fetch(url, {
      method: def.method || "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token), def.headers || {}),
      body: def.body ? JSON.stringify(def.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: parseBody(text) };
  },

  // Star 一个项目（实证：POST /api/v2/projects/{repoId}/star 成功 → 每日Star/Star CANN 任务完成）。
  // cann/cannbot 的 repoId = 10708627。重复 star 幂等（200）。
  async starProject(s, repoId) {
    const url = `${API}/api/v2/projects/${encodeURIComponent(repoId)}/star?__s=aihub`;
    const res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: JSON.stringify({ repoId }),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
  },

  // 每日查看热门：点击首页推荐卡片后前端上报 PC_PageClick（实证 body）。点击后 1 小时内可领取。
  async dailyViewRecommended(s, def) {
    const body = {
      repo_id: Number(def.repo_id || 9709354),
      module_name: "推荐_今日热门",
      page: 1,
      repo_index: 0,
      Project_card_star: "card",
    };
    const res = await fetch(`${API}/api/v1/report?event_id=PC_PageClick&__s=aihub`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
  },

  // 每日分享：点头像菜单「邀请有礼」→ 点「复制邀请链接」后前端上报 page_click（实证 body）。
  async dailyInviteShare(s) {
    const res = await fetch(`${API}/api/v1/report?event_id=page_click&__s=aihub`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: JSON.stringify({ button_name: "常规邀请_复制邀请链接_PC" }),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
  },

  // 每日更新项目：往用户自己仓库 push 一个 commit（实证 commits API，encoding=base64 必填）。
  // def.repo 默认 kimcrowing/xcpquery（用户授权）；file 默认 docs/update-log.md（append 模式内容可配）。
  // 【坑（2026-09-07 部署实测）】action:create 在文件已存在时报错 → probe 探测 + create/update fallback：
  //   文件存在 → update（内容每次带新日期 → 总能产生新 commit）；不存在/update 404 → create；create 报已存在 → update。
  async updateProject(s, def) {
    const repo = String(def.repo || "kimcrowing/xcpquery").replace("/", "%2F");
    const filePath = String(def.file || "docs/update-log.md");
    const branch = String(def.branch || "main");
    const date = new Date().toISOString().slice(0, 10);
    const content = String(def.content || `# Update Log\n- ${date}: daily auto maintenance\n`);

    const doPush = async (action) => {
      const body = {
        branch,
        commit_message: `docs: daily auto-update ${date}`,
        author_name: (s.user && s.user.username) || "kimcrowing",
        // author_email 优先级：账号文件 user.email（每账号自己的绑定邮箱）> 活动 def.email > 默认 kimcrowing 的邮箱。
        // 【坑（2026-09-07 实测）】GitCode commits API 校验 author_email 必须等于当前账号已绑定邮箱：
        //   用别的邮箱一律 400 「email参数错误」（test@test.com/空/petalmail 猜测全被拒）。
        //   新扫码账号（如 gcw_TojUaPz9）无绑定邮箱时该任务无法完成，需先网页绑定邮箱再在账号文件 user.email 填值。
        author_email: String(((s.user && s.user.email) || def.email) || "kim_mail@petalmail.com"),
        actions: [{ action, file_path: filePath, content: Buffer.from(content).toString("base64"), encoding: "base64" }],
      };
      const res = await fetch(`${API}/api/v2/projects/${repo}/repository/commits?__s=aihub`, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return { action, res, text, status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
    };

    // probe：文件是否存在（GitLab 风格）
    let exists = false;
    try {
      const probe = await fetch(
        `${API}/api/v2/projects/${repo}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(branch)}&__s=aihub`,
        { headers: this.headers(s.token) }
      );
      exists = probe.ok;
    } catch {}

    let r = await doPush(exists ? "update" : "create");
    if (!r.ok) {
      // fallback：create 报已存在 → update；update 报不存在 → create
      const fb = r.action === "create" ? "update" : "create";
      const r2 = await doPush(fb);
      if (r2.ok) return { ...r2, fallbackFrom: r.action };
      return { ...r2, fallbackFrom: r.action, firstError: r.message };
    }
    return r;
  },

  // 关注 CANN 社区（一次性 +200，自动发放）：POST /uc/api/v1/follow（关注后无需领取）。
  async followCann(s) {
    const res = await fetch(`${API}/uc/api/v1/follow?__s=aihub`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: JSON.stringify({ followedUsername: "cann", followType: 1 }),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
  },

  // 下载模型文件（实证：点击模型文件 resolve 下载链接 → 前端上报 aihub_model_page_file_download，
  // body 含模型名/路径/作者/文件名；之后还需真实 GET raw 文件触发记录）。
  async downloadAiFile(s, def) {
    const modelPath = String(def.model_path || def.path || "hf_mirrors/Qwen/Qwen2.5-Omni-7B");
    const modelName = String(def.model_name || def.name || "Qwen2.5-Omni-7B");
    const author = String(def.author || "xxm");
    const fileName = String(def.file_name || def.file || ".gitattributes");
    const reportBody = {
      aihub_model_name: modelName,
      aihub_model_path: modelPath,
      aihub_author_name: author,
      aihub_file_name: fileName,
    };
    const res = await fetch(`${API}/api/v1/report?event_id=aihub_model_page_file_download&__s=aihub`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: JSON.stringify(reportBody),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
  },

  // 完善资料（一次性 +20）：简介 ≥10 字保存（实证 POST /uc/api/v1/user/setting/save）。
  // 只改简介，不动昵称/头像（用户授权口径）。重复保存幂等。
  async completeProfile(s, def) {
    const curr = await this.fetchJson(`${API}/uc/api/v1/user/setting/profile?username=&__s=aihub`, s.token);
    const p = (curr && curr.profile) || {};
    const bio = String(def.bio || p.description || "长期关注专利检索、数据分析与自动化工具开发的开源爱好者。");
    const body = {
      avatar: String((curr && curr.avatar) || ""),
      nickname: String((curr && curr.nickname) || (s.user && s.user.username) || "kimcrowing"),
      profile: {
        company: p.company || "",
        description: bio,
        location: p.location || "",
        setting_private: p.setting_private !== false,
        website: p.website || "",
        email_private: p.email_private !== false,
        github_account: p.github_account || "",
        show_email: p.show_email || "",
        readme_branch: p.readme_branch || "",
        readme_file_path: p.readme_file_path || "",
        readme_repo: p.readme_repo || "",
        readme_switch: p.readme_switch === undefined ? 1 : p.readme_switch,
        readme_show_mode: p.readme_show_mode === undefined ? 2 : p.readme_show_mode,
      },
    };
    const res = await fetch(`${API}/uc/api/v1/user/setting/save?__s=aihub`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
  },

  // 启用个人README（一次性 +10）：配置 readme_repo/readme_file_path/readme_branch 保存。
  // def.repo 默认 kimcrowing/xcpquery + README.md + main（用户授权口径）。
  async enableReadme(s, def) {
    const repo = String(def.repo || "kimcrowing/xcpquery");
    const filePath = String(def.file || "README.md");
    const branch = String(def.branch || "main");
    const curr = await this.fetchJson(`${API}/uc/api/v1/user/setting/profile?username=&__s=aihub`, s.token);
    const p = (curr && curr.profile) || {};
    const body = {
      avatar: String((curr && curr.avatar) || ""),
      nickname: String((curr && curr.nickname) || (s.user && s.user.username) || "kimcrowing"),
      profile: {
        company: p.company || "",
        description: p.description || "",
        location: p.location || "",
        setting_private: p.setting_private !== false,
        website: p.website || "",
        email_private: p.email_private !== false,
        github_account: p.github_account || "",
        show_email: p.show_email || "",
        readme_branch: branch,
        readme_file_path: filePath,
        readme_repo: repo,
        readme_switch: 1,
        readme_show_mode: Number(def.show_mode || 2),
      },
    };
    const res = await fetch(`${API}/uc/api/v1/user/setting/save?__s=aihub`, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, message: parseBody(text) || text.slice(0, 100) };
  },

  // 辅助：GET JSON（带鉴权）
  async fetchJson(url, token) {
    try {
      const r = await fetch(url, { headers: this.headers(token) });
      return JSON.parse(await r.text());
    } catch {
      return null;
    }
  },

  async signIn(s) {
    const url = `${API}/uc/api/v1/task/sign-in?__s=aihub`;
    const res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
      body: "{}",
    });
    const text = await res.text();
    const body = parseBody(text);
    const signedToday = res.status === 400 && /已签到/.test(text);
    // 签到成功后顺带查询签到状态（含 7 天积分序列）
    let statusInfo = null;
    try {
      const st = await fetch(`${API}/uc/api/v1/task/v2/sign_status?__s=aihub`, { headers: this.headers(s.token) });
      statusInfo = parseBody(await st.text());
    } catch {}
    return {
      status: res.status,
      ok: res.ok || signedToday,
      message: signedToday ? "今日已签到" : body?.error_message || (res.ok ? "签到成功" : text.slice(0, 120)),
      signStatus: statusInfo,
    };
  },

  async claimAll(s) {
    // 1) 待领取列表：「每日待领」以 /uc/api/v1/task/v2/uncompleted 的 status==0 为准。
    //    【坑（2026-09-07 实测，已修复）】/uc/api/v1/task/unclaimed 端点实测**恒返回空 body**（含已结算
    //    status=0 可领任务也漏报：2026-09-08 实测 uncompleted 有 6 个可领、unclaimed 返回空 → 自动领取
    //    从未生效）。uncompleted 返回 {starter_task,daily_task,normal_task} 三数组，status=0=待领取、
    //    1=已领、2=未完成（同 id 会跨数组重复出现，按 task_id 去重再逐个领）。
    const listRes = await fetch(`${API}/uc/api/v1/task/v2/uncompleted?limit=100&__s=aihub`, { headers: this.headers(s.token) });
    const listText = await listRes.text();
    let list = null;
    if (listText.trim()) {
      try {
        list = JSON.parse(listText);
      } catch {}
    }
    const byId = new Map();
    for (const key of ["starter_task", "daily_task", "normal_task"]) {
      for (const t of Array.isArray(list?.[key]) ? list[key] : []) {
        if (t && t.status === 0 && t.task_id != null) byId.set(t.task_id, t);
      }
    }
    const arr = [...byId.values()];
    if (arr.length === 0) {
      return { status: listRes.status, ok: true, message: "当前没有待领取的积分任务", claimed: [] };
    }
    // 2) 逐个领取
    const claimed = [];
    for (const item of arr) {
      const id = item && (item.id ?? item.task_id ?? item.taskId ?? item.taskID);
      if (id == null) {
        claimed.push({ id: null, skipped: true, reason: "缺任务 id" });
        continue;
      }
      try {
        const r = await fetch(`${API}/uc/api/v1/task/${encodeURIComponent(id)}/points?__s=aihub`, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
          body: "{}",
        });
        const t = await r.text();
        claimed.push({ id, status: r.status, body: parseBody(t), ok: r.ok });
      } catch (e) {
        claimed.push({ id, ok: false, error: e.message });
      }
    }
    return { status: listRes.status, ok: claimed.every((c) => c.ok || c.skipped), claimed };
  },
};

function parseBody(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return String(text).slice(0, 200);
  }
}