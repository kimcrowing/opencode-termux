// core.mjs — 通用扫码登录（QR scan-login）适配器框架（账号池版）。
//
// 与具体网站解耦：每个网站只需要提供一个"provider 适配器"，描述：
//   - loginUrl():    用于生成二维码的登录 URL（二维码内容，用户扫码后打开）
//   - generateQr():  返回可直接扫码的二维码内容（默认就用 loginUrl()，某些网站有单独的二维码生成接口/短链）
//   - pollStatus():  后台轮询扫码/确认结果 → 返回 { state, token?, cookies?, headers?, user? }
//                    state: "pending" | "scanned" | "confirmed" | "expired" | "error"
//   - refresh?():    可选的 token 刷新（如 GitCode OAuth token 15 天过期可刷新）
//   - headers(token): 给定 token 生成鉴权请求头（用于任务/活动请求）
//
// 【账号池】每个站点可维护多个账户：
//   - 登录态以 JSON 文件持久化在 storage/<site>/accounts/<account>.json（每账户一文件），
//     参考 uyanip 的 session.json 模式。opencode 重启后仍可复用。
//   - 两种扫码场景（startLogin opts.mode）：
//       "add"（默认）→ 新增账户：临时槽 `_new_<ts>` 扫码，确认后以 user.username 落盘入池；
//       "update"      → 更新账户：opts.account 指定已有账户，重新扫码后覆盖其 token（续期）。
//   - 活动执行可指定单账户（runActivities opts.account）或遍历全部账户。
//   - 兼容迁移：旧版单文件 storage/<site>.json 自动迁移为 accounts/<username 或 default>.json。
//
// 本模块不依赖任何第三方包：只用 node:fs / node:path + 全局 fetch。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// 每个账户的运行状态（内存共享，key = `${siteId}::${accountId}`）。poll 定时器由 startPolling 管理。
const sessions = new Map();

export const SITE_STATE = {
  IDLE: "idle",
  WAITING: "waiting", // 已生成二维码，等待扫码
  SCANNED: "scanned", // 已扫码，等待确认
  CONFIRMED: "confirmed", // 已确认登录成功
  EXPIRED: "expired",
  ERROR: "error",
};

function storageDir(siteId) {
  const d = path.join(__dir, "storage", String(siteId));
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
  return d;
}

function accountsDir(siteId) {
  const d = path.join(storageDir(siteId), "accounts");
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {}
  return d;
}

function accountPath(siteId, accountId) {
  return path.join(accountsDir(siteId), `${String(accountId).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

function legacyPath(siteId) {
  return path.join(__dir, "storage", `${siteId}.json`);
}

// 迁移旧版单文件 storage/<site>.json → accounts/<username 或 default>.json（仅一次）。
function migrateLegacy(siteId) {
  const lp = legacyPath(siteId);
  if (!fs.existsSync(lp)) return;
  try {
    const data = JSON.parse(fs.readFileSync(lp, "utf-8"));
    const name =
      (data && data.user && (data.user.username || data.user.name || data.user.nick_name || data.user.nickName)) ||
      "default";
    const ap = accountPath(siteId, name);
    if (!fs.existsSync(ap)) fs.writeFileSync(ap, JSON.stringify(data, null, 2), "utf-8");
    fs.unlinkSync(lp);
  } catch (e) {
    console.error(`[auth-login] migrate legacy session ${siteId} failed: ${e.message}`);
  }
}

// 列出站点下的全部账户 id（读 accounts/ 目录，仅 .json 文件，忽略 qr-*/ 等无关内容）。
export function accountIds(siteId) {
  migrateLegacy(siteId);
  try {
    const dir = accountsDir(siteId);
    const out = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_new_"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
    return out;
  } catch {
    return [];
  }
}

// 账号池摘要（不暴露 token）：[{ account, user, savedAt }]
export function listAccounts(siteId) {
  const ids = accountIds(siteId);
  return ids.map((id) => {
    const d = loadSession(siteId, id) || {};
    return {
      account: id,
      user: d.user || null,
      savedAt: d.savedAt || null,
      loggedIn: !!(d.token || (d.cookies && Object.keys(d.cookies).length)),
    };
  });
}

export function loadSession(siteId, accountId) {
  try {
    const p = accountPath(siteId, accountId || "_default");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function saveSession(siteId, accountId, data) {
  try {
    fs.writeFileSync(accountPath(siteId, accountId), JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    // 写失败不阻断登录流程，仅记录
    console.error(`[auth-login] save session ${siteId}/${accountId} failed: ${e.message}`);
  }
}

function sessionKey(siteId, accountId) {
  return `${String(siteId)}::${String(accountId || "_default")}`;
}

function dropSession(siteId, accountId) {
  sessions.delete(sessionKey(siteId, accountId));
  try {
    const p = accountPath(siteId, accountId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

function getSession(siteId, accountId) {
  // 未指定账户时取该站点唯一账户；多账户必须显式指定
  if (!accountId) {
    const ids = accountIds(siteId);
    accountId = ids.length === 1 ? ids[0] : ids[0] || "_default";
  }
  const key = sessionKey(siteId, accountId);
  if (!sessions.has(key)) {
    const saved = loadSession(siteId, accountId);
    sessions.set(key, {
      _accountId: accountId,
      state: saved?.token || saved?.cookies ? SITE_STATE.CONFIRMED : SITE_STATE.IDLE,
      token: saved?.token ?? null,
      cookies: saved?.cookies ?? null,
      headers: saved?.headers ?? (saved?.token ? { Authorization: `Bearer ${saved.token}` } : null),
      user: saved?.user ?? null,
      savedAt: saved?.savedAt ?? null,
      pollTimer: null,
      lastPollAt: 0,
      lastError: "",
      qrText: "",
      qrPath: "",
      pollCount: 0,
    });
  }
  return sessions.get(key);
}

// 供外部（如手动注入 token 后）把内存会话 state 持久化到磁盘。
// 兼容旧签名 persistSession(siteId, session)；新签名 persistSession(siteId, accountId, session)。
export function persistSession(siteId, accountId, s) {
  if (accountId && typeof accountId === "object") {
    // 旧调用：第二个参数是 session 对象本身
    s = accountId;
    accountId = s._accountId || "_default";
  }
  saveSession(siteId, accountId || s?._accountId || "_default", {
    token: s.token,
    cookies: s.cookies,
    headers: s.headers,
    user: s.user,
    savedAt: s.savedAt,
  });
}

/**
 * 通用扫码登录流程。并发安全：同一站点同一账户重复调用会复用一个进行中的流程。
 * @param {object} site  站点适配器（见本文头部注释）
 * @param {object} opts  { mode?: "add"|"update", account?: string, wait?: boolean, timeoutSec?: number }
 *                        mode=add（默认）新增账户；mode=update 重新扫码覆盖指定账户 token
 * @returns {Promise<object>} 状态摘要 + （可选）二维码内容/文件路径
 */
export async function startLogin(site, opts = {}) {
  const mode = String(opts.mode || "add");
  const reqAccount = opts.account ? String(opts.account) : "";
  // add：显式 account 用其名，否则临时槽（确认后以 user.username 迁移入池）
  // update：强制按指定 account 重新扫码（即使当前已登录也重新出码）
  const accountId =
    mode === "update"
      ? reqAccount
        ? reqAccount
        : "_default"
      : reqAccount
        ? reqAccount
        : `_new_${Date.now()}`;
  const s = getSession(site.id, accountId);
  s._accountId = accountId;
  s._isNew = mode !== "update"; // add 模式确认后需按 user.username 落盘

  // 已登录（未过期）直接返回（仅 add 模式；update 必须重新扫码）
  if (mode === "add" && s.state === SITE_STATE.CONFIRMED && s.token) {
    return summarize(site, s, true);
  }

  // 获得二维码内容
  let qrText;
  try {
    qrText = site.generateQr ? await site.generateQr(s) : await site.loginUrl(s);
  } catch (e) {
    s.state = SITE_STATE.ERROR;
    s.lastError = `生成二维码失败: ${e.message}`;
    return summarize(site, s, false);
  }
  s.qrText = typeof qrText === "string" ? qrText : "(provider 直供图片二维码)";

  // 渲染 PNG + ASCII，落盘到 storage/<site>/qr-<ts>.png
  const { renderQrToFile } = await import("./provider-qr.mjs");
  let qrPath = "";
  let qrAscii = "";
  try {
    if (qrText && typeof qrText === "object") {
      // 站点适配器直接提供二维码图片（如微信小程序码，本地无法重编码）：
      //   { base64: "iVBOR..." }  → 落盘 PNG
      //   { path: "/abs/qr.png" } → 直接引用文件
      const dir = storageDir(String(site.id));
      if (qrText.base64) {
        const buf = Buffer.from(String(qrText.base64).replace(/^data:image\/png;base64,/, ""), "base64");
        qrPath = path.join(dir, `qr-${Date.now()}.png`);
        fs.writeFileSync(qrPath, buf);
      } else if (qrText.path) {
        qrPath = String(qrText.path);
      }
      qrAscii =
        typeof qrText.ascii === "string"
          ? qrText.ascii
          : `[${site.id}] 扫码登录二维码已生成（图片路径：${qrPath}）`;
    } else {
      const out = await renderQrToFile(site.id, qrText);
      qrPath = out.path;
      qrAscii = out.ascii;
    }
  } catch (e) {
    s.lastError = `二维码渲染失败: ${e.message}`;
  }
  s.qrPath = qrPath;
  s.state = SITE_STATE.WAITING;

  startPolling(site, s);
  return { ...summarize(site, s, false), qrPath, qrAscii, qrText };
}

function summarize(site, s, loggedIn) {
  return {
    site: site.id,
    account: s._accountId || "_default",
    state: s.state,
    loggedIn: !!loggedIn || !!s.token,
    token: s.token,
    user: s.user,
    savedAt: s.savedAt,
    qrPath: s.qrPath,
    lastError: s.lastError,
  };
}

function startPolling(site, s) {
  if (s.pollTimer) return; // 已有定时器
  const intervalMs = site.pollIntervalMs || 2000;
  const poll = async () => {
    if (s.state === SITE_STATE.CONFIRMED || s.state === SITE_STATE.EXPIRED) {
      stopPolling(s);
      return;
    }
    try {
      const r = await site.pollStatus(s);
      s.lastPollAt = Date.now();
      s.pollCount++;
      if (r.state === SITE_STATE.CONFIRMED) {
        s.token = r.token ?? s.token;
        s.cookies = r.cookies ?? s.cookies;
        s.headers = r.headers ?? s.headers;
        s.user = r.user ?? s.user;
        s.savedAt = Date.now();
        s.state = SITE_STATE.CONFIRMED;
        // 确定最终账户 id：add 模式且已拿到用户名 → 迁移入池；否则保持当前槽位
        const uname = s.user && (s.user.username || s.user.name || s.user.nick_name || s.user.nickName);
        if (s._isNew && uname) {
          const tmpId = s._accountId;
          s._accountId = String(uname);
          sessions.delete(sessionKey(site.id, tmpId));
          sessions.set(sessionKey(site.id, s._accountId), s);
        }
        saveSession(site.id, s._accountId, {
          token: s.token,
          cookies: s.cookies,
          headers: s.headers,
          user: s.user,
          savedAt: s.savedAt,
        });
        stopPolling(s);
      } else if (r.state === SITE_STATE.SCANNED) {
        s.state = SITE_STATE.SCANNED;
      } else if (r.state === SITE_STATE.EXPIRED) {
        s.state = SITE_STATE.EXPIRED;
        s.lastError = "二维码已过期";
        stopPolling(s);
      } else if (r.state === SITE_STATE.ERROR) {
        s.lastError = r.message || "轮询出错";
      }
    } catch (e) {
      s.lastError = `轮询异常: ${e.message}`;
    }
  };
  s.pollTimer = setInterval(poll, intervalMs);
  poll(); // 立即先轮询一次
}

function stopPolling(s) {
  if (s.pollTimer) {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
  }
}

/** 站点状态：不传 account 返回账号池全部账户摘要；传了只返回该账户。 */
export function getStatus(site, accountId) {
  if (!accountId) {
    const ids = accountIds(site.id);
    return { site: site.id, accounts: ids.map((id) => summarize(site, getSession(site.id, id), getSession(site.id, id).state === SITE_STATE.CONFIRMED)) };
  }
  const s = getSession(site.id, accountId);
  return summarize(site, s, s.state === SITE_STATE.CONFIRMED);
}

export async function forceRefresh(site, accountId, opts = {}) {
  const s = getSession(site.id, accountId);
  if (!s.token && !s.cookies) {
    return { site: site.id, account: s._accountId, ok: false, message: "尚未登录，无 token 可刷新" };
  }
  if (!site.refresh) {
    return { site: site.id, account: s._accountId, ok: false, message: "该站点适配器未实现 refresh()" };
  }
  try {
    const r = await site.refresh(s, opts);
    if (r.token || r.cookies) {
      s.token = r.token ?? s.token;
      s.cookies = r.cookies ?? s.cookies;
      s.headers = r.headers ?? r.headers;
      s.user = r.user ?? r.user;
      s.savedAt = Date.now();
      s.state = SITE_STATE.CONFIRMED;
      saveSession(site.id, s._accountId, {
        token: s.token,
        cookies: s.cookies,
        headers: s.headers,
        user: s.user,
        savedAt: s.savedAt,
      });
      return { site: site.id, account: s._accountId, ok: true, loggedIn: true, token: s.token };
    }
    return { site: site.id, account: s._accountId, ok: false, message: r.message || "刷新失败" };
  } catch (e) {
    return { site: site.id, account: s._accountId, ok: false, message: `刷新异常: ${e.message}` };
  }
}

/** 登出：有 accountId 只清该账户，否则清空全站账户池。 */
export async function logout(site, accountId) {
  const ids = accountId ? [String(accountId)] : accountIds(site.id);
  let removed = 0;
  for (const id of ids) {
    const s = getSession(site.id, id);
    stopPolling(s);
    dropSession(site.id, id);
    removed++;
  }
  return { site: site.id, ok: true, loggedIn: false, removed, accounts: accountId ? void 0 : accountIds(site.id) };
}

/**
 * 执行站点配置的活动列表（自动签到/领积分等）。可指定单账户，缺省全部账户。
 * @param {object} site 站点适配器
 * @param {Array}  activityDefs 活动定义数组（来自配置）
 * @param {object} opts { account?: string }
 * @returns {Promise<object>} { site, accounts: [{account, results}], results? 平铺（兼容旧调用） }
 */
export async function runActivities(site, activityDefs = [], opts = {}) {
  const targets = opts.account ? [String(opts.account)] : accountIds(site.id);
  if (targets.length === 0) {
    return { site: site.id, accounts: [], results: [], message: "该站点账号池为空，先扫码添加账户" };
  }
  const accounts = [];
  const flat = [];
  for (const acct of targets) {
    const s = getSession(site.id, acct);
    const results = [];
    for (const def of activityDefs || []) {
      const item = { name: def.name, id: def.id || def.name, ok: false, message: "" };
      try {
        if (!s.token && !s.cookies) throw new Error("未登录，无法执行活动");
        const call = site.executeActivity ? () => site.executeActivity(s, def) : () => genericActivityCall(s, def);
        const r = await Promise.race([
          Promise.resolve().then(call),
          new Promise((_, rej) => setTimeout(() => rej(new Error("活动执行超时（20s）")), 20000)),
        ]);
        item.ok = !!r;
        item.data = r;
        item.message = r?.message || (r ? "ok" : "无响应");
      } catch (e) {
        item.message = e.message;
      }
      results.push(item);
    }
    accounts.push({ account: acct, user: s.user, results });
    flat.push(...results.map((it) => ({ account: acct, ...it })));
  }
  return { site: site.id, accounts, results: flat };
}

// 通用活动请求：按其定义的 method/path/headers/body 发一条鉴权请求。
async function genericActivityCall(s, def) {
  const headers = Object.assign({}, s.headers || {});
  if (s.token) headers["Authorization"] = `Bearer ${s.token}`;
  for (const [k, v] of Object.entries(def.headers || {})) headers[k] = v;
  const res = await fetch(`${def.baseUrl || ""}${def.path}`, {
    method: def.method || "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers),
    body: def.body ? JSON.stringify(def.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => "");
  }
  return { status: res.status, body };
}

export { getSession };