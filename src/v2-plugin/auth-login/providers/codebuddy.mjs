// providers/codebuddy.mjs — CodeBuddy (腾讯云代码助手) IOA 扫码登录 + 成长计划积分活动适配器。
//
// 【端点全部为 2026-09-07 真机实测 + codebuddy-provider.patch(i oa.ts) 实证，勿猜改】
//
//   IOA 登录（copilot.tencent.com）：
//     POST /v2/plugin/auth/state?platform=VSCode&ioa=1  头 noAuthHeaders，无 body
//       → 200 {code:0, data:{state, authUrl}}；authUrl 即登录页链接（本地 QR 渲染整串 URL）
//       实测：authUrl = https://copilot.tencent.com/login?platform=VSCode&state=...，
//       手机扫码 301 → www.codebuddy.cn/login/?...（OneID SPA，支持微信扫码/手机号验证码/邮箱/密码）
//     GET  /v2/plugin/auth/token?state=X  头 noAuthHeaders
//       → 未登录 {code:11217, msg:"11217:login ing..."}；登录成功 {code:0, data:{accessToken, refreshToken?, expiresIn?}}
//     POST /v2/plugin/auth/token/refresh  头 Content-Type/Accept + X-Refresh-Token: <refreshToken>，无 body
//       → {code:0, data:{accessToken, refreshToken(轮换, 需保存), expiresIn(秒=60天), ...}}
//       ★ 2026-09-07 实测更正：补丁 ioa.ts 只带 `Authorization: Bearer <RT>` 的形状返回
//         400 {"code":10001,"msg":"refreshToken is empty"}——服务端从 **X-Refresh-Token 头**读 refresh token
//         （Authorization 头不被认可；body/query 传 refreshToken/refresh_token 均实测同样 400）。
//         响应 refreshToken 会轮换，必须取回并落盘，否则下次 refresh 拿旧 RT 会被服务端拒。
//   （登录 state/poll 两端点与补丁 ioa.ts 的 ioaRequestAuthState/ioaPollForToken 一致；
//     refresh 端点形状以本次实测为准，补丁 ioa.ts 的 ioaRefreshToken 仅作参考勿再照抄）
//
//   成长/积分（copilot.tencent.com，纯 Bearer 即可；APISIX 网关偶发 401 → fetchRetry 重试）：
//     GET  /v2/activity/growth/tasks
//       → {code:0, data:{tasks:[{task_code, accept_status, progress:{current,target}, reward_credit, ...}]}}
//       accept_status 枚举（JS bundle 实证）：not_accepted / accepted / in_progress / completed / claimed
//     POST /activity/growth/tasks/{task_code}/claim   → {code:0} 成功；{code:400,msg:"task not completed"} 未完成（跳过）
//     GET  /activity/growth/lottery/chances → {code:0, data:{balance}}（balance=0 无次数）
//     POST /activity/growth/lottery/draw body {client_token} → 抽奖
//     GET  /v2/activity/growth/profile → {code:0, data:{completed, total, level}}
//
//   礼包（www.codebuddy.cn，Bearer + X-Domain + X-User-Id，与 checkin 补丁同款认证）：
//     POST /billing/meter/claim-gift → {code:0} 成功；{code:10001,"每人限领一次，您已领取过无法重复领取"} 幂等已领
//     （GET /billing/meter/check-gift-claimed 实测 404 不存在，勿用）
//
//   账号 label = JWT preferred_username（手机号）→ 与 opencode credential 表 label 一致
//   （三账号实测：18623190160 / 15123837998 / 13983704720）
//
// 【方案 A · credential 同步】登录成功（pollStatus CONFIRMED）与 refresh 成功后，
// 把 {access, refresh, expires, uid} 写入 opencode credential 表（integration_id="codebuddy"），
// 使 opencode 内置 codebuddy provider（模型 + 补丁 checkin）与 auth-login 共用同一份 token。
//   登录 → makeActive=true（新登录账号设为 active）；
//   refresh → makeActive=false（只滚动 token，不把 opencode 的 active 账号在每日轮询里拨来拨去）。

import { SITE_STATE } from "../core.mjs";
import { syncToOpencodeCredential } from "../credential-sync.mjs";

const API = "https://copilot.tencent.com"; // IOA 登录 + growth 域名（实测）
const WEB = "https://www.codebuddy.cn"; // 礼包/签到域名（checkin 补丁同域）
const PLATFORM = "VSCode";
const LOGIN_TTL_MS = 10 * 60 * 1000; // 与补丁 ioa.ts DEFAULT_TTL_MS 一致：10 分钟内完成扫码

// 登录端点专用头（补丁 ioa.ts noAuthHeaders 实证）
function noAuthHeaders() {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
}

// 从 JWT 解码 payload（零依赖）
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

// uid = JWT sub（与补丁 ioaResolveUserId 一致）
function ioaResolveUserId(accessToken) {
  const p = decodeJwtPayload(accessToken);
  return (p && p.sub) || "";
}

// 账号 label：preferred_username（手机号）→ nickname → uid（补丁 ioaAccountLabel 一致）
function ioaAccountLabel(accessToken) {
  const p = decodeJwtPayload(accessToken);
  if (!p) return "";
  if (p.preferred_username) return String(p.preferred_username);
  if (p.nickname || p.name) return String(p.nickname || p.name);
  return String(p.sub || "");
}

// 简单 sleep
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// growth 端点偶发 401/5xx（APISIX 网关抖动，2026-09-07 实测）→ 短退避重试；业务 4xx / 2xx / 3xx 不重试
async function fetchRetry(url, opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      last = e;
      await sleep(600 * (i + 1));
      continue;
    }
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      last = new Error(`HTTP ${res.status}`);
      await sleep(600 * (i + 1));
      continue;
    }
    return res;
  }
  throw last || new Error("请求失败");
}

function parseBody(text) {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return String(text).slice(0, 200);
  }
}

export default {
  id: "codebuddy",
  name: "CodeBuddy",
  apiBase: API,
  pollIntervalMs: 3000,
  qrTimeoutMs: LOGIN_TTL_MS,

  // 生成 IOA 登录二维码：返回 authUrl 字符串 → core.mjs 本地 QR 渲染整串链接。
  async generateQr(s) {
    const url = `${API}/v2/plugin/auth/state?${new URLSearchParams({ platform: PLATFORM, ioa: "1" })}`;
    const res = await fetch(url, { method: "POST", headers: noAuthHeaders() });
    const text = await res.text();
    if (!res.ok) throw new Error(`生成二维码失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`生成二维码返回非 JSON: ${text.slice(0, 200)}`);
    }
    if (j.code !== 0 || !j.data || !j.data.state) {
      throw new Error(`生成二维码响应异常: ${JSON.stringify(j).slice(0, 200)}`);
    }
    s._cbState = String(j.data.state);
    s._cbT0 = Date.now();
    const authUrl = j.data.authUrl || `${API}/login?platform=${PLATFORM}&state=${s._cbState}&ioa=1`;
    return authUrl;
  },

  // 轮询扫码/确认状态；code:0 + data.accessToken = 确认 → 组装 CONFIRMED（含刷新后 credential 同步）。
  async pollStatus(s) {
    const state = s && s._cbState;
    if (!state) return { state: SITE_STATE.ERROR, message: "缺少登录 state" };
    if (s._cbT0 && Date.now() - s._cbT0 > LOGIN_TTL_MS) {
      return { state: SITE_STATE.EXPIRED };
    }

    let j = null;
    try {
      const res = await fetch(`${API}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { headers: noAuthHeaders() });
      const text = await res.text();
      if (res.ok) {
        try {
          j = JSON.parse(text);
        } catch {}
      }
    } catch {
      return { state: SITE_STATE.WAITING }; // 网络抖动：下轮再试
    }

    if (!j) return { state: SITE_STATE.WAITING };
    if (j.code === 0 && j.data && j.data.accessToken) {
      const token = String(j.data.accessToken);
      const refreshToken = String(j.data.refreshToken || "");
      const payload = decodeJwtPayload(token);
      const username = ioaAccountLabel(token) || "default";
      const result = {
        state: SITE_STATE.CONFIRMED,
        token,
        refreshToken,
        cookies: { access_token: token, refresh_token: refreshToken },
        headers: this.headers(token),
        user: payload ? { username, payload } : { username },
      };
      // 方案 A：登录成功 → 同步进 opencode credential 表（异步失败不阻断登录）
      this.syncCredentialSafe({
        token,
        refresh: refreshToken,
        uid: (payload && payload.sub) || "",
        label: username,
        makeActive: true,
      });
      return result;
    }
    // 其他 code（如 11217 "login ing..."）→ 继续等待
    return { state: SITE_STATE.WAITING, message: (j.msg || j.message || "").slice(0, 120) };
  },

  // 手动注入 token（OAuth 备用 / 从 opencode credential 表导入 / 抓包现有登录态）。
  // opts.token 必填；opts.refreshToken 可选。
  async manualToken(s, opts) {
    const token = opts?.token;
    if (!token) throw new Error("需要 token 参数");
    const payload = decodeJwtPayload(token);
    const username = ioaAccountLabel(token) || (opts?.user && opts.user.username) || "default";
    const refreshToken = opts?.refreshToken || "";
    return {
      token,
      refreshToken,
      user: payload ? { username, payload } : { username },
      cookies: { access_token: token, refresh_token: refreshToken },
      headers: this.headers(token),
    };
  },

  // 刷新 IOA token（2026-09-07 实测：POST /v2/plugin/auth/token/refresh，
  // 服务端从 **X-Refresh-Token 头**读 refresh token——只带 Authorization: Bearer 会 400
  // "refreshToken is empty"；响应 data.refreshToken 会轮换，必须保存新值）。
  async refresh(s) {
    const refreshToken = (s.cookies && s.cookies.refresh_token) || s.refreshToken || "";
    if (!refreshToken) {
      return { ok: false, message: "缺少 refresh_token（重新扫码登录后可获得）" };
    }
    let res;
    try {
      res = await fetch(`${API}/v2/plugin/auth/token/refresh`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${refreshToken}`,
          "X-Refresh-Token": refreshToken,
        },
      });
    } catch (e) {
      return { ok: false, message: `refresh 网络异常: ${e.message}` };
    }
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (!res.ok || !j || j.code !== 0 || !j.data || !j.data.accessToken) {
      return { ok: false, message: `refresh 失败 HTTP ${res.status}: ${text.slice(0, 150)}` };
    }
    const token = String(j.data.accessToken);
    const newRefresh = String(j.data.refreshToken || refreshToken);
    const payload = decodeJwtPayload(token);
    const username = ioaAccountLabel(token) || (s.user && s.user.username) || "default";
    const fresh = {
      ok: true,
      token,
      refreshToken: newRefresh,
      cookies: { access_token: token, refresh_token: newRefresh },
      headers: this.headers(token),
      user: payload ? { username, payload } : s.user || { username },
    };
    // 方案 A：refresh 只滚动 token，不改变 opencode 的 active 账号
    this.syncCredentialSafe({
      token,
      refresh: newRefresh,
      uid: (payload && payload.sub) || (s.user && s.user.payload && s.user.payload.sub) || "",
      label: username,
      makeActive: false,
    });
    return fresh;
  },

  // 鉴权请求头：Bearer + JSON（growth 端点纯 Bearer 即可；X-Domain 供 www 域端点复用）
  headers(token) {
    return token
      ? {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json",
          "X-Domain": WEB,
        }
      : noAuthHeaders();
  },

  // 方案 A：把 token 同步进 opencode credential 表（失败只告警，不抛错）。
  async syncCredentialSafe({ token, refresh, uid, label, makeActive }) {
    if (!token) return;
    const p = decodeJwtPayload(token);
    const label2 = label || ioaAccountLabel(token) || (p && p.preferred_username) || "default";
    const uid2 = uid || (p && p.sub) || "";
    const expires = p && p.exp ? Number(p.exp) * 1000 : Date.now() + 24 * 60 * 60 * 1000;
    try {
      await syncToOpencodeCredential({
        integrationId: "codebuddy",
        label: label2,
        access: token,
        refresh: refresh || "",
        expires,
        uid: uid2,
        makeActive,
      });
    } catch (e) {
      console.error(`[auth-login][codebuddy] credential 同步失败: ${e.message}`);
    }
  },

  // 活动执行器：全部为 2026-09-07 实测端点（勿猜改）。
  //   growth_claim / lottery_draw / claim_gift 见下方方法；其他 type 回退通用请求。
  async executeActivity(s, def) {
    // 活动定义账户级模板替换：def 里的 {username} → 当前账户 user.username
    const raw = def || {};
    def = {};
    for (const [k, v] of Object.entries(raw)) {
      def[k] = typeof v === "string" ? v.replace(/\{username\}/g, (s.user && s.user.username) || "") : v;
    }
    const type = String(def.type || "");
    if (type === "growth_claim" || type === "growth") return this.growthClaim(s);
    if (type === "lottery_draw" || type === "lottery") return this.lotteryDraw(s);
    if (type === "claim_gift" || type === "gift") return this.claimGift(s);
    // 通用 fallback
    const url = (def.baseUrl || API) + (def.path || "");
    const res = await fetch(url, {
      method: def.method || "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token), def.headers || {}),
      body: def.body ? JSON.stringify(def.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: parseBody(text) };
  },

  // 成长任务：完成未领（accept_status=="completed"）→ 逐个 claim。
  // 实测：13 claimed / 2 accepted / 1 in_progress（无 completed 时返回 0 可领）。
  async growthClaim(s) {
    const res = await fetchRetry(`${API}/v2/activity/growth/tasks`, { headers: this.headers(s.token) });
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (!res.ok || !j || j.code !== 0) {
      return { status: res.status, ok: false, message: `任务列表失败: ${text.slice(0, 200)}` };
    }
    const tasks = (j.data && j.data.tasks) || [];
    const claimable = tasks.filter((t) => t && t.task_code && String(t.accept_status) === "completed");
    if (!claimable.length) {
      const total = tasks.length;
      return {
        status: res.status,
        ok: true,
        message: `当前没有「已完成未领取」的成长任务（共 ${total} 个任务）`,
        claimed: [],
        total,
      };
    }
    const claimed = [];
    let okAll = true;
    for (const t of claimable) {
      try {
        const r = await fetchRetry(`${API}/activity/growth/tasks/${encodeURIComponent(t.task_code)}/claim`, {
          method: "POST",
          headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
          body: "{}",
        });
        const body = parseBody(await r.text());
        const codeOk = body && (body.code === 0 || body.code === undefined);
        claimed.push({
          task_code: t.task_code,
          title: t.title || "",
          reward_credit: t.reward_credit,
          status: r.status,
          ok: r.ok && codeOk,
          code: body && body.code,
          msg: (body && (body.msg || body.message)) || "",
        });
        if (!(r.ok && codeOk)) okAll = false;
      } catch (e) {
        claimed.push({ task_code: t.task_code, ok: false, error: e.message });
        okAll = false;
      }
    }
    return { status: res.status, ok: okAll, message: `领取 ${claimed.length} 个任务奖励`, claimed, total: tasks.length };
  },

  // 抽奖：有次数（chances.balance>0）→ draw。
  async lotteryDraw(s) {
    const res = await fetchRetry(`${API}/activity/growth/lottery/chances`, { headers: this.headers(s.token) });
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (!res.ok || !j || j.code !== 0) {
      return { status: res.status, ok: false, message: `抽奖次数查询失败: ${text.slice(0, 200)}` };
    }
    const balance = Number((j.data && (j.data.balance ?? j.data.chances)) || 0);
    if (balance < 1) {
      return { status: res.status, ok: true, message: "今日无抽奖次数", balance: 0 };
    }
    let drawJ = null;
    let status = 0;
    try {
      const d = await fetchRetry(`${API}/activity/growth/lottery/draw`, {
        method: "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, this.headers(s.token)),
        body: JSON.stringify({ client_token: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}` }),
      });
      status = d.status;
      drawJ = parseBody(await d.text());
    } catch (e) {
      return { status: 0, ok: false, message: `抽奖请求异常: ${e.message}` };
    }
    return {
      status,
      ok: !!(drawJ && drawJ.code === 0),
      message: drawJ ? (drawJ.msg || drawJ.message || JSON.stringify(drawJ)) : "无响应",
      draw: drawJ,
    };
  },

  // 新手礼包：POST claim-gift（www 域，Bearer+X-Domain+X-User-Id）；code:10001 = 已领过（幂等成功）。
  async claimGift(s) {
    const payload = decodeJwtPayload(s.token) || (s.user && s.user.payload) || {};
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.token}`,
      "X-Domain": WEB,
    };
    const uid = payload.sub;
    if (uid) headers["X-User-Id"] = String(uid);
    let res;
    try {
      res = await fetchRetry(`${WEB}/billing/meter/claim-gift`, {
        method: "POST",
        headers,
        body: "{}",
      });
    } catch (e) {
      return { status: 0, ok: false, message: `礼包请求异常: ${e.message}` };
    }
    const body = parseBody(await res.text());
    const code = body && body.code;
    const already = code === 10001;
    return {
      status: res.status,
      ok: res.ok && (code === 0 || already),
      message: already ? "新手礼包已领取过（幂等）" : body ? `${body.msg || "ok"}` : "无响应",
      code,
      body,
    };
  },
};